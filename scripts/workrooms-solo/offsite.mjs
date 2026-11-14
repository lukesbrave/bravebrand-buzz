// Sets up encrypted backups that are safe to keep away from this computer:
// the backup key, where copies go, and a weekly schedule. backup.mjs
// --encrypted makes one; restore.mjs opens one.
//
//   offsite.mjs key                 make the backup key; its secret half goes
//                                   to the clipboard and nowhere else
//   offsite.mjs key --check         check the copy in the password manager,
//                                   read from the clipboard
//   offsite.mjs folders             list cloud folders found on this computer
//   offsite.mjs folder "<path>"     send copies to a folder (or: folder off)
//   offsite.mjs r2 <endpoint> <bucket> <access key id>
//                                   send copies to the owner's Cloudflare R2
//                                   bucket; the secret access key is read
//                                   from the clipboard (or: r2 off)
//   offsite.mjs keep <number>       how many backups to keep in each place
//   offsite.mjs schedule <day> <HH:MM>   back up every week (or: schedule off)
//   offsite.mjs status              what is set up and how the last runs went
//
// Run each with bin/node (node on Windows). No secret is ever printed, passed
// on a command line or written to a file: the backup key's secret half exists
// only in its owner's password manager, and the Cloudflare secret access key
// is kept in the Keychain or Windows Credential Manager.
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { newKeyPair, recipientFor } from "./age.mjs";
import { fail, readSettings, sleep } from "./common.mjs";
import { endpointFrom, r2 } from "./r2.mjs";
import {
  DAYS,
  installSchedule,
  removeSchedule,
  scheduleInstalled,
} from "./schedule.mjs";
import {
  clearClipboard,
  clearClipboardLater,
  copyToClipboard,
  deleteSecret,
  readClipboard,
  storable,
  storeSecret,
} from "./secrets.mjs";
import {
  backupsIn,
  backupsInBucket,
  bucket,
  cloudFolders,
  keepCount,
  reached,
  readOffsite,
  readRecord,
  writeOffsite,
} from "./vault.mjs";

const [command, ...args] = process.argv.slice(2);
const offsite = readOffsite();
const when = (iso) => new Date(iso).toLocaleString("sv-SE").slice(0, 16);
const megabytes = (bytes) => `${(bytes / 1_048_576).toFixed(1)} MB`;

