// Shared by offsite.mjs, backup.mjs and restore.mjs: the settings for
// encrypted backups, the one-file form of a backup, where copies are sent,
// and the record of every run.
//
// An encrypted backup is one file, "Workrooms backup <date> <time>.tar.age":
// the plain backup's files in a tar, encrypted with age for the backup key's
// public half. Without this kit it opens with two free tools:
//   age -d -i <file holding the backup key> "<backup>.tar.age" | tar -x
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { decrypt, encrypt } from "./age.mjs";
import { pack, unpack } from "./archive.mjs";
import { home } from "./common.mjs";
import { r2 } from "./r2.mjs";
import { readSecret } from "./secrets.mjs";

const windows = process.platform === "win32";
const offsiteFile = join(home, "offsite.json");
const recordFile = join(home, "backup-record.json");
/** Where a backup is assembled or opened; private, and emptied afterwards. */
export const work = join(home, "backup-work");
export const scheduleLog = join(home, "backup-schedule.log");
/** The files of a backup, in the order they are packed. */
export const PARTS = [
  "backup.json",
  "settings.env",
  "database.dump",
  "files.tar",
  "git.tar",
];
export const SEALED = /^Workrooms backup \d{4}-\d{2}-\d{2} \d{4}\.tar\.age$/;
const KEEP = 8;

const readJson = (file, otherwise) =>
  existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : otherwise;
const writeJson = (file, value) => {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
};

/**
 * The settings for encrypted backups. None of it is secret: the backup key's
 * public half, when its owner proved they hold the secret half, the folder
 * and bucket copies go to, how many to keep, and the schedule.
 */
export const readOffsite = () => readJson(offsiteFile, {});
export const writeOffsite = (values) => writeJson(offsiteFile, values);
export const keepCount = (offsite) => offsite.keep ?? KEEP;

/** Every encrypted backup run, newest last. */
export const readRecord = () => readJson(recordFile, []);
export function record(run) {
  writeJson(recordFile, [...readRecord(), run].slice(-30));
  return run;
}
/** A run that reached at least one destination. */
export const reached = (run) =>
  Object.values(run.sent ?? {}).some((result) => result === true);

/** Writes a folder's backup files as one encrypted file. */
export async function seal(folder, recipient, file) {
  await pipeline(
    Readable.from(encrypt(recipient, pack(folder, PARTS))),
    createWriteStream(file, { mode: 0o600 }),
  );
}

/** Opens an encrypted file into a folder's backup files. */
export async function unseal(file, secret, folder) {
  const found = await unpack(
    decrypt(secret, createReadStream(file)),
    folder,
    PARTS,
  );
  if (found.length !== PARTS.length)
    throw new Error("The backup's contents are incomplete.");
}

/** The owner's bucket, with the access key's secret from the credential store. */
export function bucket(offsite) {
  const secret = readSecret("r2");
  if (!secret)
    throw new Error(
      "The Cloudflare access key is not in this computer's credential store.",
    );
  return r2(offsite.r2, secret);
}

const newestLast = (names) => names.filter((name) => SEALED.test(name)).sort();

/** The encrypted backups in a folder, newest last. */
export const backupsIn = (folder) => newestLast(readdirSync(folder));
/** The encrypted backups in the bucket, newest last. */
export const backupsInBucket = async (store) =>
  newestLast((await store.list()).map((item) => item.name));

/**
 * Copies an encrypted backup to every destination and thins out old ones.
 * Returns, per destination, true or the reason it failed.
 */
export async function send(file, offsite) {
  const name = basename(file);
  const keep = keepCount(offsite);
  const attempt = async (run) => {
    try {
      await run();
      return true;
    } catch (error) {
      return error.message;
    }
  };
  const sent = {};
  if (offsite.folder)
    sent.folder = await attempt(() => {
      // Never recreated here: a cloud folder that has gone missing must not
      // quietly become an ordinary folder on this computer.
      if (!existsSync(offsite.folder))
        throw new Error(`The backup folder is missing: ${offsite.folder}`);
      const to = join(offsite.folder, name);
      copyFileSync(file, `${to}.partial`);
      renameSync(`${to}.partial`, to);
      for (const old of backupsIn(offsite.folder).slice(0, -keep))
        rmSync(join(offsite.folder, old));
    });
  if (offsite.r2)
    sent.r2 = await attempt(async () => {
      const store = bucket(offsite);
      await store.upload(name, file);
      for (const old of (await backupsInBucket(store)).slice(0, -keep))
        await store.remove(old);
    });
  return sent;
}

/** Cloud folders found on this computer, as { name, path }. */
export function cloudFolders() {
  const user = homedir();
  const found = [];
  const offer = (name, path) => {
    if (path && existsSync(path) && !found.some((one) => one.path === path))
      found.push({ name, path });
  };
  if (windows) {
    offer("OneDrive", process.env.OneDriveConsumer || process.env.OneDrive);
    offer("OneDrive (work)", process.env.OneDriveCommercial);
    offer("iCloud Drive", join(user, "iCloudDrive"));
    offer("Dropbox", join(user, "Dropbox"));
    // Google Drive for desktop appears as a drive of its own.
    for (const letter of "GHIJKLMNOPQRSTUVWXYZ")
      offer("Google Drive", `${letter}:\\My Drive`);
    offer("Google Drive", join(user, "Google Drive"));
    offer("Google Drive", join(user, "My Drive"));
    return found;
  }
  offer(
    "iCloud Drive",
    join(user, "Library/Mobile Documents/com~apple~CloudDocs"),
  );
  const storage = join(user, "Library/CloudStorage");
  for (const entry of existsSync(storage) ? readdirSync(storage) : []) {
    const path = join(storage, entry);
    if (entry.startsWith("GoogleDrive-"))
      offer(`Google Drive (${entry.slice(12)})`, join(path, "My Drive"));
    else if (entry.startsWith("OneDrive")) offer(entry.replace("-", " "), path);
    else if (entry.startsWith("Dropbox")) offer("Dropbox", path);
  }
  offer("Dropbox", join(user, "Dropbox"));
  offer("Google Drive", join(user, "Google Drive"));
  offer("OneDrive", join(user, "OneDrive"));
  return found;
}
