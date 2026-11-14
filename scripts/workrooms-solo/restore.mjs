// Rebuilds the workspace on this Mac from a folder backup.mjs made: after a
// new Mac, a reinstall or a wiped Docker. It refuses to run where a workspace
// already exists, so it can never overwrite one.
//
//   bin/node scripts/workrooms-solo/restore.mjs "<backup folder>"
//
// The owner signs in afterwards with the same key as before. Like setup.mjs
// it makes a certificate, and macOS asks the person at the Mac to trust it.
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPublicKey, nip19 } from "nostr-tools";
import {
  addressSettings,
  certificateTrusted,
  checkWorkspace,
  compose,
  docker,
  ensureDocker,
  fail,
  HOST,
  home,
  makeCertificate,
  placeFiles,
  readSettings,
  TAGS,
  TOOLS,
  trustCertificate,
  writeSettings,
} from "./common.mjs";

const folder = process.argv[2];
const part = (name) => join(folder ?? "", name);
if (
  !folder ||
  !["database.dump", "files.tar", "git.tar", "settings.env"].every((name) =>
    existsSync(part(name)),
  )
)
  fail('Usage: restore.mjs "<backup folder>", a folder made by backup.mjs.');
if (readSettings())
  fail(
    `This Mac already has a workspace (${home}). Nothing was changed. Restore is for a Mac without one.`,
  );

const saved = Object.fromEntries(
  readFileSync(part("settings.env"), "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    }),
);
// The address is part of the workspace's records. A different port here
// means a different address, so the records are moved to it below.
const port = Number(process.env.WORKROOMS_PORT || saved.WORKROOMS_PORT);
const settings = { ...saved, ...addressSettings(port) };

await ensureDocker();
for (const tag of TAGS)
  if (
    docker(["image", "inspect", tag], { capture: true, check: false }) ===
    undefined
  )
    docker(["pull", tag]);
writeSettings(settings);
placeFiles();
makeCertificate();
if (process.env.WORKROOMS_TRUST !== "skip" && !certificateTrusted()) {
  console.log(
    `macOS will now ask for this Mac's password or Touch ID. It is asking to trust the certificate that keeps the connection to ${HOST} private.`,
  );
  if (!trustCertificate() || !certificateTrusted())
    fail(
      "The certificate was not trusted, so the app could not connect. Trust it by running setup.mjs with the owner's public key.",
    );
}

/** Runs docker with a file from the backup as its input. */
function load(name, run) {
  const file = openSync(part(name), "r");
  try {
    run(file);
  } finally {
    closeSync(file);
  }
}
const container = (service) =>
  compose(["ps", "-aq", service], { capture: true }).trim();
const unpack = (name, service, path) =>
  load(name, (from) =>
    docker(
      [
        "run",
        "--rm",
        "-i",
        "--network",
        "none",
        "--volumes-from",
        container(service),
        TOOLS,
        "tar",
        "-C",
        path,
        "-xf",
        "-",
      ],
      { from },
    ),
  );
const sql = (statement) =>
  compose(
    [
      "exec",
      "-T",
      "postgres",
      "sh",
      "-c",
      'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -At -c "$0"',
      statement,
    ],
    { capture: true },
  ).trim();

// Fill the empty volumes before anything that reads them starts.
compose(["create"]);
unpack("files.tar", "minio", "/data");
unpack("git.tar", "relay", "/data/git");
compose(["up", "-d", "--wait", "postgres"]);
load("database.dump", (from) =>
  compose(
    [
      "exec",
      "-T",
      "postgres",
      "sh",
      "-c",
      'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error',
    ],
    { from },
  ),
);
if (settings.BUZZ_DOMAIN !== saved.BUZZ_DOMAIN) {
  // Both values were written by this kit; neither comes from outside.
  const moved = sql(
    `UPDATE communities SET host = '${settings.BUZZ_DOMAIN}' WHERE host = '${saved.BUZZ_DOMAIN}' RETURNING id`,
  );
  if (!/^[0-9a-f-]{36}$/m.test(moved))
    fail(
      "The backup's records do not match its settings. The workspace was not started.",
    );
}
compose(["up", "-d", "--wait"]);
const origin = await checkWorkspace(
  port,
  getPublicKey(Buffer.from(settings.BUZZ_RELAY_PRIVATE_KEY, "hex")),
);
console.log(
  `Workspace restored: ${origin}\nOwner: ${nip19.npubEncode(settings.RELAY_OWNER_PUBKEY)}\nSettings and certificate: ${home}`,
);
