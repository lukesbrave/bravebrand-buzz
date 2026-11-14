// Saves a complete copy of the workspace on this computer into one dated folder:
// every message and channel, uploaded files, git data and the workspace's
// settings. restore.mjs rebuilds the workspace from that folder.
//
//   bin/node scripts/workrooms-solo/backup.mjs [folder]
//
// The default folder is ~/Documents/Workrooms Backups. The workspace pauses
// for a few seconds while the copy is taken. The copy holds the workspace's
// own private settings, so keep it as private as the computer itself. The
// owner's key is not in it: that lives in the system's credential store and
// its recovery copy.
import {
  closeSync,
  copyFileSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  compose,
  docker,
  ensureDocker,
  fail,
  readSettings,
  settingsFile,
  TOOLS,
} from "./common.mjs";

const settings = readSettings();
if (!settings) fail("There is no workspace on this computer to back up.");
await ensureDocker();

const parent =
  process.argv[2] || join(homedir(), "Documents/Workrooms Backups");
const stamp = new Date()
  .toLocaleString("sv-SE", { hour12: false })
  .slice(0, 16)
  .replace(":", "");
const folder = join(parent, `Workrooms backup ${stamp}`);
const partial = `${folder}.partial`;
mkdirSync(partial, { recursive: true, mode: 0o700 });

/** Runs docker with its output written to a private file in the backup. */
function save(name, run) {
  const file = openSync(join(partial, name), "w", 0o600);
  try {
    run(file);
  } finally {
    closeSync(file);
  }
}
const container = (service) =>
  compose(["ps", "-aq", service], { capture: true }).trim();
/** A volume, read through a throwaway container with no network. */
const archive = (name, service, path) =>
  save(name, (to) =>
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
      { to },
    ),
  );

// Nothing writes while the copy is taken, so its parts agree with each other.
compose(["stop", "relay"]);
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
      { to },
    ),
  );
  archive("files.tar", "minio", "/data");
  archive("git.tar", "relay", "/data/git");
  copyFileSync(settingsFile, join(partial, "settings.env"));
  writeFileSync(
    join(partial, "backup.json"),
    `${JSON.stringify(
      {
        made: new Date().toISOString(),
        address: `https://${settings.BUZZ_DOMAIN}`,
        image: settings.BUZZ_IMAGE,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  rmSync(partial, { recursive: true, force: true });
  throw error;
} finally {
  compose(["up", "-d", "--wait"]);
}
renameSync(partial, folder);
const size = ["database.dump", "files.tar", "git.tar"].reduce(
  (total, name) => total + statSync(join(folder, name)).size,
  0,
);
console.log(
  `Backup saved: ${folder} (${(size / 1_048_576).toFixed(1)} MB)\nIt contains the workspace's private settings. Keep it private.`,
);
