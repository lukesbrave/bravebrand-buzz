// Builds the self-hosted client where bravebrand-client.sh cannot: Windows,
// which has no Hermit bin/ tools, and Intel Macs, for which Hermit has no
// pnpm. It applies the same settings and configs as that script.
//
//   node scripts/bravebrand-client.mjs [--rehearsal] [tauri build options]
//
// Run it with Node 24. On a Mac that is bin/node, and Rust comes from bin/
// too; on Windows, Node and Rust are installed first.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const rehearsal = args[0] === "--rehearsal";
if (rehearsal) args.shift();
const windows = process.platform === "win32";
const root = fileURLToPath(new URL("../", import.meta.url));

// The pnpm version package.json names is installed with the npm beside this
// Node into a folder of its own, which goes first on PATH. This Node's own
// folder comes next: bin/node is a Hermit launcher that puts bin/ back at the
// front for everything it starts, and bin/pnpm is the tool that may not run.
const tools = join(root, "target", "workrooms-tools");
const launchers = windows ? tools : join(tools, "bin");
const bin = join(root, "bin");
const env = {
  ...process.env,
  PATH: [
    launchers,
    dirname(process.execPath),
    ...(!windows && existsSync(bin) ? [bin] : []),
    process.env.PATH,
  ].join(delimiter),
  // Empty, not unset: an unset build compiles in the default sign-in server.
  BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG: "",
  BUZZ_BUILDERLAB_URL: "",
  VITE_BRAVEBRAND_SELF_HOSTED: "true",
};

function run(command, list) {
  const result = spawnSync(command, list, {
    cwd: root,
    stdio: "inherit",
    // Launchers are .cmd files on Windows, which only a shell can start.
    shell: windows,
    env,
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// The Windows shell splits unquoted paths at spaces.
const path = (value) => (windows ? `"${value}"` : value);
const { packageManager } = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
);
run(path(join(dirname(process.execPath), "npm")), [
  "install",
  "--global",
  "--prefix",
  path(tools),
  "--no-fund",
  "--no-audit",
  packageManager,
]);
run("pnpm", ["install", "--frozen-lockfile"]);
run("pnpm", [
  "tauri",
  "build",
  "--debug",
  "--bundles",
  windows ? "nsis" : "app",
  "--config",
  `src-tauri/tauri.bravebrand-${rehearsal ? "rehearsal" : "client"}.conf.json`,
  ...args,
]);
