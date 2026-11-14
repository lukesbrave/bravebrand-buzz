// How a secret travels between its owner and this kit without passing through
// a chat, a command line or a file: the clipboard, in both directions, and the
// system's credential store (the Keychain on macOS, Credential Manager on
// Windows) for the one secret an unattended backup needs. Nothing here prints
// a secret. Secrets reach the system tools on their input, never as arguments,
// because arguments are visible to other programs.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { project } from "./common.mjs";

const windows = process.platform === "win32";
const powershell = (script, { input, env } = {}) =>
  spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      input,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, ...env },
    },
  );

// macOS: marked as concealed, which clipboard-history tools honour.
const MAC_COPY = `ObjC.import("AppKit");
function run() {
  const input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const text = $.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding);
  const board = $.NSPasteboard.generalPasteboard;
  board.clearContents;
  board.setStringForType(text, "public.utf8-plain-text");
  board.setStringForType("", "org.nspasteboard.ConcealedType");
}`;
// Windows: kept out of clipboard history and the cloud clipboard.
const WINDOWS_COPY = `Add-Type -AssemblyName System.Windows.Forms
$text = [Console]::In.ReadToEnd()
$data = New-Object System.Windows.Forms.DataObject
$data.SetText($text)
foreach ($name in 'ExcludeClipboardContentFromMonitorProcessing', 'CanIncludeInClipboardHistory', 'CanUploadToCloudClipboard') {
  $data.SetData($name, (New-Object System.IO.MemoryStream(, [BitConverter]::GetBytes([int]0))))
}
[System.Windows.Forms.Clipboard]::SetDataObject($data, $true)`;

/** Puts text on the clipboard. True when it is there. */
export function copyToClipboard(text) {
  if (windows) return powershell(WINDOWS_COPY, { input: text }).status === 0;
  if (
    spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", MAC_COPY], {
      input: text,
    }).status === 0
  )
    return true;
  return spawnSync("/usr/bin/pbcopy", [], { input: text }).status === 0;
}

/** The clipboard's text, or "" when it holds none. */
export function readClipboard() {
  const result = windows
    ? powershell("[Console]::Out.Write((Get-Clipboard -Raw))")
    : spawnSync("/usr/bin/pbpaste", [], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

export function clearClipboard() {
  if (windows)
    powershell(
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear()",
    );
  else spawnSync("/usr/bin/pbcopy", [], { input: "" });
}

/**
 * Clears the clipboard after a delay if it still holds a backup key, from a
 * process of its own so the command that copied the key can finish.
 */
export function clearClipboardLater(seconds) {
  spawn(process.execPath, [fileURLToPath(import.meta.url), String(seconds)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await new Promise((done) => setTimeout(done, Number(process.argv[2]) * 1000));
  if (readClipboard().startsWith("AGE-SECRET-KEY-1")) clearClipboard();
}

// One entry per workspace, beside the app's own entries.
const SERVICE = "com.bravebrand.digitalhome.workrooms.backup";
const entry = (name) => `${project}.${name}`;
/** Only text that needs no quoting anywhere it is handed on. */
export const storable = (secret) => /^[A-Za-z0-9+/=_-]{16,200}$/.test(secret);

const WINDOWS_STORE = `Add-Type -Namespace Workrooms -Name Store -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct Credential { public int Flags; public int Type; public string TargetName; public string Comment; public long LastWritten; public int BlobSize; public IntPtr Blob; public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool CredWrite(ref Credential credential, int flags);
[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool CredDelete(string target, int type, int flags);
[DllImport("advapi32.dll")] public static extern void CredFree(IntPtr buffer);
'@
$target = $env:WORKROOMS_ENTRY
switch ($env:WORKROOMS_ACTION) {
  'store' {
    $bytes = [Text.Encoding]::Unicode.GetBytes([Console]::In.ReadToEnd().Trim())
    $credential = New-Object 'Workrooms.Store+Credential'
    $credential.Type = 1
    $credential.Persist = 2
    $credential.TargetName = $target
    $credential.UserName = 'backup'
    $credential.BlobSize = $bytes.Length
    $credential.Blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $credential.Blob, $bytes.Length)
    $stored = [Workrooms.Store]::CredWrite([ref]$credential, 0)
    [Runtime.InteropServices.Marshal]::FreeHGlobal($credential.Blob)
    if (-not $stored) { exit 1 }
  }
  'read' {
    $found = [IntPtr]::Zero
    if (-not [Workrooms.Store]::CredRead($target, 1, 0, [ref]$found)) { exit 1 }
    $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($found, [type]'Workrooms.Store+Credential')
    [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringUni($credential.Blob, $credential.BlobSize / 2))
    [Workrooms.Store]::CredFree($found)
  }
  'delete' { [void][Workrooms.Store]::CredDelete($target, 1, 0) }
}`;
const windowsStore = (action, name, input) =>
  powershell(WINDOWS_STORE, {
    input,
    env: {
      WORKROOMS_ACTION: action,
      WORKROOMS_ENTRY: `${SERVICE}.${entry(name)}`,
    },
  });

/** Keeps a secret in the credential store under a name. True when stored. */
export function storeSecret(name, secret) {
  if (!storable(secret)) return false;
  if (windows) return windowsStore("store", name, secret).status === 0;
  // The security tool reads commands from its input in this mode.
  return (
    spawnSync("/usr/bin/security", ["-i"], {
      input: `add-generic-password -U -s "${SERVICE}" -a "${entry(name)}" -w "${secret}"\n`,
      stdio: ["pipe", "ignore", "ignore"],
    }).status === 0 && readSecret(name) === secret
  );
}

/** The secret stored under a name, or undefined. */
export function readSecret(name) {
  const result = windows
    ? windowsStore("read", name)
    : spawnSync(
        "/usr/bin/security",
        ["find-generic-password", "-s", SERVICE, "-a", entry(name), "-w"],
        { encoding: "utf8" },
      );
  return result.status === 0 && result.stdout.trim()
    ? result.stdout.trim()
    : undefined;
}

export function deleteSecret(name) {
  if (windows) windowsStore("delete", name);
  else
    spawnSync(
      "/usr/bin/security",
      ["delete-generic-password", "-s", SERVICE, "-a", entry(name)],
      { stdio: "ignore" },
    );
}
