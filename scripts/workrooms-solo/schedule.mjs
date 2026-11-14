// The weekly encrypted backup, run by the system itself: a launch agent on
// macOS and a scheduled task on Windows, both for this login only. The kit is
// copied beside the workspace's settings first, so the schedule keeps working
// if the source checkout moves or is deleted.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { home, project } from "./common.mjs";
import { scheduleLog } from "./vault.mjs";

const windows = process.platform === "win32";
export const DAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];
const here = dirname(fileURLToPath(import.meta.url));
const kit = join(home, "kit");
// A workspace under another name (a test) gets a schedule of its own.
const suffix = project === "workrooms" ? "" : `.${project}`;
const label = `com.bravebrand.digitalhome.workrooms.backup${suffix}`;
const plist = join(homedir(), "Library/LaunchAgents", `${label}.plist`);
const task = `Digital Home Workrooms backup${suffix}`;
/** What the schedule passes on, so it finds the same workspace. */
const passed = ["WORKROOMS_HOME", "WORKROOMS_PROJECT"].filter(
  (name) => process.env[name],
);

function placeKit() {
  if (here === kit) return;
  rmSync(kit, { recursive: true, force: true });
  mkdirSync(kit, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(here))
    if (name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
      copyFileSync(join(here, name), join(kit, name));
}

const xml = (text) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const powershell = (script, env) =>
  spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { stdio: "inherit", windowsHide: true, env: { ...process.env, ...env } },
  ).status === 0;
const launchctl = (...args) =>
  spawnSync("/bin/launchctl", args, { stdio: "ignore" }).status === 0;
const domain = () => `gui/${process.getuid()}`;

/**
 * Runs the backup every week at this day and time, and once straight away.
 * A computer that was asleep or off at that time catches up when it is next
 * on: launchd runs a missed job on wake and this job at every sign-in, and
 * the task is set to start as soon as possible after a missed time. A run
 * that finds a recent backup does nothing. Returns true when installed.
 */
export function installSchedule(day, hour, minute) {
  placeKit();
  const script = join(kit, "backup.mjs");
  if (windows) {
    // PowerShell starts Node so that no window stays open during the run.
    const quoted = (text) => `'${text.replaceAll("'", "''")}'`;
    const run = [
      ...passed.map((name) => `$env:${name} = ${quoted(process.env[name])};`),
      `& ${quoted(process.execPath)} ${quoted(script)} --scheduled *> ${quoted(scheduleLog)}`,
    ].join(" ");
    return powershell(
      `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -Command "' + $env:WORKROOMS_RUN + '"')
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $env:WORKROOMS_DAY -At $env:WORKROOMS_TIME
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 6)
Register-ScheduledTask -TaskName $env:WORKROOMS_TASK -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $env:WORKROOMS_TASK`,
      {
        WORKROOMS_RUN: run,
        WORKROOMS_DAY: DAYS[day],
        WORKROOMS_TIME: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
        WORKROOMS_TASK: task,
      },
    );
  }
  const strings = (list) =>
    list.map((text) => `<string>${xml(text)}</string>`).join("");
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${strings([process.execPath, script, "--scheduled"])}</array>
<key>EnvironmentVariables</key><dict>${passed.map((name) => `<key>${name}</key>${strings([process.env[name]])}`).join("")}</dict>
<key>StartCalendarInterval</key><dict><key>Weekday</key><integer>${day}</integer><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>
<key>RunAtLoad</key><true/>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(scheduleLog)}</string>
<key>StandardErrorPath</key><string>${xml(scheduleLog)}</string>
</dict></plist>
`,
  );
  launchctl("bootout", `${domain()}/${label}`);
  return launchctl("bootstrap", domain(), plist);
}

export function removeSchedule() {
  if (windows)
    powershell(
      "Unregister-ScheduledTask -TaskName $env:WORKROOMS_TASK -Confirm:$false -ErrorAction SilentlyContinue",
      { WORKROOMS_TASK: task },
    );
  else {
    launchctl("bootout", `${domain()}/${label}`);
    rmSync(plist, { force: true });
  }
  rmSync(kit, { recursive: true, force: true });
}

/** True when the system still holds the schedule. */
export function scheduleInstalled() {
  if (windows)
    return (
      spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "if (Get-ScheduledTask -TaskName $env:WORKROOMS_TASK -ErrorAction SilentlyContinue) { exit 0 }; exit 1",
        ],
        {
          stdio: "ignore",
          windowsHide: true,
          env: { ...process.env, WORKROOMS_TASK: task },
        },
      ).status === 0
    );
  return existsSync(plist) && launchctl("print", `${domain()}/${label}`);
}
