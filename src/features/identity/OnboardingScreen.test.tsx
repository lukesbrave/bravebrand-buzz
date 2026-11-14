// @vitest-environment jsdom
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OnboardingScreen } from "./OnboardingScreen";

afterEach(cleanup);

it("puts first-run card steps in the BraveBrand scope with the Digital Home mark", () => {
  render(
    <OnboardingScreen labelledBy="t" intro={<h1 id="t">Welcome</h1>}>
      {null}
    </OnboardingScreen>,
  );
  const main = screen.getByRole("main", { name: "Welcome" });
  expect(main.getAttribute("data-onboarding-scope")).toBe("");
  expect(screen.getByRole("img", { name: "Digital Home" })).toBeTruthy();
  expect(screen.queryByRole("img", { name: "Buzz" })).toBeNull();
});

it("moves the mark clear of the macOS window buttons, and only there", () => {
  const step = () =>
    render(
      <OnboardingScreen labelledBy="t" intro={<h1 id="t">Welcome</h1>}>
        {null}
      </OnboardingScreen>,
    );
  step();
  const mark = () => screen.getByRole("img", { name: "Digital Home" });
  expect(mark().hasAttribute("data-mac-window")).toBe(false);
  cleanup();
  // The desktop app on a Mac: macOS draws its buttons over the top-left corner.
  const host = globalThis as { isTauri?: boolean };
  host.isTauri = true;
  const platform = vi
    .spyOn(navigator, "platform", "get")
    .mockReturnValue("MacIntel");
  try {
    step();
    expect(mark().getAttribute("data-mac-window")).toBe("true");
  } finally {
    platform.mockRestore();
    delete host.isTauri;
  }
});

it("leaves the Buzz welcome variant outside the scope", () => {
  render(
    <OnboardingScreen welcome labelledBy="t" intro={<h1 id="t">Buzz</h1>}>
      {null}
    </OnboardingScreen>,
  );
  expect(
    screen
      .getByRole("main", { name: "Buzz" })
      .hasAttribute("data-onboarding-scope"),
  ).toBe(false);
});

/** Every source file under `src`, without tests. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|css)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

it("keeps BraveBrand colours inside first launch", () => {
  const root = join(process.cwd(), "src");
  const tokens = join(root, "shared/design-system/styles/tokens.css");
  const scoped = new Set([
    tokens,
    join(root, "features/identity/OnboardingScreen.tsx"),
  ]);
  for (const file of sources(root)) {
    if (scoped.has(file)) continue;
    const text = readFileSync(file, "utf8");
    expect(text, file).not.toMatch(
      /--brand-(sky|ink|navy)|data-onboarding-scope/,
    );
  }
  // In tokens.css the palette is read by --surface-onboarding (a role only
  // first run uses) and otherwise only inside the first-launch scope blocks.
  const css = readFileSync(tokens, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const scope =
    /^:root(:not\(\[data-color-mode="dark"\]\)|\[data-color-mode="dark"\]) \[data-onboarding-scope\]$/;
  for (const [, selector = "", body = ""] of css.matchAll(
    /([^{}]*)\{([^{}]*)\}/g,
  )) {
    if (scope.test(selector.trim())) continue;
    for (const line of body.split("\n"))
      if (/var\(--brand-(sky|ink|navy)/.test(line))
        expect(line.trim(), selector.trim()).toMatch(/^--surface-onboarding:/);
  }
});
