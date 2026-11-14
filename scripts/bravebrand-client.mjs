// Builds the self-hosted client with the Node, pnpm and Rust already on PATH,
// for Windows, where Hermit's bin/ tools do not run. macOS uses
// bravebrand-client.sh; both apply the same settings and configs.
//
//   node scripts/bravebrand-client.mjs [--rehearsal] [tauri build options]
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const rehearsal = args[0] === "--rehearsal";
if (rehearsal) args.shift();
const windows = process.platform === "win32";

function run(command, list) {
  const result = spawnSync(command, list, {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdio: "inherit",
    // pnpm is a .cmd shim on Windows, which only a shell can start.
    shell: windows,
    env: {
      ...process.env,
      // Empty, not unset: an unset build compiles in the default sign-in server.
      BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG: "",
      BUZZ_BUILDERLAB_URL: "",
      VITE_BRAVEBRAND_SELF_HOSTED: "true",
    },
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

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
