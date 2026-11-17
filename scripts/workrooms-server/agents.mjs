// Prepares a server that already hosts a Workrooms community to run agents of
// its own, from the owner's computer, over SSH:
//
//   bin/node scripts/workrooms-server/agents.mjs root@workrooms install
//     builds what the agents run on. The first build takes ten to twenty
//     minutes.
//
//   bin/node scripts/workrooms-server/agents.mjs root@workrooms sign-in
//     prints a web address and a one-time code. The owner opens the address,
//     signs in to their ChatGPT account and enters the code.
//
//   … status | logs [agent] | uninstall
//
// After that the owner creates agents in the app, choosing the harness
// "My server · Codex": the app reaches the server through the same SSH login.
// Such an agent runs on the server, so it answers while this computer is off,
// and it answers only the community's owner. Its key is made on the server
// and stays there; the owner's key is never sent. Nothing secret is printed.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const [target, command, extra, ...rest] = process.argv.slice(2);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const COMMANDS = ["install", "sign-in", "status", "logs", "uninstall"];
if (
  !target ||
  !/^[A-Za-z0-9._-]+@[A-Za-z0-9.:-]+$/.test(target) ||
  !COMMANDS.includes(command) ||
  rest.length ||
  (extra && (command !== "logs" || !/^[0-9a-f]{4,64}$/.test(extra)))
)
  fail(
    "Usage: agents.mjs <user@server> install | sign-in | status | logs [agent id] | uninstall",
  );

const ssh = ["-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes"];
/** Runs on the server with its output shown as it comes. */
function remote(script) {
  const result = spawnSync("ssh", [...ssh, target, script], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (result.error) fail(result.error.message);
  return result.status === 0;
}

if (
  !remote(
    "[ -f /opt/workrooms/.env ] || { echo 'This server has no Workrooms community yet. Set one up or move one here first.' >&2; exit 1; }",
  )
)
  process.exit(1);

if (command === "install") {
  const here = (path) => fileURLToPath(new URL(path, import.meta.url));
  if (!remote("mkdir -p /opt/workrooms/agents && chmod 700 /opt/workrooms"))
    fail("Could not prepare the server.");
  for (const [files, into] of [
    [[here("./agents.sh")], "/opt/workrooms/"],
    [
      [here("./agents/Dockerfile"), here("./agents/bridge.mjs")],
      "/opt/workrooms/agents/",
    ],
  ]) {
    const copied = spawnSync(
      "scp",
      [...ssh, "-q", ...files, `${target}:${into}`],
      { stdio: "inherit" },
    );
    if (copied.status !== 0) fail("Could not copy the files to the server.");
  }
}

if (
  !remote(`sh /opt/workrooms/agents.sh ${command}${extra ? ` ${extra}` : ""}`)
)
  fail(
    "That did not finish. Fix what the server reported, then run the same command again.",
  );
