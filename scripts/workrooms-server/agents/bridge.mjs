#!/usr/bin/env node
// Answers the Workrooms app's requests about agents that run on this server,
// so they appear in their owner's app as their own agents, running remotely.
// agents.sh runs it once per request: one JSON object on standard input, one
// JSON object on standard output. Only someone who can already log in to this
// server over SSH can reach it.
//
// Each agent is one container from the image agents.sh built (buzz-acp driving
// Codex), with its own key and its own work folder. Every agent shares the one
// Codex sign-in its owner made with `agents.sh sign-in`.
//
// An agent's key is made here and never leaves this server. Its owner's key is
// never sent here: the app sends only the owner's signed permission for this
// one agent (its NIP-OA `auth` tag), which the relay checks when the agent
// connects.
import { spawn, spawnSync } from "node:child_process";
import { createECDH, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";

const root = "/opt/workrooms";
const state = `${root}/agents/state`;
const IMAGE = "workrooms-helper:local";
const CODEX_HOME = "workrooms-codex:/home/helper/.codex";
const hex = /^[0-9a-f]{64}$/;

const need = (value, error) => {
  if (!value) throw Error(error);
};
/** True when text holds no control characters, so it fits one line. */
const plain = (text) =>
  ![...text].some((character) => character.charCodeAt(0) < 32);
let host;
let owner;
let community;
let HERE;
/** Reads which community this server hosts, and who owns it. */
function load() {
  const settings = Object.fromEntries(
    fs
      .readFileSync(`${root}/.env`, "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
  host = settings.BUZZ_DOMAIN;
  owner = settings.RELAY_OWNER_PUBKEY;
  need(
    /^[a-z0-9.-]+$/.test(host ?? "") && hex.test(owner ?? ""),
    "This server's community settings are incomplete.",
  );
  community = `wss://${host}`;
  // The public name reaches this server itself, never out through the internet.
  HERE = ["--add-host", `${host}:host-gateway`];
}

function write(path, value) {
  const tmp = `${path}.${randomBytes(8).toString("hex")}`;
  fs.writeFileSync(tmp, value, { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, path);
}
/** Runs docker; true when it succeeded. Its output is never returned. */
function docker(args, timeout = 20_000) {
  return spawnSync("docker", args, { stdio: "ignore", timeout }).status === 0;
}
// agents.sh records the sign-in here: asking Codex itself takes seconds, and the
// app allows each request five.
const signedIn = () => fs.existsSync(`${state}/signed-in`);
/** Starts a docker command and does not wait for it. */
function later(args) {
  spawn("docker", args, { detached: true, stdio: "ignore" }).unref();
}
const container = (pubkey) => `workrooms-agent-${pubkey.slice(0, 16)}`;

function validProfile(name, picture) {
  need(
    typeof name === "string" &&
      name.trim() &&
      name.length <= 150 &&
      plain(name),
    "Invalid agent name.",
  );
  if (picture)
    need(
      typeof picture === "string" && new URL(picture).protocol === "https:",
      "Invalid avatar address.",
    );
}
function validConfig(config = {}) {
  need(
    config !== null && typeof config === "object" && !Array.isArray(config),
    "Invalid agent configuration.",
  );
  const { instructions = "" } = config;
  need(
    typeof instructions === "string" &&
      Buffer.byteLength(instructions) <= 56_000,
    "Agent instructions must be text and fit within 56,000 bytes.",
  );
  return { instructions };
}
/** What every agent here is told, before its owner's own instructions. */
const standing = (name) =>
  `You are ${name}, an agent in your owner's private workspace. You run on their server, not on their computer, so you cannot open files on their computer; say so if asked for one. Deliver every answer with Buzz's reply tool in the conversation you were asked in: a model response alone is not delivered. Do not install software, change this server, spend money or publish anything outside this workspace.\n\n`;

/** The settings an agent's container starts with, one per line. */
function writeEnv(dir, fields) {
  for (const value of Object.values(fields))
    need(plain(value), "Invalid agent configuration.");
  write(
    `${dir}/env`,
    Object.entries(fields)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
}
const readEnv = (dir) =>
  Object.fromEntries(
    fs
      .readFileSync(`${dir}/env`, "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );

async function run(input) {
  load();
  if (input.op === "status")
    return {
      protocol: 1,
      community,
      instructions: true,
      harnesses: [["codex", "Codex"]],
      signedIn: signedIn(),
    };
  need(
    input.community === community,
    "This server belongs to another workspace.",
  );
  need((input.harness ?? "codex") === "codex", "Unknown server harness.");

  if (input.op === "provision") {
    validProfile(input.name, input.picture);
    validConfig(input.config);
    need(
      signedIn(),
      "Codex is not signed in on your server yet. Ask your coding agent to sign in the server's agents, then create this agent again.",
    );
    // An interrupted creation reuses its key until the app records the agent.
    const ticket = createHash("sha256").update(input.name).digest("hex");
    const index = `${state}/seat-${ticket}`;
    let pubkey;
    if (fs.existsSync(index)) pubkey = fs.readFileSync(index, "utf8");
    else {
      const pair = createECDH("secp256k1");
      pair.generateKeys();
      pubkey = pair.getPublicKey("hex", "compressed").slice(2);
      const dir = `${state}/${pubkey}`;
      fs.mkdirSync(`${dir}/seat`, { recursive: true, mode: 0o700 });
      write(`${dir}/private`, pair.getPrivateKey("hex").padStart(64, "0"));
      write(`${dir}/ticket`, ticket);
      write(index, pubkey);
    }
    write(`${state}/${pubkey}/picture`, input.picture || "");
    return { pubkey, ...(input.picture ? { picture: input.picture } : {}) };
  }

  need(hex.test(input.pubkey ?? ""), "Invalid agent identity.");
  const dir = `${state}/${input.pubkey}`;
  const name = container(input.pubkey);
  if (input.op === "remove") {
    if (!fs.existsSync(dir)) return {};
    docker(["rm", "-f", name]);
    docker(["volume", "rm", name]);
    const ticket = fs.readFileSync(`${dir}/ticket`, "utf8");
    if (hex.test(ticket)) fs.rmSync(`${state}/seat-${ticket}`, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    return {};
  }
  need(fs.existsSync(dir), "This agent is missing on the server.");
  const instructionsFile = `${dir}/seat/instructions.md`;

  if (input.op === "instructions" || input.op === "set-instructions") {
    need(fs.existsSync(`${dir}/auth`), "This agent was never started.");
    const title = fs.readFileSync(`${dir}/name`, "utf8");
    const previous = fs
      .readFileSync(instructionsFile, "utf8")
      .slice(standing(title).length);
    if (input.op === "instructions") return { instructions: previous };
    const { instructions } = validConfig({ instructions: input.instructions });
    if (previous !== instructions) {
      write(instructionsFile, standing(title) + instructions);
      fs.chmodSync(instructionsFile, 0o644);
      later(["restart", "-t", "2", name]);
    }
    return {};
  }

  need(["activate", "profile"].includes(input.op), "Unknown server operation.");
  validProfile(input.name, input.picture);
  if (input.op === "profile") {
    need(fs.existsSync(`${dir}/env`), "This agent was never started.");
    writeEnv(dir, {
      ...readEnv(dir),
      AGENT_NAME: input.name,
      AGENT_AVATAR: input.picture || "",
    });
    later(["restart", "-t", "2", name]);
    return {};
  }

  // activate: the owner's signed permission arrives, and the agent starts.
  const { instructions } = validConfig(input.config);
  const auth = input.auth;
  need(
    Array.isArray(auth) &&
      auth.length === 4 &&
      auth[0] === "auth" &&
      auth[1] === owner &&
      typeof auth[2] === "string" &&
      /^[0-9a-f]{128}$/.test(auth[3]),
    "This app's identity is not the owner of the workspace on this server.",
  );
  const secret = fs.readFileSync(`${dir}/private`, "utf8");
  write(`${dir}/auth`, JSON.stringify(auth));
  write(`${dir}/name`, input.name);
  write(instructionsFile, standing(input.name) + instructions);
  fs.chmodSync(`${dir}/seat`, 0o755);
  fs.chmodSync(instructionsFile, 0o644);
  writeEnv(dir, {
    BUZZ_RELAY_URL: community,
    BUZZ_PRIVATE_KEY: secret,
    BUZZ_AUTH_TAG: JSON.stringify(auth),
    BUZZ_ACP_AGENT_OWNER: owner,
    BUZZ_ACP_AGENT_COMMAND: "codex-acp",
    BUZZ_ACP_AGENT_ARGS: "",
    BUZZ_ACP_RESPOND_TO: "owner-only",
    BUZZ_ACP_SESSION_POLICY: "thread",
    BUZZ_ACP_LAZY_POOL: "true",
    BUZZ_ACP_SYSTEM_PROMPT_FILE: "/seat/instructions.md",
    RUST_LOG: "buzz_acp=info",
    // The agent publishes these as its profile each time it starts.
    AGENT_NAME: input.name,
    AGENT_AVATAR: fs.readFileSync(`${dir}/picture`, "utf8"),
  });
  docker(["rm", "-f", name], 4_000);
  need(
    docker(
      [
        "run",
        "-d",
        "--name",
        name,
        "--label",
        `workrooms.agent=${input.pubkey}`,
        "--restart",
        "unless-stopped",
        ...HERE,
        "--env-file",
        `${dir}/env`,
        "-v",
        CODEX_HOME,
        "-v",
        `${name}:/home/helper/workspace`,
        "-v",
        `${dir}/seat:/seat:ro`,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--memory",
        "1g",
        "--pids-limit",
        "256",
        IMAGE,
      ],
      4_000,
    ),
    "The agent could not be started on the server. Ask your coding agent to check the server's agents.",
  );
  return {};
}

try {
  const bytes = fs.readFileSync(0);
  need(bytes.length <= 65_536, "The request is too large.");
  console.log(JSON.stringify(await run(JSON.parse(bytes))));
} catch (error) {
  console.log(
    JSON.stringify({
      error:
        error instanceof Error && !error.code
          ? error.message
          : "The server's agents are not set up correctly.",
    }),
  );
}
