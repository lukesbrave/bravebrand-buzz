// Sets up a Workrooms workspace on this computer, reachable only from this
// computer. No domain, no rented server. macOS and Windows. Run it twice:
//
//   bin/node scripts/workrooms-solo/setup.mjs
//     starts Docker Desktop if needed and fetches the workspace software
//     (safe before a key exists)
//
//   bin/node scripts/workrooms-solo/setup.mjs npub1…
//     creates the workspace with that owner, starts it and checks it
//
// The npub is the public key the app shows after "Create my key". No private
// key is read or printed. Rerun the same command after an interruption, after
// a Docker update, or when the app cannot reach the workspace.
//
// The second run makes a certificate for localhost and asks the
// system to trust it: macOS asks the person for their password or Touch ID,
// Windows shows a security warning to confirm. WORKROOMS_TRUST=skip leaves
// that out, for automated tests only.
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import {
  addressSettings,
  certificateDaysLeft,
  checkWorkspace,
  compose,
  decodeNpub,
  docker,
  dockerStartsAtLogin,
  encodeNpub,
  ensureDocker,
  ensureTrusted,
  fail,
  home,
  IMAGE,
  makeCertificate,
  newSecretKey,
  placeFiles,
  publicKey,
  readSettings,
  TAGS,
  writeSettings,
} from "./common.mjs";

const [rawOwner] = process.argv.slice(2);
const owner = /^[0-9a-f]{64}$/.test(rawOwner ?? "")
  ? rawOwner
  : decodeNpub(rawOwner ?? "");
if (rawOwner && !owner)
  fail(
    "That is not a public key. Copy the key starting with npub1 from the app. Never paste a key starting with nsec.",
  );

await ensureDocker();
for (const tag of TAGS)
  if (
    docker(["image", "inspect", tag], { capture: true, check: false }) ===
    undefined
  )
    docker(["pull", tag]);
const startsAtLogin = dockerStartsAtLogin();

if (!owner) {
  console.log(
    "Workspace software ready. When the app shows the owner's public key, run this again with it as the last argument.",
  );
  if (startsAtLogin === false)
    console.log(
      "Docker Desktop is not set to open at login. Have its owner turn on Settings → General → Start Docker Desktop when you sign in to your computer.",
    );
  process.exit(0);
}

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const portFree = (port) =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });

let settings = readSettings();
if (!settings) {
  const port = Number(process.env.WORKROOMS_PORT || 18480);
  if (!(await portFree(port)))
    fail(
      `Port ${port} on this computer is in use. Run this again with WORKROOMS_PORT set to a free port, such as ${port + 1}.`,
    );
  settings = {
    ...addressSettings(port),
    BUZZ_REQUIRE_AUTH_TOKEN: "true",
    BUZZ_REQUIRE_RELAY_MEMBERSHIP: "true",
    BUZZ_ALLOW_NIP_OA_AUTH: "true",
    BUZZ_AUTO_MIGRATE: "true",
    BUZZ_PUSH_ENABLED: "false",
    BUZZ_IMAGE: IMAGE,
    RELAY_OWNER_PUBKEY: owner,
    BUZZ_RELAY_PRIVATE_KEY: newSecretKey(),
    BUZZ_GIT_HOOK_HMAC_SECRET: hex(randomBytes(32)),
    POSTGRES_PASSWORD: hex(randomBytes(24)),
    REDIS_PASSWORD: hex(randomBytes(24)),
    BUZZ_S3_ACCESS_KEY: hex(randomBytes(12)),
    BUZZ_S3_SECRET_KEY: hex(randomBytes(24)),
    BUZZ_S3_BUCKET: "buzz-media",
  };
  writeSettings(settings);
}
if (settings.RELAY_OWNER_PUBKEY !== owner)
  fail(
    "This computer's workspace already has a different owner key. Nothing was changed.",
  );
const port = Number(settings.WORKROOMS_PORT);

placeFiles();
// Renew a month early: the app refuses an expired certificate outright.
const renewed = certificateDaysLeft() < 30;
if (renewed) makeCertificate();
ensureTrusted("Run the same command again and approve the prompt.");

compose(["up", "-d", "--wait"]);
// The gateway reads the certificate when it starts.
if (renewed) compose(["restart", "gateway"]);
const origin = await checkWorkspace(
  port,
  publicKey(settings.BUZZ_RELAY_PRIVATE_KEY),
);

console.log(
  `Workspace ready: ${origin}\nOwner: ${encodeNpub(owner)}\nSettings and certificate: ${home}\nCertificate valid for ${certificateDaysLeft()} more days; running this command again renews it.\nEnter ${origin} in the app to connect.`,
);
if (startsAtLogin === false)
  console.log(
    "Docker Desktop is not set to open at login, so the workspace would stay off after a restart. Have its owner turn on Settings → General → Start Docker Desktop when you sign in to your computer.",
  );
