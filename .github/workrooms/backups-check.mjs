// Hosted-machine evidence for the encrypted backup kit. Not part of the kit.
//   node .github/workrooms/backups-check.mjs interop <path to age>
//   node .github/workrooms/backups-check.mjs secrets
//   node .github/workrooms/backups-check.mjs schedule
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [mode, tool] = process.argv.slice(2);
const dir = mkdtempSync(join(tmpdir(), "backups-check-"));
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed++;
};
const kit = (name) => import(new URL(`../../scripts/workrooms-solo/${name}`, import.meta.url));
const collect = async (stream) => { const parts = []; for await (const part of stream) parts.push(part); return Buffer.concat(parts); };
const one = async function* (buffer) { yield buffer; };

if (mode === "interop") {
  const { encrypt, decrypt, newKeyPair } = await kit("age.mjs");
  const { PARTS, seal, unseal, cloudFolders } = await kit("vault.mjs");
  console.log(execFileSync(tool, ["--version"], { encoding: "utf8" }).trim());
  const pair = newKeyPair();
  const keyFile = join(dir, "key.txt");
  writeFileSync(keyFile, `${pair.secret}\n`, { mode: 0o600 });
  for (const size of [0, 1, 65535, 65536, 65537, 300000]) {
    const plain = randomBytes(size);
    const ours = join(dir, `ours-${size}.age`);
    writeFileSync(ours, await collect(encrypt(pair.recipient, one(plain))));
    const out = join(dir, `ours-${size}.out`);
    execFileSync(tool, ["-d", "-i", keyFile, "-o", out, ours]);
    // Older age tools write no file at all for empty contents.
    check(`this kit -> age tool, ${size} bytes`, (existsSync(out) ? readFileSync(out) : Buffer.alloc(0)).equals(plain));
    const plainFile = join(dir, `plain-${size}`);
    writeFileSync(plainFile, plain);
    const theirs = join(dir, `theirs-${size}.age`);
    execFileSync(tool, ["-r", pair.recipient, "-o", theirs, plainFile]);
    check(`age tool -> this kit, ${size} bytes`, (await collect(decrypt(pair.secret, one(readFileSync(theirs))))).equals(plain));
  }
  // A whole backup file, opened with the age tool and the system's tar alone.
  const original = join(dir, "original");
  mkdirSync(original);
  for (const [at, name] of PARTS.entries()) writeFileSync(join(original, name), randomBytes([40, 900, 3_000_000, 512, 0][at]));
  const file = join(dir, "Workrooms backup 2026-11-14 0900.tar.age");
  await seal(original, pair.recipient, file);
  const tar = join(dir, "opened.tar");
  execFileSync(tool, ["-d", "-i", keyFile, "-o", tar, file]);
  const byTools = join(dir, "by-tools");
  mkdirSync(byTools);
  execFileSync("tar", ["-xf", tar, "-C", byTools]);
  check("a backup file opens with age and tar alone", PARTS.every((name) => readFileSync(join(byTools, name)).equals(readFileSync(join(original, name)))), readdirSync(byTools).join(" "));
  const byKit = join(dir, "by-kit");
  mkdirSync(byKit);
  await unseal(file, pair.secret, byKit);
  check("and with this kit", PARTS.every((name) => readFileSync(join(byKit, name)).equals(readFileSync(join(original, name)))));
  console.log("cloud folders found here:", JSON.stringify(cloudFolders()));
}

if (mode === "secrets") {
  const s = await kit("secrets.mjs");
  const text = "AGE-SECRET-KEY-1NOTAREALKEYJUSTACHECK";
  check("clipboard takes text", s.copyToClipboard(text));
  check("clipboard gives it back", s.readClipboard() === text, `read ${s.readClipboard().length} characters`);
  s.clearClipboardLater(2);
  await new Promise((done) => setTimeout(done, 12000));
  check("a backup key left on the clipboard is cleared later", s.readClipboard() === "");
  s.copyToClipboard("something of the owner's");
  s.clearClipboardLater(1);
  await new Promise((done) => setTimeout(done, 10000));
  check("anything else on the clipboard is left alone", s.readClipboard() === "something of the owner's");
  s.clearClipboard();
  check("clipboard clears", s.readClipboard() === "");
  const secret = randomBytes(32).toString("hex");
  check("credential store keeps a secret", s.storeSecret("r2", secret));
  check("and gives it back", s.readSecret("r2") === secret);
  const other = randomBytes(32).toString("hex");
  check("replaces it", s.storeSecret("r2", other) && s.readSecret("r2") === other);
  if (process.platform === "win32")
    console.log(spawnSync("cmdkey", ["/list:com.bravebrand.digitalhome.workrooms.backup*"], { encoding: "utf8" }).stdout.replace(/\r/g, "").trim());
  s.deleteSecret("r2");
  check("deletes it", s.readSecret("r2") === undefined);
}

if (mode === "schedule") {
  // A stand-in workspace: settings, a checked key and a folder, but no Docker
  // workspace behind it, so the first scheduled run must fail and say why.
  const home = process.env.WORKROOMS_HOME;
  mkdirSync(home, { recursive: true });
  const { newKeyPair } = await kit("age.mjs");
  writeFileSync(join(home, ".env"), "BUZZ_DOMAIN=localhost:18480\nWORKROOMS_PORT=18480\n");
  mkdirSync(join(home, "dest"));
  writeFileSync(join(home, "offsite.json"), JSON.stringify({ recipient: newKeyPair().recipient, confirmed: new Date().toISOString(), folder: join(home, "dest") }));
  const run = (...args) => spawnSync(process.execPath, [new URL("../../scripts/workrooms-solo/offsite.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), ...args], { encoding: "utf8", timeout: 1_200_000 });
  const installed = run("schedule", "friday", "13:00");
  console.log(installed.stdout, installed.stderr);
  const record = existsSync(join(home, "backup-record.json")) ? JSON.parse(readFileSync(join(home, "backup-record.json"), "utf8")) : [];
  check("the scheduled run happened by itself and left a record", record.length === 1 && record[0].scheduled === true && record[0].ok === false, JSON.stringify(record));
  check("the schedule command reported that failure", installed.status === 1 && /did not work/.test(installed.stderr));
  check("the kit was copied beside the settings", existsSync(join(home, "kit", "backup.mjs")));
  console.log("schedule log:", existsSync(join(home, "backup-schedule.log")) ? readFileSync(join(home, "backup-schedule.log")).toString("utf8").replace(/\0/g, "").slice(0, 1500) : "(none)");
  const status = run("status");
  console.log(status.stdout);
  check("status says the schedule is installed and the last run failed", /Schedule: every friday at 13:00\n/.test(status.stdout.replace(/\r/g, "")) && /Last run FAILED/.test(status.stdout));
  if (process.platform === "win32")
    console.log(spawnSync("powershell.exe", ["-NoProfile", "-Command", "Get-ScheduledTask -TaskName 'Digital Home Workrooms backup*' | ForEach-Object { $_.TaskName; $_.Triggers | Format-List DaysOfWeek, StartBoundary, WeeksInterval; $_.Settings | Format-List StartWhenAvailable, ExecutionTimeLimit; $_.Actions | Format-List Execute, Arguments; $_.Principal | Format-List UserId, LogonType, RunLevel }"], { encoding: "utf8" }).stdout);
  const off = run("schedule", "off");
  console.log(off.stdout, off.stderr);
  const after = run("status");
  check("schedule off removes it", /Schedule: none/.test(after.stdout) && !existsSync(join(home, "kit")));
}
process.exit(failed ? 1 : 0);
