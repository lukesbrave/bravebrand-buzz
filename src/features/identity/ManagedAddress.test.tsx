// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { ManagedAddress } from "./ManagedAddress";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

it("keeps existing addresses accessible, recovers from setup failure, and discovers only a ready server", async () => {
  const ready = vi.fn();
  render(
    <ManagedAddress onReady={ready}>
      <p>Existing community</p>
    </ManagedAddress>,
  );
  fireEvent.click(screen.getByText("Set up a VPS without a domain"));
  expect(screen.queryByText("Existing community")).toBeNull();
  fireEvent.change(screen.getByLabelText("VPS IPv4 address"), {
    target: { value: "65.21.191.20" },
  });
  fireEvent.change(screen.getByLabelText("Workspace address"), {
    target: { value: "Acme" },
  });
  vi.mocked(invoke).mockRejectedValueOnce("Name unavailable");
  fireEvent.click(screen.getByText("Set up my VPS"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Name unavailable",
  );
  expect(ready).not.toHaveBeenCalled();
  vi.mocked(invoke).mockResolvedValueOnce(
    "https://acme.workrooms.bravebrand.com",
  );
  fireEvent.click(screen.getByText("Set up my VPS"));
  await vi.waitFor(() =>
    expect(ready).toHaveBeenCalledWith("https://acme.workrooms.bravebrand.com"),
  );
  expect(invoke).toHaveBeenCalledWith("workrooms_address_setup", {
    ip: "65.21.191.20",
    slug: "acme",
  });
});
