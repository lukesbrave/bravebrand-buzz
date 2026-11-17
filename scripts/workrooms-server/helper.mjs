// Sets up and looks after an always-on helper agent on a server that already
// hosts a Workrooms community, from the owner's computer, over SSH:
//
//   bin/node scripts/workrooms-server/helper.mjs root@workrooms install "Scout"
//     builds the helper on the server, gives it a key, admits it to the
//     community and names it. The first build takes ten to twenty minutes.
//
//   bin/node scripts/workrooms-server/helper.mjs root@workrooms sign-in
//     prints a web address and a one-time code. The owner opens the address,
//     signs in to their ChatGPT account and enters the code. Then it starts.
//
//   … start | stop | status | logs | remove
//
// The helper runs on the server, so it answers while this computer is off. It
// answers only the community's owner. Its key is made on the server and stays
// there; the owner's key is never sent. Nothing secret is printed.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const [target, command, ...rest] = process.argv.slice(2);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const COMMANDS = [
  "install",
  "sign-in",
  "start",
  "stop",
  "status",
  "logs",
  "remove",
];
const name = rest.join(" ").trim();
if (
  !target ||
  !/^[A-Za-z0-9._-]+@[A-Za-z0-9.:-]+$/.test(target) ||
  !COMMANDS.includes(command) ||
  (command === "install" &&
    name &&
    !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(name)) ||
  (command === "logs" && name && !/^\d{1,4}$/.test(name)) ||
  (!["install", "logs"].includes(command) && name)
)
  fail(
    'Usage: helper.mjs <user@server> install "<name>" | sign-in | start | stop | status | logs | remove. The name is letters, numbers, spaces, dots and dashes.',
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

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
if (command === "install") {
  // The helper's files, and the setup script that knows about it.
  if (!remote("mkdir -p /opt/workrooms/helper && chmod 700 /opt/workrooms"))
    fail("Could not prepare the server.");
  for (const [files, into] of [
    [
      [here("./compose.helper.yml"), here("./helper.sh"), here("./setup.sh")],
      "/opt/workrooms/",
    ],
    [[here("./helper/Dockerfile")], "/opt/workrooms/helper/"],
  ]) {
    const copied = spawnSync(
      "scp",
      [...ssh, "-q", ...files, `${target}:${into}`],
      { stdio: "inherit" },
    );
    if (copied.status !== 0)
      fail("Could not copy the helper's files to the server.");
  }
}

// The name was checked above, so it is safe inside single quotes.
const argument = name ? ` '${name}'` : "";
if (!remote(`sh /opt/workrooms/helper.sh ${command}${argument}`))
  fail(
    command === "install"
      ? "The helper was not installed. Fix what the server reported, then run the same command again."
      : "That did not finish. Fix what the server reported, then run the same command again.",
  );
