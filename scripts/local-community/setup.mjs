import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

const host = process.argv[2]?.toLowerCase();
if (
  !host ||
  host.length > 253 ||
  !host.includes(".") ||
  !host
    .split(".")
    .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
) {
  throw new Error("Supply the new community hostname in your Cloudflare zone.");
}

const root = join(
  homedir(),
  "Library/Application Support/BraveBrand Workrooms Local Server",
);
const settings = join(root, ".env");
const compose = fileURLToPath(new URL("./compose.yml", import.meta.url));
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const dockerApp = "/Applications/Docker.app/Contents/Resources/bin/docker";
const docker = existsSync(dockerApp) ? dockerApp : "docker";
function run(args, extraEnv = {}) {
  const result = spawnSync(docker, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      ...extraEnv,
      PATH: dirname(docker) + ":" + process.env.PATH,
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(["info", "--format", "{{.ServerVersion}}"]);
// Some registries serve a release by tag but reject a cold digest lookup.
// Cache the tagged images. Compose below still selects the reviewed digests.
for (const tag of [
  "ghcr.io/block/buzz:sha-2c5c834",
  "caddy:2-alpine",
  "pgsty/mc:RELEASE.2026-09-16T00-00-00Z",
  "pgsty/silo:RELEASE.2026-09-16T00-00-00Z",
]) {
  const cached = spawnSync(docker, ["image", "inspect", tag], {
    stdio: "ignore",
  });
  if (cached.status !== 0) run(["pull", tag]);
}
if (!existsSync(root)) {
  mkdirSync(dirname(root), { recursive: true });
  const stage = mkdtempSync(root + ".new-");
  try {
    const owner = generateSecretKey();
    const values = {
      BUZZ_DOMAIN: host,
      RELAY_URL: "wss://" + host,
      BUZZ_MEDIA_BASE_URL: "https://" + host + "/media",
      BUZZ_MEDIA_SERVER_DOMAIN: host,
      BUZZ_CORS_ORIGINS: "https://" + host,
      BUZZ_REQUIRE_AUTH_TOKEN: "true",
      BUZZ_REQUIRE_RELAY_MEMBERSHIP: "true",
      BUZZ_ALLOW_NIP_OA_AUTH: "true",
      BUZZ_AUTO_MIGRATE: "true",
      BUZZ_PUSH_ENABLED: "false",
      BUZZ_IMAGE:
        "ghcr.io/block/buzz@sha256:690016ca465e439e2c58213fdfe8a094073ddbe80de75baec74b0a39de54ab38",
      RELAY_OWNER_PUBKEY: getPublicKey(owner),
      BUZZ_RELAY_PRIVATE_KEY: hex(generateSecretKey()),
      BUZZ_GIT_HOOK_HMAC_SECRET: hex(randomBytes(32)),
      POSTGRES_PASSWORD: hex(randomBytes(24)),
      REDIS_PASSWORD: hex(randomBytes(24)),
      BUZZ_S3_ACCESS_KEY: hex(randomBytes(12)),
      BUZZ_S3_SECRET_KEY: hex(randomBytes(24)),
      BUZZ_S3_BUCKET: "buzz-media",
    };
    writeFileSync(join(stage, "owner.txt"), nip19.nsecEncode(owner), {
      mode: 0o600,
    });
    writeFileSync(
      join(stage, ".env"),
      Object.entries(values)
        .map(([k, v]) => k + "=" + v)
        .join("\n") + "\n",
      { mode: 0o600 },
    );
    renameSync(stage, root);
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true });
  }
}
const config = Object.fromEntries(
  readFileSync(settings, "utf8")
    .trim()
    .split("\n")
    .map((line) => line.split("=")),
);
if (config.BUZZ_DOMAIN !== host)
  throw new Error(
    "This Mac already hosts a community at " + config.BUZZ_DOMAIN,
  );
run(
  [
    "compose",
    "-p",
    "bravebrand-workrooms-local",
    "--env-file",
    settings,
    "-f",
    compose,
    "up",
    "-d",
    "--wait",
  ],
  { ...config, WORKROOMS_ENV: settings },
);
const discovery = JSON.parse(
  execFileSync(
    "/usr/bin/curl",
    [
      "--noproxy",
      "*",
      "--fail",
      "--silent",
      "--show-error",
      "--max-time",
      "10",
      "-H",
      "Host: " + host,
      "-H",
      "Accept: application/nostr+json",
      "http://127.0.0.1:18479/",
    ],
    { encoding: "utf8" },
  ),
);
if (
  discovery.self !==
  getPublicKey(Buffer.from(config.BUZZ_RELAY_PRIVATE_KEY, "hex"))
) {
  throw new Error("Local relay identity check failed.");
}
console.log(
  "Local community ready. Point the Cloudflare Tunnel at http://127.0.0.1:18479. Owner file for in-app import: " +
    join(root, "owner.txt"),
);
