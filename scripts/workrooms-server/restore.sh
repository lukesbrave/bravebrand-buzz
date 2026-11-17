#!/bin/sh
# Brings a workspace from its owner's computer onto this server, from a backup
# made there by scripts/workrooms-solo/backup.mjs. move.mjs copies this folder
# and the backup to the server and runs it here.
#
#   restore.sh <hostname>
#
# The backup's four files are read from ./incoming and removed once the
# workspace is running. This refuses to run where a community already exists,
# so it can never overwrite one, and a run that does not finish removes what it
# started, so it can simply be run again.
#
# The workspace keeps its own key, owner, members and messages. Only its
# address changes, to https://<hostname>.
set -eu
umask 077
cd "$(dirname "$0")"

die() {
	echo "$*" >&2
	exit 1
}

host=${1:-}
echo "$host" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' ||
	die "Supply the community hostname, such as team.example.com."
[ ${#host} -le 253 ] || die "That hostname is too long."
for name in database.dump files.tar git.tar settings.env; do
	[ -f "incoming/$name" ] ||
		die "The backup is incomplete: incoming/$name is missing. Nothing was changed."
done
[ ! -f .env ] ||
	die "This server already hosts a community at $(sed -n 's/^BUZZ_DOMAIN=//p' .env). Nothing was changed."

# Installs Docker and fetches the images, as a new community's setup does.
sh ./setup.sh "$host" >/dev/null

project=${WORKROOMS_PROJECT:-workrooms}
[ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")" ] ||
	die "Docker still holds data named $project from an earlier community. Nothing was changed."

saved() {
	sed -n "s/^$1=//p" incoming/settings.env
}
old=$(saved BUZZ_DOMAIN)
# Both addresses go into one database statement below.
echo "$old" | grep -Eq '^[A-Za-z0-9.:-]+$' ||
	die "The backup's settings do not name the workspace's address. Nothing was changed."
[ -n "$(saved BUZZ_RELAY_PRIVATE_KEY)" ] && [ -n "$(saved RELAY_OWNER_PUBKEY)" ] ||
	die "The backup's settings are incomplete. Nothing was changed."
# One source for each pinned image: setup.sh and compose.yml.
image=$(sed -n 's/^image="\(.*\)"$/\1/p' setup.sh)
tools=$(sed -n 's/^ *image: \(postgres:.*\)$/\1/p' compose.yml)
[ -n "$image" ] && [ -n "$tools" ] || die "The server files are incomplete. Nothing was changed."

dc() {
	docker compose -p "$project" --env-file .env -f compose.yml -f compose.vps.yml "$@"
}
# Everything from here was made by this run, which the checks above
# established, so an unfinished run may remove it.
restored=
cleanup() {
	[ -z "$restored" ] || return 0
	[ ! -f .env ] || dc down -v >/dev/null 2>&1 || true
	rm -f .env
}
trap cleanup EXIT
trap 'exit 1' INT TERM

# The workspace's own keys and passwords come with it. Its address is this
# server's, and the software is the version this kit pins.
new=$(mktemp .env.XXXXXX)
grep -Ev '^(BUZZ_DOMAIN|RELAY_URL|BUZZ_MEDIA_BASE_URL|BUZZ_MEDIA_SERVER_DOMAIN|BUZZ_CORS_ORIGINS|WORKROOMS_PORT|BUZZ_IMAGE)=' \
	incoming/settings.env >"$new"
cat >>"$new" <<SETTINGS
BUZZ_DOMAIN=$host
RELAY_URL=wss://$host
BUZZ_MEDIA_BASE_URL=https://$host/media
BUZZ_MEDIA_SERVER_DOMAIN=$host
BUZZ_CORS_ORIGINS=https://$host
BUZZ_IMAGE=$image
SETTINGS
mv "$new" .env

WORKROOMS_ENV=$PWD/.env
export WORKROOMS_ENV

unpack() {
	docker run --rm -i --network none --volumes-from "$(dc ps -aq "$2")" \
		"$tools" tar -C "$3" -xf - <"incoming/$1"
}
# Fill the empty volumes before anything that reads them starts.
dc create
unpack files.tar minio /data
unpack git.tar relay /data/git
dc up -d --wait postgres
dc exec -T postgres sh -c \
	'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' \
	<incoming/database.dump
# The address is part of the workspace's records. Started at a new address
# without this, the relay would make a second, empty community.
moved=$(dc exec -T postgres sh -c \
	'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -At -c "$0"' \
	"UPDATE communities SET host = '$host' WHERE host = '$old' RETURNING id")
echo "$moved" | grep -Eq '^[0-9a-f-]{36}$' ||
	die "The backup's records do not match its settings. The workspace was not moved."
dc up -d --wait

relay=$(curl --fail --silent --show-error --max-time 10 \
	-H "Host: $host" -H "Accept: application/nostr+json" \
	"http://127.0.0.1:${WORKROOMS_LOCAL_PORT:-18479}/" |
	sed -n 's/.*"self"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{64\}\)".*/\1/p')
[ -n "$relay" ] || die "The relay started but did not report its identity."
restored=1
rm -rf incoming
echo "relay=$relay"
