// Checks the local-workspace kit's platform pieces on a hosted runner, where
// Docker Desktop is not available: the name, the certificate and system trust.
//   node kit-check.mjs none|user|machine
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mode = process.argv[2] ?? "none";
process.env.WORKROOMS_HOME = join(process.env.RUNNER_TEMP ?? tmpdir(), `workrooms-home-${mode}`);
const kit = await import("../../scripts/workrooms-solo/common.mjs");
const windows = process.platform === "win32";
const run = (command, args) =>
  new Promise((done) => {
    let out = "";
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.on("error", (error) => done({ status: -1, out: error.message }));
    child.on("close", (status) => done({ status, out: out.trim() }));
  });
let failed = false;
const report = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed = true;
};

console.log(`platform ${process.platform} ${process.arch}, node ${process.version}, home ${kit.home}`);
const addresses = await lookup(kit.HOST, { all: true }).catch((error) => error.message);
report(`${kit.HOST} resolves to this computer`, Array.isArray(addresses) && addresses.every((a) => ["127.0.0.1", "::1"].includes(a.address)), JSON.stringify(addresses));

kit.makeCertificate();
report("certificate made", kit.certificateDaysLeft() > 800, `${kit.certificateDaysLeft()} days`);
const server = createServer(
  { cert: readFileSync(join(kit.certs, "workspace.crt")), key: readFileSync(join(kit.certs, "workspace.key")) },
  (request, response) => response.end('{"self":"check"}'),
);
await new Promise((ready) => server.listen(18480, "127.0.0.1", ready));
const own = await kit.reach(18480, "/").catch((error) => ({ status: 0, text: error.message }));
report("kit's own check reaches it through the certificate", own.status === 200, own.text);

report("not trusted before the trust step", kit.certificateTrusted() === false);
if (mode === "user") {
  // The real step. On a desktop Windows shows a confirmation; here it shows what happens with nobody to answer.
  const started = Date.now();
  const added = kit.trustCertificate();
  console.log(`trustCertificate returned ${added} after ${Date.now() - started} ms`);
}
if (mode === "machine" && windows) {
  const added = await run("certutil.exe", ["-addstore", "Root", join(kit.certs, "authority.crt")]);
  report("authority added to the machine store (stand-in for the user store)", added.status === 0, added.out.split("\n").slice(-2).join(" | "));
}
if (mode !== "none") {
  report("trusted after the trust step", kit.certificateTrusted() === true);
  const url = `https://${kit.HOST}:18480/`;
  if (windows) {
    const curl = await run("curl.exe", ["-sS", "--ssl-no-revoke", "-o", "NUL", "-w", "%{http_code}", url]);
    report("curl with Windows trust", curl.out === "200", curl.out);
    const web = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Invoke-WebRequest -UseBasicParsing '${url}').StatusCode`]);
    report("PowerShell web request with Windows trust", web.out === "200", web.out.slice(0, 300));
  }
}
server.close();
process.exit(failed ? 1 : 0);
