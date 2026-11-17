// Moves a workspace from its owner's computer onto a server they run, over
// SSH, from a backup made here by scripts/workrooms-solo/backup.mjs:
//
//   bin/node scripts/workrooms-server/move.mjs root@203.0.113.7 team.example.com "<backup folder>"
//
// Prepare the server first with install.mjs and no key, which installs Docker
// there and prints the DNS record to create. The server must not hold a
// community yet: this never overwrites one, and a move that does not finish
// removes what it started on the server, so the same command can be run again.
//
// The workspace keeps its own key, owner, members, channels and messages. Its
// address becomes https://<hostname>. The copy on this computer is not
// changed. No private key is read into the conversation or printed.
import { spawnSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeNpub, publicKey } from "../workrooms-solo/common.mjs";
import { publicProblem } from "./checks.mjs";

const [target, rawHost, folder] = process.argv.slice(2);
const host = rawHost?.toLowerCase();
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const PARTS = ["database.dump", "files.tar", "git.tar", "settings.env"];
if (
  !target ||
  !/^[A-Za-z0-9._-]+@[A-Za-z0-9.:-]+$/.test(target) ||
  !host ||
  host.length > 253 ||
  !host.includes(".") ||
  !host
    .split(".")
    .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
  !folder
)
  fail(
    'Usage: move.mjs <user@server> <hostname> "<backup folder>", for example root@203.0.113.7 team.example.com "~/Documents/Workrooms Backups/Workrooms backup 2026-11-14 0930"',
  );
if (!PARTS.every((name) => existsSync(join(folder, name))))
  fail(
    "That is not a backup folder made by backup.mjs: it must hold database.dump, files.tar, git.tar and settings.env. An encrypted backup cannot be moved directly; make a plain one with backup.mjs first.",
  );

// Read here only to know the workspace's public identity and owner, which are
// checked against what the server reports. Nothing from it is printed.
const saved = Object.fromEntries(
  readFileSync(join(folder, "settings.env"), "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    }),
);
if (!saved.BUZZ_RELAY_PRIVATE_KEY || !saved.RELAY_OWNER_PUBKEY)
  fail("The backup's settings are incomplete. Nothing was changed.");
const identity = publicKey(saved.BUZZ_RELAY_PRIVATE_KEY);

const ssh = ["-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes"];
/** Runs on the server; its stderr and progress are shown, its stdout returned. */
function remote(command, problem) {
  const result = spawnSync("ssh", [...ssh, target, command], {
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
  });
  if (result.error) fail(result.error.message);
  if (result.status !== 0)
    fail(
      problem ??
        "The server step did not finish. Fix what it reported, then run the same command again.",
    );
  return result.stdout;
}
function copy(files, into) {
  const copied = spawnSync(
    "scp",
    [...ssh, "-q", ...files, `${target}:${into}`],
    {
      stdio: "inherit",
    },
  );
  if (copied.status !== 0) fail("Could not copy the files to the server.");
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// The certificate can only be issued once the name reaches this server, and
// the app resolves the name as this computer does.
const address = remote(
  "ip -4 -o route get 1.1.1.1 | sed -n 's/.* src \\([0-9.]*\\).*/\\1/p'",
).trim();
if (!/^\d+\.\d+\.\d+\.\d+$/.test(address))
  fail("Could not read the server's public IPv4 address.");
let announced = false;
for (let waited = 0; ; waited += 10) {
  const seen = await lookup(host, { family: 4 }).then(
    (answer) => answer.address,
    () => undefined,
  );
  if (seen === address) break;
  if (!announced) {
    console.log(
      `Waiting for DNS. ${host} must have an A record pointing to ${address}` +
        (seen ? ` (this computer currently sees ${seen}).` : ".") +
        " In Cloudflare set it to DNS only.",
    );
    announced = true;
  }
  if (waited >= 600)
    fail(
      `${host} still does not resolve to ${address} on this computer. Check the DNS record, then run the same command again. Nothing was changed on the server.`,
    );
  await sleep(10_000);
}
console.log(`DNS ready: ${host} → ${address}`);

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const existing = remote(
  "[ -f /opt/workrooms/.env ] && sed -n 's/^BUZZ_DOMAIN=//p' /opt/workrooms/.env || true",
).trim();
let relay;
if (existing) {
  // A rerun after the move itself finished, such as while the certificate was
  // still being issued: only the checks are left.
  relay = remote(
    `curl --fail --silent --max-time 10 -H "Host: ${host}" -H "Accept: application/nostr+json" http://127.0.0.1:18479/ | sed -n 's/.*"self"[[:space:]]*:[[:space:]]*"\\([0-9a-f]\\{64\\}\\)".*/\\1/p' || true`,
  ).trim();
  if (existing !== host || relay !== identity)
    fail(
      "This server already hosts a different community. Nothing was changed. A workspace can only be moved onto a server without one.",
    );
  console.log("This workspace is already on the server. Checking it…");
} else {
  remote(
    "mkdir -p /opt/workrooms && chmod 700 /opt/workrooms && rm -rf /opt/workrooms/incoming && mkdir -m 700 /opt/workrooms/incoming",
  );
  copy(
    [
      here("../local-community/compose.yml"),
      here("./compose.vps.yml"),
      here("./Caddyfile"),
      here("./setup.sh"),
      here("./restore.sh"),
    ],
    "/opt/workrooms/",
  );
  console.log("Copying the backup to the server…");
  copy(
    PARTS.map((name) => join(folder, name)),
    "/opt/workrooms/incoming/",
  );
  console.log("Rebuilding the workspace on the server…");
  const output = remote(
    `sh /opt/workrooms/restore.sh ${host}`,
    "The move did not finish, and the server was left without a community. The workspace on this computer is unchanged. Fix what the server reported, then run the same command again.",
  );
  relay = /^relay=([0-9a-f]{64})$/m.exec(output)?.[1];
  if (relay !== identity)
    fail(
      "The server is running a community, but not with this workspace's identity. Do not connect to it; ask for help with this message.",
    );
}

const problem = await publicProblem(host, relay);
if (problem) fail(problem);

console.log(
  `Workspace moved: https://${host}\nOwner: ${encodeNpub(saved.RELAY_OWNER_PUBKEY)}\nThe copy on this computer is unchanged and still running. Enter https://${host} in the app to connect.`,
);
