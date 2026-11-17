#!/bin/sh
# Agents that run on this server, beside the community: they answer while their
# owner's computer is off, and they appear in the owner's app as their own
# agents, running remotely. agents.mjs copies this folder to the server and
# runs it there; the app reaches it through `bridge`.
#
#   agents.sh install     build what the agents run on. Safe to run again.
#   agents.sh sign-in     sign Codex in with the owner's ChatGPT account: prints
#                         a web address and a one-time code. Every agent here
#                         shares this one sign-in.
#   agents.sh status      whether it is installed and signed in, and each agent
#   agents.sh logs [id]   recent activity of every agent, or of one
#   agents.sh bridge      one request from the app, as JSON on standard input
#   agents.sh uninstall   remove everything here, once no agent is left
#
# Agents are created, renamed, instructed and removed from the app, not here.
set -eu
umask 077
cd "$(dirname "$0")"

die() {
	echo "$*" >&2
	exit 1
}

[ -f .env ] || die "This server has no community yet. Set one up first."
image=workrooms-helper:local
codex_home=workrooms-codex:/home/helper/.codex
built() {
	docker image inspect "$image" >/dev/null 2>&1
}
ready() {
	built && command -v node >/dev/null 2>&1 && [ -d agents/state ] ||
		die "The server's agents are not installed yet. Run: agents.sh install"
}
# Asks Codex itself, and records the answer where the bridge reads it.
signed_in() {
	if docker run --rm -v "$codex_home" --entrypoint codex "$image" login status >/dev/null 2>&1; then
		[ ! -d agents/state ] || : >agents/state/signed-in
		return 0
	fi
	rm -f agents/state/signed-in
	return 1
}
agents() {
	docker ps -a --filter label=workrooms.agent --format "$1"
}

case "${1:-}" in
install)
	if ! command -v node >/dev/null 2>&1; then
		echo "Installing Node…"
		DEBIAN_FRONTEND=noninteractive apt-get update -q >/dev/null
		DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends nodejs >/dev/null
	fi
	mkdir -p agents/state
	chmod 700 agents agents/state
	echo "Building what the agents run on. The first time this takes ten to twenty minutes."
	# No build context: the Dockerfile copies nothing from this folder, which
	# holds the agents' keys.
	docker build -t "$image" - <agents/Dockerfile
	echo "installed"
	if signed_in; then echo "signed-in=yes"; else echo "Next: agents.sh sign-in"; fi
	;;
sign-in)
	ready
	echo "Codex will print a web address and a one-time code. The owner opens the address on their own computer, signs in to ChatGPT and enters the code."
	docker run --rm -v "$codex_home" --entrypoint codex "$image" login --device-auth
	signed_in || die "Codex did not report a sign-in. Run the same command again."
	# Agents made before a sign-in ran out pick the new one up on a restart.
	for name in $(agents '{{.Names}}'); do docker restart "$name" >/dev/null; done
	echo "signed-in=yes"
	;;
status)
	ready
	if signed_in; then echo "signed-in=yes"; else echo "signed-in=no"; fi
	echo "agents=$(agents '{{.Names}}' | wc -l | tr -d ' ')"
	agents '{{.Label "workrooms.agent"}} {{.State}} ({{.Status}})'
	;;
logs)
	ready
	for name in $(agents '{{.Names}}'); do
		case "$name" in *"${2:-}"*) ;; *) continue ;; esac
		echo "== $name"
		# Keys never appear in an agent's log; this is a second guard.
		docker logs --tail 40 "$name" 2>&1 | sed -E 's/[0-9a-f]{64}/…/g'
	done
	;;
bridge)
	ready
	exec node agents/bridge.mjs
	;;
uninstall)
	[ -z "$(agents '{{.Names}}')" ] ||
		die "Agents still run here. Delete each one in the app first, then run this again."
	docker volume rm workrooms-codex >/dev/null 2>&1 || true
	docker image rm "$image" >/dev/null 2>&1 || true
	rm -rf agents/state
	echo "uninstalled"
	;;
*)
	die "Usage: agents.sh install | sign-in | status | logs [id] | bridge | uninstall"
	;;
esac
