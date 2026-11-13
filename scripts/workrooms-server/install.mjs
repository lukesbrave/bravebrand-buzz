// Sets up a Workrooms community on a server its owner runs, from the owner's
// Mac, over SSH. Run it twice:
//
//   bin/node scripts/workrooms-server/install.mjs root@203.0.113.7 team.example.com
//     checks DNS, installs Docker and fetches the images (safe before a key exists)
//
//   bin/node scripts/workrooms-server/install.mjs root@203.0.113.7 team.example.com npub1…
//     creates the community with that owner, starts it and checks it from here
//
// The npub is the public key the app shows after "Create my key". No private
// key is read, sent or printed. Rerun the same command after an interruption.
import { spawnSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { fileURLToPath } from "node:url";
import { nip19 } from "nostr-tools";

const [target, rawHost, rawOwner] = process.argv.slice(2);
const host = rawHost?.toLowerCase();
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
if (
  !target ||
  !/^[A-Za-z0-9._-]+@[A-Za-z0-9.:-]+$/.test(target) ||
  !host ||
  host.length > 253 ||
  !host.includes(".") ||
  !host
    .split(".")
    .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
)
  fail(
    "Usage: install.mjs <user@server> <hostname> [owner npub], for example root@203.0.113.7 team.example.com npub1…",
  );
let owner;
if (rawOwner) {
  try {
    const decoded = /^[0-9a-f]{64}$/.test(rawOwner)
      ? { type: "npub", data: rawOwner }
      : nip19.decode(rawOwner);
    if (decoded.type !== "npub") throw new Error();
    owner = decoded.data;
  } catch {
    fail(
      "That is not a public key. Copy the key starting with npub1 from the app. Never paste a key starting with nsec.",
    );
  }
}

const ssh = ["-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes"];
/** Runs on the server; its stderr and progress are shown, its stdout returned. */
function remote(command, show = true) {
  const result = spawnSync("ssh", [...ssh, target, command], {
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
  });
  if (result.error) fail(result.error.message);
  if (show && result.stdout) process.stdout.write(result.stdout);
  if (result.status !== 0)
    fail(
      "The server step did not finish. Fix what it reported, then run the same command again.",
    );
  return result.stdout;
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// The certificate can only be issued once the name reaches this server, and
// the app resolves the name as this Mac does, so wait on this Mac's resolver.
const address = remote(
  "ip -4 -o route get 1.1.1.1 | sed -n 's/.* src \\([0-9.]*\\).*/\\1/p'",
  false,
).trim();
if (!/^\d+\.\d+\.\d+\.\d+$/.test(address))
  fail("Could not read the server's public IPv4 address.");
if (!owner)
  console.log(
    `DNS record to create now: ${host}, type A, value ${address}. In Cloudflare set it to DNS only.`,
  );
let announced = false;
for (let waited = 0; owner; waited += 10) {
  const seen = await lookup(host, { family: 4 }).then(
    (answer) => answer.address,
    () => undefined,
  );
  if (seen === address) break;
  if (!announced) {
    console.log(
      `Waiting for DNS. ${host} must have an A record pointing to ${address}` +
        (seen ? ` (this Mac currently sees ${seen}).` : ".") +
        " In Cloudflare set it to DNS only.",
    );
    announced = true;
  }
  if (waited >= 600)
    fail(
      `${host} still does not resolve to ${address} on this Mac. Check the DNS record, then run the same command again.`,
    );
  await sleep(10_000);
}
if (owner) console.log(`DNS ready: ${host} → ${address}`);

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
remote("mkdir -p /opt/workrooms && chmod 700 /opt/workrooms");
const copied = spawnSync(
  "scp",
  [
    ...ssh,
    "-q",
    here("../local-community/compose.yml"),
    here("./compose.vps.yml"),
    here("./Caddyfile"),
    here("./setup.sh"),
    `${target}:/opt/workrooms/`,
  ],
  { stdio: "inherit" },
);
if (copied.status !== 0) fail("Could not copy the server files.");

const output = remote(
  `sh /opt/workrooms/setup.sh ${host}${owner ? ` ${owner}` : ""}`,
);
if (!owner) {
  console.log(
    "Server prepared. When the app shows the owner's public key, run this again with it as the last argument.",
  );
  process.exit(0);
}
const relay = /^relay=([0-9a-f]{64})$/m.exec(output)?.[1];
if (!relay) fail("The server did not report the community's identity.");

// The same checks the app's first connection depends on, from this Mac.
const origin = `https://${host}`;
const reach = (path, init) =>
  fetch(origin + path, { ...init, signal: AbortSignal.timeout(10_000) });
let self;
for (let waited = 0; waited <= 300 && self !== relay; waited += 5) {
  self = await reach("/", { headers: { Accept: "application/nostr+json" } })
    .then((response) => response.json())
    .then(
      (body) => body.self,
      () => undefined,
    );
  if (self !== relay) await sleep(5_000);
}
if (self !== relay)
  fail(
    `${origin} is not answering as this community yet. The certificate may still be issuing: run the same command again in a minute.`,
  );
const anonymous = await reach("/query", { method: "POST", body: "{}" });
if (anonymous.status !== 401)
  fail(
    `Expected ${origin} to refuse an anonymous read, got ${anonymous.status}.`,
  );
const operator = await reach("/operator/communities");
if (operator.status !== 404)
  fail(`Expected ${origin} to hide operator routes, got ${operator.status}.`);

console.log(
  `Workspace ready: ${origin}\nOwner: ${nip19.npubEncode(owner)}\nEnter ${origin} in the app to connect.`,
);
