// Shared by setup.mjs, backup.mjs and restore.mjs: where the workspace on this
// computer keeps its settings, how Docker is reached, the certificate, and the
// checks that prove the workspace answers as itself. macOS and Windows.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:https";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const windows = process.platform === "win32";

/**
 * The one name every system resolves to itself. A name under .localhost reads
 * better but Windows does not resolve it (checked on a hosted Windows runner).
 */
export const HOST = "localhost";
export const home =
  process.env.WORKROOMS_HOME ||
  (windows
    ? join(
        process.env.LOCALAPPDATA || join(homedir(), "AppData/Local"),
        "Workrooms Local Workspace",
      )
    : join(homedir(), "Library/Application Support/Workrooms Local Workspace"));
export const project = process.env.WORKROOMS_PROJECT || "workrooms";
export const settingsFile = join(home, ".env");
export const certs = join(home, "certs");
export const IMAGE =
  "ghcr.io/block/buzz@sha256:690016ca465e439e2c58213fdfe8a094073ddbe80de75baec74b0a39de54ab38";
// Some registries serve a release by tag but reject a cold digest lookup.
// Cache the tagged images. Compose still selects the reviewed digests.
export const TAGS = [
  "ghcr.io/block/buzz:sha-2c5c834",
  "caddy:2-alpine",
  "postgres:17-alpine",
  "redis:7-alpine",
  "pgsty/mc:RELEASE.2026-09-16T00-00-00Z",
  "pgsty/silo:RELEASE.2026-09-16T00-00-00Z",
];

/** Already fetched for the database; also supplies tar for volume copies. */
export const TOOLS = "postgres:17-alpine";

export const fail = (message) => {
  console.error(message);
  process.exit(1);
};
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Docker Desktop's own copy of the command, which is there even when the
// installer has not yet put it on PATH.
const dockerRoot = windows
  ? join(process.env.ProgramFiles || "C:/Program Files", "Docker/Docker")
  : "/Applications/Docker.app";
const dockerApp = windows ? join(dockerRoot, "Docker Desktop.exe") : dockerRoot;
const dockerBin = windows
  ? join(dockerRoot, "resources/bin/docker.exe")
  : `${dockerRoot}/Contents/Resources/bin/docker`;
const dockerPath = existsSync(dockerBin) ? dockerBin : "docker";
const dockerEnv = (extra = {}) => ({
  ...process.env,
  ...extra,
  PATH: `${dirname(dockerPath)}${delimiter}${process.env.PATH}`,
});

/**
 * Runs docker. `capture` returns stdout; `from` and `to` are open files used
 * as its input and output; otherwise output goes to the terminal.
 */