const commands = {
  key() {
    if (args[0] === "--check") {
      const held = recipientFor(readClipboard());
      clearClipboard();
      if (!offsite.recipient)
        fail("No backup key has been made yet. Run offsite.mjs key.");
      if (!held)
        fail(
          "The clipboard does not hold a backup key. Its owner copies it from their password manager (it starts AGE-SECRET-KEY-1), then run this again.",
        );
      if (held !== offsite.recipient)
        fail(
          "The key on the clipboard is not the one that was just made, so the password manager does not hold it. Run offsite.mjs key to make a new one and save that.",
        );
      writeOffsite({ ...offsite, confirmed: new Date().toISOString() });
      console.log(
        "The password manager holds the backup key. The clipboard has been cleared. Encrypted backups can be made.",
      );
      return;
    }
    if (offsite.confirmed && args[0] !== "--replace")
      fail(
        "A backup key is already in use, and its owner's password manager holds it. To replace it, run offsite.mjs key --replace: backups made so far still need the old key, so they keep both.",
      );
    const pair = newKeyPair();
    if (!copyToClipboard(pair.secret)) fail("The clipboard could not be used.");
    clearClipboardLater(180);
    writeOffsite({
      ...offsite,
      recipient: pair.recipient,
      confirmed: undefined,
    });
    console.log(
      `A new backup key is on the clipboard, and nowhere else.
Its owner now pastes it into their password manager as a new entry, named for example "Workrooms backup key", and saves it.
The clipboard is cleared in three minutes. If that was too soon, run this again for a fresh key.
Then they copy it back from the password manager and you run: offsite.mjs key --check`,
    );
  },

  folders() {
    const found = cloudFolders();
    if (found.length === 0)
      console.log(
        "No cloud folder was found on this computer. Any folder that is copied somewhere else works: give its path to offsite.mjs folder.",
      );
    for (const { name, path } of found) console.log(`${name}: ${path}`);
  },

  folder() {
    if (args[0] === "off") {
      writeOffsite({ ...offsite, folder: undefined });
      console.log("Encrypted backups no longer go to a folder.");
      return;
    }
    if (!args[0]) fail('Usage: offsite.mjs folder "<path>"');
    const folder = resolve(args[0]);
    try {
      mkdirSync(folder, { recursive: true });
      const probe = join(
        folder,
        `.workrooms-check-${randomBytes(4).toString("hex")}`,
      );
      writeFileSync(probe, "");
      rmSync(probe);
    } catch (error) {
      fail(`That folder cannot be written to: ${error.message}`);
    }
    writeOffsite({ ...offsite, folder });
    console.log(`Encrypted backups will be saved to: ${folder}`);
  },

  async r2() {
    if (args[0] === "off") {
      deleteSecret("r2");
      writeOffsite({ ...offsite, r2: undefined });
      console.log(
        "Encrypted backups no longer go to Cloudflare, and the access key was removed from this computer. The bucket and what it holds are untouched.",
      );
      return;
    }
    const [address, name, keyId] = args;
    const endpoint = endpointFrom(address ?? "");
    if (
      !endpoint ||
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name ?? "") ||
      !keyId
    )
      fail(
        "Usage: offsite.mjs r2 <endpoint> <bucket> <access key id>, with the Secret Access Key on the clipboard. The endpoint looks like https://<account id>.r2.cloudflarestorage.com.",
      );
    const secret = readClipboard();
    clearClipboard();
    if (!storable(secret) || secret === keyId)
      fail(
        "The clipboard does not hold the Secret Access Key. Its owner copies it from the Cloudflare page (the Secret Access Key, not the Access Key ID or the token value), then run this again.",
      );
    const settings = { endpoint, bucket: name, keyId };
    // Proves the key can do exactly what a backup needs, inside this bucket.
    const probe = `workrooms-check-${randomBytes(4).toString("hex")}.txt`;
    try {
      const store = r2(settings, secret);
      await store.put(probe, "Workrooms");
      if ((await store.text(probe)) !== "Workrooms")
        throw new Error("A test file did not come back as written.");
      if (!(await store.list()).some((item) => item.name === probe))
        throw new Error("A test file was not listed.");
      await store.remove(probe);
    } catch (error) {
      fail(
        `Cloudflare did not accept that: ${error.message} Check the bucket name, that the token is Object Read & Write for this bucket, and that the Secret Access Key was copied whole. Nothing was saved.`,
      );
    }
    if (!storeSecret("r2", secret))
      fail(
        "The access key could not be saved in this computer's credential store. Nothing was saved.",
      );
    writeOffsite({ ...offsite, r2: settings });
    console.log(
      `Cloudflare accepted the key: a test file was written to ${name}, read back, listed and deleted.
The Secret Access Key is in this computer's credential store and the clipboard has been cleared.
Encrypted backups will be saved to the bucket ${name}.`,
    );
  },

  keep() {
    const keep = Number(args[0]);
    if (!Number.isInteger(keep) || keep < 1)
      fail("Usage: offsite.mjs keep <number>");
    writeOffsite({ ...offsite, keep });
    console.log(`The newest ${keep} encrypted backups are kept in each place.`);
  },

  async schedule() {
    if (args[0] === "off") {
      removeSchedule();
      writeOffsite({ ...offsite, schedule: undefined });
      console.log("The weekly backup is off.");
      return;
    }
    const day = DAYS.indexOf((args[0] ?? "").toLowerCase());
    const [, hour, minute] =
      /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(args[1] ?? "") ?? [];
    if (day < 0 || hour === undefined)
      fail(
        "Usage: offsite.mjs schedule <day> <HH:MM>, for example: schedule friday 13:00",
      );
    if (!readSettings())
      fail("There is no workspace on this computer to back up.");
    if (!offsite.confirmed || (!offsite.folder && !offsite.r2))
      fail(
        "Set up the backup key and a destination first: offsite.mjs key, then folder or r2.",
      );
    const before = readRecord().length;
    if (!installSchedule(day, Number(hour), Number(minute)))
      fail("The system did not accept the schedule.");
    writeOffsite({
      ...offsite,
      schedule: { day: DAYS[day], time: `${hour.padStart(2, "0")}:${minute}` },
    });
    console.log(
      `An encrypted backup now runs every ${DAYS[day]} at ${hour.padStart(2, "0")}:${minute}, or the next time the computer is on after that.\nIt is running once now, so anything the system needs to ask is asked while its owner is here…`,
    );
    // The first run starts by itself. A recent backup makes it a quick no-op.
    for (let waited = 0; waited < 900; waited += 3) {
      await sleep(3_000);
      const [run] = readRecord().slice(before);
      if (run?.ok)
        return console.log(`The first scheduled backup worked: ${run.file}`);
      if (run)
        fail(
          `The first scheduled backup did not work: ${run.error ?? JSON.stringify(run.sent)}`,
        );
      const last = readRecord().findLast(reached);
      if (
        waited >= 15 &&
        last &&
        Date.now() - new Date(last.at) < 6 * 86_400_000
      )
        return console.log(
          `A backup from ${when(last.at)} is recent enough, so this run had nothing to do.`,
        );
    }
    fail(
      "The first scheduled backup has not finished after fifteen minutes. If the computer is showing a question about access to a folder, its owner answers Allow. Then run offsite.mjs status.",
    );
  },

  async status() {
    console.log(
      !offsite.recipient
        ? "Backup key: not made yet (offsite.mjs key)"
        : offsite.confirmed
          ? `Backup key: made, and checked against the password manager on ${when(offsite.confirmed)}`
          : "Backup key: made, but not yet checked against the password manager (offsite.mjs key --check)",
    );
    if (offsite.folder)
      try {
        const names = backupsIn(offsite.folder);
        console.log(
          `Folder: ${offsite.folder} (${names.length} backups, newest: ${names.at(-1) ?? "none"})`,
        );
      } catch {
        console.log(
          `Folder: ${offsite.folder} (MISSING or unreadable right now)`,
        );
      }
    if (offsite.r2)
      try {
        const names = await backupsInBucket(bucket(offsite));
        console.log(
          `Cloudflare R2: bucket ${offsite.r2.bucket} (${names.length} backups, newest: ${names.at(-1) ?? "none"})`,
        );
      } catch (error) {
        console.log(
          `Cloudflare R2: bucket ${offsite.r2.bucket} (could not be reached: ${error.message})`,
        );
      }
    if (!offsite.folder && !offsite.r2)
      console.log(
        "Destination: none yet (offsite.mjs folder, or offsite.mjs r2)",
      );
    console.log(`Kept in each place: the newest ${keepCount(offsite)}`);
    const installed = scheduleInstalled();
    console.log(
      offsite.schedule
        ? `Schedule: every ${offsite.schedule.day} at ${offsite.schedule.time}${installed ? "" : " (NOT INSTALLED any more: run offsite.mjs schedule again)"}`
        : "Schedule: none (offsite.mjs schedule <day> <HH:MM>)",
    );
    const runs = readRecord();
    const good = runs.findLast((run) => run.ok);
    const bad = runs.findLast((run) => !run.ok);
    console.log(
      good
        ? `Last complete backup: ${when(good.at)}, ${good.file}, ${megabytes(good.bytes)}`
        : "Last complete backup: none yet",
    );
    if (bad && (!good || bad.at > good.at))
      console.log(
        `Last run FAILED: ${when(bad.at)}: ${
          bad.error ??
          Object.entries(bad.sent)
            .filter(([, result]) => result !== true)
            .map(([place, result]) => `${place}: ${result}`)
            .join("; ")
        }`,
      );
    if (
      offsite.schedule &&
      (!good || Date.now() - new Date(good.at) > 8 * 86_400_000)
    )
      console.log(
        "WARNING: no complete backup in the last eight days, although a weekly backup is scheduled.",
      );
  },
};

if (!commands[command])
  fail(
    "Usage: offsite.mjs key | folders | folder | r2 | keep | schedule | status. The top of this file explains each.",
  );
await commands[command]();
