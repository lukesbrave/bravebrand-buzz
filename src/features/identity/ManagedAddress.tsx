import { type ReactNode, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";

export function ManagedAddress({
  onReady,
  children,
}: {
  onReady: (url: string) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [ip, setIp] = useState("");
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function connect() {
    setBusy(true);
    setError("");
    try {
      const url = await invoke<string>("workrooms_address_setup", {
        ip: ip.trim(),
        slug: slug.trim(),
      });
      onReady(url);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  if (!open)
    return (
      <>
        {children}
        <Button onClick={() => setOpen(true)}>
          Set up a VPS without a domain
        </Button>
      </>
    );
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) void connect();
      }}
    >
      <Field label="VPS IPv4 address">
        <Input
          required
          value={ip}
          placeholder="From your server overview"
          disabled={busy}
          onChange={(e) => setIp(e.target.value)}
        />
      </Field>
      <Field
        label="Workspace address"
        description={
          slug
            ? `${slug}.workrooms.bravebrand.com`
            : "Choose the first part of your Workrooms address."
        }
      >
        <Input
          required
          value={slug}
          pattern="[a-z][a-z0-9\-]{0,38}[a-z0-9]"
          placeholder="your-company"
          disabled={busy}
          onChange={(e) => setSlug(e.target.value.toLowerCase())}
        />
      </Field>
      <p className="text-body-sm text-subtle">
        Use a fresh Ubuntu VPS you’ve already connected to over SSH. Choose its
        key, then enter your Skool access link in Terminal. Setup installs your
        community and enables HTTPS on your server.
      </p>
      {error && <p role="alert">{error}</p>}
      <Button type="submit" variant="prominent" disabled={busy}>
        {busy ? "Setting up your VPS…" : "Set up my VPS"}
      </Button>
      <Button type="button" disabled={busy} onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </form>
  );
}