export function docker(
  args,
  { capture = false, env, from, to, check = true } = {},
) {
  const result = spawnSync(dockerPath, args, {
    stdio: [from ?? "ignore", to ?? (capture ? "pipe" : "inherit"), "inherit"],
    env: dockerEnv(env),
    encoding: "utf8",
  });
  if (result.error) {
    if (!check) return undefined;
    fail(`Could not run Docker: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (!check) return undefined;
    process.exit(result.status ?? 1);
  }
  return capture ? result.stdout : "";
}

const engineUp = () =>
  spawnSync(dockerPath, ["info", "--format", "{{.ServerVersion}}"], {
    stdio: "ignore",
    env: dockerEnv(),
  }).status === 0;

/** Starts Docker Desktop if it is installed and stopped, then waits for it. */
export async function ensureDocker() {
  if (engineUp()) return;
  if (!existsSync(dockerApp))
    fail(
      "Docker Desktop is not installed. Install it from https://www.docker.com/products/docker-desktop/, open it once so its owner can accept the terms, then run this again.",
    );
  console.log("Starting Docker Desktop…");
  if (windows)
    spawn(dockerApp, [], { detached: true, stdio: "ignore" }).unref();
  else spawnSync("/usr/bin/open", ["-ga", dockerApp]);
  for (let waited = 0; waited < 180; waited += 3) {
    if (engineUp()) return;
    await sleep(3_000);
  }
  fail(
    "Docker Desktop did not finish starting. Open Docker Desktop, finish anything it asks for, then run this again.",
  );
}

/** True when Docker Desktop is set to open when its owner signs in. */
export function dockerStartsAtLogin() {
  try {
    const file = windows
      ? join(
          process.env.APPDATA || join(homedir(), "AppData/Roaming"),
          "Docker/settings-store.json",
        )
      : join(
          homedir(),
          "Library/Group Containers/group.com.docker/settings-store.json",
        );
    return JSON.parse(readFileSync(file, "utf8")).AutoStart === true;
  } catch {
    return undefined;
  }
}

export function readSettings() {
  if (!existsSync(settingsFile)) return undefined;
  return Object.fromEntries(
    readFileSync(settingsFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
}

export function writeSettings(values) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(
    settingsFile,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    { mode: 0o600 },
  );
}

/** The address lines of the settings for a port on this computer. */
export function addressSettings(port) {
  const authority = `${HOST}:${port}`;
  return {
    BUZZ_DOMAIN: authority,
    RELAY_URL: `wss://${authority}`,
    BUZZ_MEDIA_BASE_URL: `https://${authority}/media`,
    BUZZ_MEDIA_SERVER_DOMAIN: authority,
    BUZZ_CORS_ORIGINS: `https://${authority}`,
    WORKROOMS_PORT: String(port),
  };
}

/** The workspace's files live beside its settings, so it keeps running if the
 * source checkout moves. */
export function placeFiles() {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const here = (name) => fileURLToPath(new URL(name, import.meta.url));
  copyFileSync(
    here("../local-community/compose.yml"),
    join(home, "compose.yml"),
  );
  copyFileSync(here("./compose.solo.yml"), join(home, "compose.solo.yml"));
  copyFileSync(here("./Caddyfile"), join(home, "Caddyfile"));
}

/** Removes only what this kit wrote, for a restore that did not finish. */
export function removeFiles() {
  for (const name of ["compose.yml", "compose.solo.yml", "Caddyfile", ".env"])
    rmSync(join(home, name), { force: true });
  rmSync(certs, { recursive: true, force: true });
}

export function compose(args, options = {}) {
  const settings = readSettings();
  return docker(
    [
      "compose",
      "-p",
      project,
      "--env-file",
      settingsFile,
      "-f",
      join(home, "compose.yml"),
      "-f",
      join(home, "compose.solo.yml"),
      ...args,
    ],
    { ...options, env: { ...settings, WORKROOMS_ENV: settingsFile } },
  );
}

const leafFile = join(certs, "workspace.crt");
const authorityFile = join(certs, "authority.crt");

/** Days until the workspace's certificate expires, or 0 without one. */
export function certificateDaysLeft() {
  if (!existsSync(leafFile) || !existsSync(authorityFile)) return 0;
  const until = new X509Certificate(readFileSync(leafFile)).validToDate;
  return Math.floor((until.getTime() - Date.now()) / 86_400_000);
}

/** macOS ships OpenSSL. On Windows, Git for Windows carries one, and Git is
 * what fetched this checkout. */
function opensslPath() {
  if (!windows) return "/usr/bin/openssl";
  try {
    const core = execFileSync("git", ["--exec-path"], { encoding: "utf8" });
    const bundled = resolve(core.trim(), "../../../usr/bin/openssl.exe");
    if (existsSync(bundled)) return bundled;
  } catch {
    // Fall through to whatever PATH offers.
  }
  return "openssl";
}

/**
 * Makes the certificate for HOST. A one-off authority signs it and its private
 * key is deleted before this returns, so the authority this computer is later
 * asked to trust can never vouch for any other name. macOS accepts at most
 * 825 days.
 */
export function makeCertificate() {
  const work = mkdtempSync(join(tmpdir(), "workrooms-cert-"));
  const tool = opensslPath();
  const openssl = (args) =>
    execFileSync(tool, args, { cwd: work, stdio: "pipe" });
  try {
    const made = new Date().toISOString().slice(0, 10);
    // LibreSSL (macOS) ignores -subj when the config sets prompt = no, so
    // each certificate's name lives in its own config.
    const config = (file, name, extensions) =>
      writeFileSync(
        join(work, file),
        `[req]\ndistinguished_name = name\nprompt = no\n[name]\nCN = ${name}\n[extensions]\n${extensions}\n`,
      );
    config(
      "authority.cnf",
      `Workrooms on this computer ${made}`,
      "basicConstraints = critical, CA:TRUE, pathlen:0\nkeyUsage = critical, keyCertSign\nsubjectKeyIdentifier = hash",
    );
    config(
      "workspace.cnf",
      HOST,
      `basicConstraints = critical, CA:FALSE\nkeyUsage = critical, digitalSignature\nextendedKeyUsage = serverAuth\nsubjectAltName = DNS:${HOST}\nauthorityKeyIdentifier = keyid`,
    );
    const key = (name) =>
      openssl([
        "ecparam",
        "-name",
        "prime256v1",
        "-genkey",
        "-noout",
        "-out",
        name,
      ]);
    key("authority.key");
    openssl([
      "req",
      "-x509",
      "-new",
      "-key",
      "authority.key",
      "-sha256",
      "-days",
      "820",
      "-config",
      "authority.cnf",
      "-extensions",
      "extensions",
      "-out",
      "authority.crt",
    ]);
    key("workspace.key");
    openssl([
      "req",
      "-new",
      "-key",
      "workspace.key",
      "-config",
      "workspace.cnf",
      "-out",
      "workspace.csr",
    ]);
    openssl([
      "x509",
      "-req",
      "-in",
      "workspace.csr",
      "-CA",
      "authority.crt",
      "-CAkey",
      "authority.key",
      "-CAcreateserial",
      "-sha256",
      "-days",
      "820",
      "-extfile",
      "workspace.cnf",
      "-extensions",
      "extensions",
      "-out",
      "workspace.crt",
    ]);
    rmSync(join(work, "authority.key"));
    mkdirSync(certs, { recursive: true, mode: 0o700 });
    for (const name of ["authority.crt", "workspace.crt", "workspace.key"])
      copyFileSync(join(work, name), join(certs, name));
    chmodSync(join(certs, "workspace.key"), 0o600);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** True when this login trusts the workspace's certificate for HTTPS. */
export function certificateTrusted() {
  if (windows)
    // Builds the chain against the Windows certificate stores, as the app does.
    return (
      spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$c = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($env:WORKROOMS_CERTIFICATE); $chain = [System.Security.Cryptography.X509Certificates.X509Chain]::new(); $chain.ChainPolicy.RevocationMode = 'NoCheck'; if ($chain.Build($c)) { exit 0 }; exit 1",
        ],
        {
          stdio: "ignore",
          env: { ...process.env, WORKROOMS_CERTIFICATE: leafFile },
        },
      ).status === 0
    );
  return (
    spawnSync(
      "/usr/bin/security",
      ["verify-cert", "-c", leafFile, "-p", "ssl", "-n", HOST, "-L", "-q"],
      { stdio: "ignore" },
    ).status === 0
  );
}

/**
 * Asks the system to trust the workspace's authority for this login only.
 * macOS asks the person for their password or Touch ID; Windows shows a
 * security warning with Yes and No.
 */
export function trustCertificate() {
  const [tool, args] = windows
    ? ["certutil.exe", ["-user", "-addstore", "Root", authorityFile]]
    : [
        "/usr/bin/security",
        [
          "add-trusted-cert",
          "-r",
          "trustRoot",
          "-p",
          "ssl",
          "-k",
          join(homedir(), "Library/Keychains/login.keychain-db"),
          authorityFile,
        ],
      ];
  return spawnSync(tool, args, { stdio: "inherit" }).status === 0;
}

/** Trusts the certificate unless this login already does. `retry` says how
 * to try again if the person declines. */
export function ensureTrusted(retry) {
  if (process.env.WORKROOMS_TRUST === "skip" || certificateTrusted()) return;
  console.log(
    `${
      windows
        ? "Windows will now show a security warning about installing a certificate; its owner chooses Yes."
        : "macOS will now ask for this Mac's password or Touch ID."
    } It is asking to trust the certificate that keeps the connection to ${HOST} private.`,
  );
  if (!trustCertificate() || !certificateTrusted())
    fail(
      `The certificate was not trusted, so the app could not connect. ${retry}`,
    );
}

/** One HTTPS request to the workspace, verified against its own authority. */
export function reach(port, path, { method = "GET", headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const call = request(
      {
        host: HOST,
        port,
        path,
        method,
        headers,
        ca: readFileSync(authorityFile),
        timeout: 10_000,
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode, text }),
        );
      },
    );
    call.on("timeout", () => call.destroy(new Error("timed out")));
    call.on("error", reject);
    call.end(body);
  });
}

/**
 * What the app's first connection depends on, checked from this computer: the
 * address answers as this workspace, refuses an anonymous read and hides its
 * operator routes.
 */
export async function checkWorkspace(port, identity) {
  const origin = `https://${HOST}:${port}`;
  let self;
  for (let waited = 0; waited <= 60 && self !== identity; waited += 3) {
    self = await reach(port, "/", {
      headers: { Accept: "application/nostr+json" },
    }).then(
      (answer) => JSON.parse(answer.text).self,
      () => undefined,
    );
    if (self !== identity) await sleep(3_000);
  }
  if (self !== identity)
    fail(
      `${origin} is not answering as this workspace. Run the same command again.`,
    );
  const anonymous = await reach(port, "/query", { method: "POST", body: "{}" });
  if (anonymous.status !== 401)
    fail(
      `Expected ${origin} to refuse an anonymous read, got ${anonymous.status}.`,
    );
  const operator = await reach(port, "/operator/communities");
  if (operator.status !== 404)
    fail(`Expected ${origin} to hide operator routes, got ${operator.status}.`);
  return origin;
}
