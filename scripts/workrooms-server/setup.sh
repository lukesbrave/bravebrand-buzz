#!/bin/sh
# Starts or resumes a Workrooms community on this server. install.mjs copies
# this folder to the server and runs it there.
#
#   setup.sh <hostname>                      install Docker and fetch the images
#   setup.sh <hostname> <owner-public-key>   also create and start the community
#
# The owner key is the 64-character hex public key from the owner's app. The
# owner's private key never comes to this server.
set -eu
umask 077
cd "$(dirname "$0")"

die() {
	echo "$*" >&2
	exit 1
}

host=${1:-}
owner=${2:-}
echo "$host" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' ||
	die "Supply the community hostname, such as team.example.com."
[ ${#host} -le 253 ] || die "That hostname is too long."
if [ -n "$owner" ]; then
	echo "$owner" | grep -Eq '^[0-9a-f]{64}$' ||
		die "Supply the owner's public key as 64 hex characters."
fi

if ! command -v docker >/dev/null 2>&1; then
	echo "Installing Docker…"
	curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 ||
	die "Docker is installed without the Compose plugin. Install docker-compose-plugin and run this again."

image="ghcr.io/block/buzz@sha256:690016ca465e439e2c58213fdfe8a094073ddbe80de75baec74b0a39de54ab38"
# Some registries serve a release by tag but reject a cold digest lookup.
# Cache the tagged images. Compose below still selects the reviewed digests.
for tag in ghcr.io/block/buzz:sha-2c5c834 caddy:2-alpine \
	postgres:17-alpine@sha256:d3244e8ce3f165ee3c93d9c4a4b1d0fe48b3a89e2287b717fdcbbde92d405065 \
	redis:7-alpine@sha256:7f7d30b7fdd09467bac58198a1f166dd69789d348d4fe859cccb20e0cf287fbe \
	pgsty/mc:RELEASE.2026-09-16T00-00-00Z pgsty/silo:RELEASE.2026-09-16T00-00-00Z; do
	docker image inspect "$tag" >/dev/null 2>&1 || docker pull "$tag"
done

if [ -z "$owner" ]; then
	echo "prepared"
	exit 0
fi

random() {
	od -An -N "$1" -tx1 /dev/urandom | tr -d ' \n'
}
if [ ! -f .env ]; then
	new=$(mktemp .env.XXXXXX)
	cat >"$new" <<SETTINGS
BUZZ_DOMAIN=$host
RELAY_URL=wss://$host
BUZZ_MEDIA_BASE_URL=https://$host/media
BUZZ_MEDIA_SERVER_DOMAIN=$host
BUZZ_CORS_ORIGINS=https://$host
BUZZ_REQUIRE_AUTH_TOKEN=true
BUZZ_REQUIRE_RELAY_MEMBERSHIP=true
BUZZ_ALLOW_NIP_OA_AUTH=true
BUZZ_AUTO_MIGRATE=true
BUZZ_PUSH_ENABLED=false
BUZZ_IMAGE=$image
RELAY_OWNER_PUBKEY=$owner
BUZZ_RELAY_PRIVATE_KEY=$(random 32)
BUZZ_GIT_HOOK_HMAC_SECRET=$(random 32)
POSTGRES_PASSWORD=$(random 24)
REDIS_PASSWORD=$(random 24)
BUZZ_S3_ACCESS_KEY=$(random 12)
BUZZ_S3_SECRET_KEY=$(random 24)
BUZZ_S3_BUCKET=buzz-media
SETTINGS
	mv "$new" .env
fi
saved() {
	sed -n "s/^$1=//p" .env
}
[ "$(saved BUZZ_DOMAIN)" = "$host" ] ||
	die "This server already hosts a community at $(saved BUZZ_DOMAIN)."
[ "$(saved RELAY_OWNER_PUBKEY)" = "$owner" ] ||
	die "This server's community already has a different owner key. Nothing was changed."

WORKROOMS_ENV=$PWD/.env
export WORKROOMS_ENV
docker compose -p "${WORKROOMS_PROJECT:-workrooms}" --env-file .env \
	-f compose.yml -f compose.vps.yml up -d --wait

relay=$(curl --fail --silent --show-error --max-time 10 \
	-H "Host: $host" -H "Accept: application/nostr+json" \
	"http://127.0.0.1:${WORKROOMS_LOCAL_PORT:-18479}/" |
	sed -n 's/.*"self"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{64\}\)".*/\1/p')
[ -n "$relay" ] || die "The relay started but did not report its identity."
echo "relay=$relay"
