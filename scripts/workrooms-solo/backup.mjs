// Saves a complete copy of the workspace on this computer: every message and
// channel, uploaded files, git data and the workspace's settings. restore.mjs
// rebuilds the workspace from it.
//
//   bin/node scripts/workrooms-solo/backup.mjs [folder]
//   bin/node scripts/workrooms-solo/backup.mjs --encrypted
//
// The first form saves a dated folder, by default in ~/Documents/Workrooms
// Backups. It is not encrypted and holds the workspace's own private settings,
// so keep it as private as the computer itself.
//
// The second form saves one encrypted file to the destinations offsite.mjs set
// up, and is safe to keep with a storage company: only the backup key's secret
// half, which is not on this computer, opens it. Every such run is recorded for
// `offsite.mjs status`. The weekly schedule runs it with --scheduled, which
// does nothing while a backup from the last six days exists.
//
// The workspace pauses for a few seconds while the copy is taken. The owner's
// key is in neither kind of backup: that lives in the system's credential
// store and its recovery copy.
import {
  closeSync,
  copyFileSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  compose,
  docker,
  ensureDocker,
  fail,
  failure,
  readSettings,
  settingsFile,
  TOOLS,
} from "./common.mjs";
import {
  PARTS,
  reached,
  readOffsite,
  readRecord,
  record,
  scheduleLog,
  seal,
  send,
  work,
} from "./vault.mjs";

const args = process.argv.slice(2);
const flag = (name) =>
  args.includes(name) && args.splice(args.indexOf(name), 1).length > 0;
const scheduled = flag("--scheduled");
const encrypted = flag("--encrypted") || scheduled;
const settings = readSettings();
const offsite = readOffsite();
const megabytes = (bytes) => `${(bytes / 1_048_576).toFixed(1)} MB`;
const started = new Date();
const name = `Workrooms backup ${started
  .toLocaleString("sv-SE", { hour12: false })
  .slice(0, 16)
  .replace(":", "")}`;

let recorded = !encrypted;
if (encrypted) {
  // Whatever stops this run, the record says so.
  process.on("exit", () => {
    if (!recorded)
      record({
        at: started.toISOString(),
        ok: false,
        scheduled,
        error: failure.message ?? "The backup stopped before it finished.",
      });
  });
  process.on("uncaughtException", (error) => fail(error.message));
  if (scheduled)
    try {
      // The schedule's own log holds one run.
      truncateSync(scheduleLog);
    } catch {
      // Not there on Windows until the run ends.
    }
  if (!offsite.confirmed)
    fail(
      "Encrypted backups are not set up: the backup key has not been made and checked. Run offsite.mjs key.",
    );
  if (!offsite.folder && !offsite.r2)
    fail(
      "Encrypted backups have nowhere to go yet. Run offsite.mjs folder or offsite.mjs r2.",
    );
  const last = readRecord().findLast(reached);
  if (scheduled && last && started - new Date(last.at) < 6 * 86_400_000) {
    recorded = true;
    console.log(`The backup from ${last.at} is recent enough. Nothing to do.`);
    process.exit(0);
  }
}
if (!settings) fail("There is no workspace on this computer to back up.");
await ensureDocker();

/** Saves the backup's files into a folder. Throws if any part fails. */
function takeCopy(into) {
  const done = (result, what) => {
    if (result === undefined) throw new Error(`Could not ${what}.`);
    return result;
  };
  /** Runs docker with its output written to a private file in the folder. */
  const save = (file, run) => {
    const to = openSync(join(into, file), "w", 0o600);
    try {
      done(run(to), `save ${file}`);
    } finally {
      closeSync(to);
    }
  };
  const container = (service) =>
    done(
      compose(["ps", "-aq", service], { capture: true, check: false }),
      `find the workspace's ${service}`,
    ).trim();
  /** A volume, read through a throwaway container with no network. */
  const archive = (file, service, path) =>
    save(file, (to) =>
      docker(
        [
          "run",
          "--rm",
          "--network",
          "none",
          "--volumes-from",
          container(service),
          TOOLS,
          "tar",
          "-C",
          path,
          "-cf",
          "-",
          ".",
        ],
        { to, check: false },
      ),
    );

  // Nothing writes while the copy is taken, so its parts agree with each other.
  done(compose(["stop", "relay"], { check: false }), "pause the workspace");
  try {
    save("database.dump", (to) =>
      compose(
        [
          "exec",
          "-T",
          "postgres",
          "sh",
          "-c",
          'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc',
        ],
        { to, check: false },
      ),
    );
    archive("files.tar", "minio", "/data");
    archive("git.tar", "relay", "/data/git");
    copyFileSync(settingsFile, join(into, "settings.env"));
    writeFileSync(
      join(into, "backup.json"),
      `${JSON.stringify(
        {
          made: started.toISOString(),
          address: `https://${settings.BUZZ_DOMAIN}`,
          image: settings.BUZZ_IMAGE,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    if (compose(["up", "-d", "--wait"], { check: false }) === undefined)
      console.error(
        "The workspace did not start again by itself. Run setup.mjs with the owner's public key to start it.",
      );
  }
}

/** Empties and makes a private folder, takes the copy, and tidies on failure. */
function copyInto(folder) {
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  try {
    takeCopy(folder);
  } catch (error) {
    rmSync(folder, { recursive: true, force: true });
    fail(`${error.message} No backup was made.`);
  }
}

if (!encrypted) {
  const folder = join(
    args[0] || join(homedir(), "Documents/Workrooms Backups"),
    name,
  );
  copyInto(`${folder}.partial`);
  renameSync(`${folder}.partial`, folder);
  const size = ["database.dump", "files.tar", "git.tar"].reduce(
    (total, part) => total + statSync(join(folder, part)).size,
    0,
  );
  console.log(
    `Backup saved: ${folder} (${megabytes(size)})\nIt is not encrypted and contains the workspace's private settings. Keep it private.`,
  );
} else {
  copyInto(work);
  const file = join(work, `${name}.tar.age`);
  let sent;
  try {
    await seal(work, offsite.recipient, file);
    for (const part of PARTS) rmSync(join(work, part));
    sent = await send(file, offsite);
  } finally {
    const bytes = sent ? statSync(file).size : 0;
    rmSync(work, { recursive: true, force: true });
    if (sent) {
      const ok = Object.values(sent).every((result) => result === true);
      record({
        at: started.toISOString(),
        ok,
        scheduled,
        file: `${name}.tar.age`,
        bytes,
        sent,
      });
      recorded = true;
      console.log(
        `Encrypted backup made: ${name}.tar.age (${megabytes(bytes)})`,
      );
      const places = { folder: offsite.folder, r2: "Cloudflare R2" };
      for (const [place, result] of Object.entries(sent))
        console.log(
          result === true
            ? `Saved to ${places[place]}`
            : `NOT saved to ${places[place]}: ${result}`,
        );
      if (!ok) process.exitCode = 1;
    }
  }
}
