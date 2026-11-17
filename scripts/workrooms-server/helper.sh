#!/bin/sh
# An always-on helper agent for the community on this server: it runs here, so
# it answers while its owner's computer is off. helper.mjs copies this folder
# to the server and runs it there.
#
#   helper.sh install "<name>"   build it, give it a key, admit it to the
#                                community and name it. Safe to run again.
#   helper.sh sign-in            sign Codex in with its owner's ChatGPT account:
#                                prints a web address and a one-time code
#   helper.sh start | stop       start or stop it
#   helper.sh status             whether it is signed in and running
#   helper.sh logs               its recent activity
#   helper.sh remove             stop it and remove it from the community
#
# The helper answers only its owner, the community's owner key. Its own key is
# made here and never leaves this server. Its owner's key never comes here.
set -eu
umask 077
cd "$(dirname "$0")"

die() {
	echo "$*" >&2
	exit 1
}

[ -f .env ] || die "This server has no community yet. Set one up first, then add the helper."
saved() {
	sed -n "s/^$1=//p" .env
}
host=$(saved BUZZ_DOMAIN)
owner=$(saved RELAY_OWNER_PUBKEY)
[ -n "$host" ] && [ -n "$owner" ] || die "The community's settings are incomplete."

WORKROOMS_ENV=$PWD/.env
export WORKROOMS_ENV
project=${WORKROOMS_PROJECT:-workrooms}
dc() {
	docker compose -p "$project" --env-file .env \
		-f compose.yml -f compose.vps.yml -f compose.helper.yml "$@"
}
# One-off commands in the helper's image, with its key and its home.
tool() {
	dc run --rm --no-deps -T --entrypoint "$1" helper $2
}
installed() {
	[ -f helper.env ] || die "The helper is not installed yet. Run: helper.sh install \"<name>\""
}
pubkey() {
	sed -n 's/^HELPER_PUBKEY=//p' helper.env
}

case "${1:-}" in
install)
	name=${2:-Helper}
	echo "$name" | grep -Eq "^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$" ||
		die "Give the helper a short name: letters, numbers, spaces, dots, dashes."
	# helper.env must exist before Compose reads the service at all.
	[ -f helper.env ] || : >helper.env
	echo "Building the helper. The first time this takes ten to twenty minutes."
	dc build helper
	if ! grep -q '^BUZZ_PRIVATE_KEY=' helper.env; then
		# A new key, made inside the helper's image; only its public half is shown.
		keys=$(dc run --rm --no-deps -T --entrypoint node helper -e '
			const { createECDH } = require("node:crypto");
			const pair = createECDH("secp256k1");
			pair.generateKeys();
			console.log(pair.getPrivateKey("hex").padStart(64, "0"), pair.getPublicKey("hex", "compressed").slice(2));
		')
		secret=${keys% *}
		public=${keys#* }
		echo "$secret$public" | grep -Eq '^[0-9a-f]{128}$' || die "Could not make the helper's key."
		new=$(mktemp helper.env.XXXXXX)
		cat >"$new" <<SETTINGS
BUZZ_PRIVATE_KEY=$secret
HELPER_PUBKEY=$public
BUZZ_ACP_AGENT_OWNER=$owner
BUZZ_ACP_AGENT_COMMAND=codex-acp
BUZZ_ACP_AGENT_ARGS=
BUZZ_ACP_RESPOND_TO=owner-only
BUZZ_ACP_AGENTS=1
BUZZ_ACP_LAZY_POOL=true
BUZZ_ACP_SYSTEM_PROMPT_FILE=/home/helper/instructions.md
RUST_LOG=buzz_acp=info
SETTINGS
		mv "$new" helper.env
	fi
	public=$(pubkey)
	[ "$(sed -n 's/^BUZZ_ACP_AGENT_OWNER=//p' helper.env)" = "$owner" ] ||
		die "This helper belongs to a different owner key. Nothing was changed."

	# Its instructions, kept in its own home so its owner can change them.
	dc run --rm --no-deps -T --entrypoint sh helper -c '
		[ -f /home/helper/instructions.md ] || cat >/home/helper/instructions.md
	' <<INSTRUCTIONS
You are $name, an always-on helper in your owner's private workspace. You run
on their server, not on their computer, so you cannot see files on their
computer and you say so when asked for one. Answer only your owner. Keep
replies short and plain. Deliver every answer with Buzz's reply tool in the
conversation you were asked in: a model response alone is not delivered.
Do not install software, change this server, spend money or publish anything
outside this workspace.
INSTRUCTIONS

	# Admit it to the community, as the relay's own admin tool does.
	dc exec -T relay buzz-admin add-member --pubkey "$public" >/dev/null ||
		die "The community did not admit the helper. Its owner can admit it by hand in the app: Settings → Membership, with this public key: $public"
	dc run --rm --no-deps -T -e "BUZZ_RELAY_URL=https://$host" --entrypoint buzz helper \
		users set-profile --name "$name" \
		--about "Always-on helper. Runs on this workspace's server and answers its owner." >/dev/null ||
		echo "The helper is admitted, but its name could not be set yet. Run install again once it is signed in." >&2
	echo "helper=$public"
	echo "Installed. Next: helper.sh sign-in"
	;;
sign-in)
	installed
	echo "Codex will print a web address and a one-time code. Its owner opens the address on their own computer, signs in to ChatGPT and enters the code."
	dc run --rm --no-deps -T --entrypoint codex helper login --device-auth
	tool codex "login status"
	dc up -d helper
	echo "Signed in and started."
	;;
start)
	installed
	tool codex "login status" >/dev/null 2>&1 || die "The helper is not signed in yet. Run: helper.sh sign-in"
	dc up -d helper
	echo "started"
	;;
stop)
	installed
	dc stop helper
	echo "stopped"
	;;
status)
	installed
	echo "helper=$(pubkey)"
	if tool codex "login status" >/dev/null 2>&1; then echo "signed-in=yes"; else echo "signed-in=no"; fi
	echo "state=$(dc ps --format '{{.State}}' helper 2>/dev/null | head -1)"
	;;
logs)
	installed
	# Keys never appear in its log; this is a second guard.
	dc logs --no-log-prefix --tail "${2:-60}" helper 2>&1 |
		sed -E 's/[0-9a-f]{64}/…/g'
	;;
remove)
	installed
	public=$(pubkey)
	dc rm -sf helper >/dev/null 2>&1 || true
	dc exec -T relay buzz-admin remove-member --pubkey "$public" >/dev/null 2>&1 || true
	docker volume rm "${project}_workrooms-helper-home" >/dev/null 2>&1 || true
	rm -f helper.env
	echo "removed"
	;;
*)
	die "Usage: helper.sh install \"<name>\" | sign-in | start | stop | status | logs | remove"
	;;
esac
