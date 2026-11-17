import { expect, it } from "vitest";
import type { HostProcessOptions } from "../../features/host/service";
import { ClaudeSetup } from "./setup";
import { WorkroomsClaudeAuth } from "./workrooms-auth";

/** A `claude` that is signed out until `claude auth login` has run. */
function claude() {
  const calls: string[] = [];
  let signedIn = false;
  const spawn = async (id: string, options: HostProcessOptions = {}) => {
    const command = `${id} ${(options.args ?? []).join(" ")}`.trim();
    calls.push(command);
    let stdout = "";
    let code = 0;
    if (command === "claude --version") stdout = "2.1.280 (Claude Code)\n";
    else if (command === "claude auth status --json") {
      stdout = JSON.stringify({ loggedIn: signedIn });
      code = signedIn ? 0 : 1;
    } else if (command === "claude auth login") {
      signedIn = true;
      stdout = "Opening browser…\n";
    }
    queueMicrotask(() => {
      if (stdout) options.onStdout?.(stdout);
    });
    return {
      write: async () => undefined,
      end: async () => undefined,
      kill: async () => undefined,
      exited: new Promise<number | null>((resolve) =>
        setTimeout(() => resolve(code), 0),
      ),
    };
  };
  return { spawn, calls };
}

it("asks for a Claude sign-in rather than an API key while signed out", async () => {
  const { spawn } = claude();
  const setup = new ClaudeSetup(
    spawn,
    undefined,
    new WorkroomsClaudeAuth(spawn),
  );
  await setup.check();
  expect(setup.snapshot().status).toEqual({
    state: "signed-out",
    version: "2.1.280",
  });
  expect(setup.providerSnapshot()).toEqual({
    readiness: "attention",
    attentionLabel: "Sign in to Claude",
  });
});

it("signs in with claude auth login and is ready once Claude reports the account", async () => {
  const { spawn, calls } = claude();
  const setup = new ClaudeSetup(
    spawn,
    undefined,
    new WorkroomsClaudeAuth(spawn),
  );
  await setup.check();
  const run = setup.run("sign-in");
  expect(setup.snapshot().running).toBe("sign-in");
  await run;
  expect(setup.snapshot()).toMatchObject({
    running: undefined,
    output: "Opening browser…\n",
    status: { state: "ready", version: "2.1.280" },
  });
  expect(calls).toContain("claude auth login");
  // Claude runs on the account it just signed in to, with no key given.
  expect(setup.auth.usesOwnSetup).toBe(true);
});
