// Rebuilds the workspace on this computer from a backup backup.mjs made: after
// a new computer, a reinstall or a wiped Docker. It refuses to run where a
// workspace already exists, so it can never overwrite one, and a restore that
// does not finish removes what it started, so it can simply be run again.
//
//   bin/node scripts/workrooms-solo/restore.mjs "<backup folder>"
//   bin/node scripts/workrooms-solo/restore.mjs "<encrypted backup>.tar.age"
//   bin/node scripts/workrooms-solo/restore.mjs --r2 ["<name>.tar.age"]
//
// An encrypted backup is opened with the backup key's secret half, which this
// reads from the clipboard and then clears: its owner copies it from their
// password manager just before. --r2 fetches the newest backup, or the named
// one, from the bucket offsite.mjs r2 was given.
//
// The owner signs in afterwards with the same key as before. Like setup.mjs
// it makes a certificate and asks the system to trust it.
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { recipientFor } from "./age.mjs";
import {
  addressSettings,
  checkWorkspace,
  compose,
  docker,
  encodeNpub,
  ensureDocker,
  ensureTrusted,
  fail,
  home,
  makeCertificate,
  placeFiles,
  publicKey,
  project,
  readSettings,
  removeFiles,
  TAGS,
  TOOLS,
  writeSettings,
} from "./common.mjs";
import { clearClipboard, readClipboard } from "./secrets.mjs";
import {
  backupsInBucket,
  bucket,
  readOffsite,
  unseal,
  work,
  writeOffsite,
} from "./vault.mjs";

const source = process.argv[2];
const sealed = source === "--r2" || /\.age$/i.test(source ?? "");
// An encrypted backup is opened into a private folder that is emptied again
// however this run ends.
const folder = sealed ? work : source;
const part = (name) => join(folder ?? "", name);
const complete = () =>
  ["database.dump", "files.tar", "git.tar", "settings.env"].every((name) =>
    existsSync(part(name)),
  );
if (
  !source ||
  (!sealed && !complete()) ||
  (sealed && source !== "--r2" && !existsSync(source))
)
  fail(
    'Usage: restore.mjs "<backup>", a folder or a .tar.age file made by backup.mjs, or restore.mjs --r2.',
  );
if (readSettings())
  fail(
    `This computer already has a workspace (${home}). Nothing was changed. Restore is for a computer without one.`,
  );
await ensureDocker();
if (
  docker(
    [
      "volume",
      "ls",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ],
    { capture: true },
  ).trim()
)
  fail(
    `Docker still holds data named ${project} from an earlier workspace. Nothing was changed.`,
  );

let backupKey;
if (sealed) {
  backupKey = readClipboard();
  if (!recipientFor(backupKey))
    fail(
      "The clipboard does not hold a backup key. Its owner copies the backup key from their password manager, then run this again. Nothing was changed.",
    );
  clearClipboard();
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true, mode: 0o700 });
  process.on("exit", () => rmSync(work, { recursive: true, force: true }));
  let file = source;
  if (source === "--r2") {
    const offsite = readOffsite();
    if (!offsite.r2)
      fail(
        "This computer has not been given the bucket yet. Run offsite.mjs r2 first.",
      );
    try {
      const store = bucket(offsite);
      const name = process.argv[3] ?? (await backupsInBucket(store)).at(-1);
      if (!name) fail("The bucket holds no encrypted backup.");
      console.log(`Fetching ${name}…`);
      file = join(work, "fetched.tar.age");
      await store.download(name, file);
    } catch (error) {
      fail(`The backup could not be fetched: ${error.message}`);
    }
  }
  try {
    await unseal(file, backupKey, work);
  } catch (error) {
    fail(
      error.code === "WRONG_KEY"
        ? "That backup key does not open this backup: it was made with a different key. Nothing was changed."
        : `The backup could not be opened: ${error.message} Nothing was changed.`,
    );
  }
  if (!complete())
    fail("The backup's contents are incomplete. Nothing was changed.");
}

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

for (const tag of TAGS)
  if (
    docker(["image", "inspect", tag], { capture: true, check: false }) ===
    undefined
  )
    docker(["pull", tag]);

// Everything from here was made by this run, which the two checks above
// established, so an unfinished run may remove it.
let restored = false;
process.on("exit", () => {
  if (restored) return;
  compose(["down", "-v"], { check: false });
  removeFiles();
});
writeSettings(settings);
placeFiles();
makeCertificate();

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
      "The backup's records do not match its settings. The workspace was not restored.",
    );
}
compose(["up", "-d", "--wait"]);
const origin = await checkWorkspace(
  port,
  publicKey(settings.BUZZ_RELAY_PRIVATE_KEY),
);
restored = true;
console.log(
  `Workspace restored: ${origin}\nOwner: ${encodeNpub(settings.RELAY_OWNER_PUBKEY)}\nSettings and certificate: ${home}`,
);
if (sealed) {
  // The key that opened this backup is the one new backups are made for.
  const offsite = readOffsite();
  writeOffsite({
    ...offsite,
    recipient: recipientFor(backupKey),
    confirmed: new Date().toISOString(),
  });
  console.log(
    `Encrypted backups will use the same backup key. ${offsite.r2 ? "They go to the same bucket as before." : "Give them a destination again with offsite.mjs folder or r2."} The weekly schedule is not set on this computer yet: offsite.mjs schedule.`,
  );
}
ensureTrusted(
  "The workspace itself is restored. Run setup.mjs with the owner's public key and approve the prompt.",
);
