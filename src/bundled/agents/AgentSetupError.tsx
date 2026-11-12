import { useState } from "react";
import { writeClipboardText } from "../../shared/clipboard";
import { Button } from "../../shared/design-system/ui/Button";

// The paired VPS adapter sends a plain Error across the plugin boundary.
// Only its fixed helper and one public agent key are valid clipboard input.
const signInHint =
  /sign in on the VPS with (\/opt\/bravebrand\/buzz-pilot\/hires\/sign-in [0-9a-f]{64}), then finish setup/;

export function AgentSetupError({
  message,
  name,
  type,
  reveal,
}: {
  message: string;
  name: string;
  type: string | undefined;
  reveal?: (element: HTMLElement | null) => void;
}) {
  const [copyState, setCopyState] = useState<"ready" | "copied" | "failed">(
    "ready",
  );
  const command =
    type === "bravebrand.hire/vps-claude"
      ? signInHint.exec(message)?.[1]
      : undefined;

  if (!command) {
    return (
      <p
        ref={reveal}
        role="alert"
        className="m-0 wrap-anywhere text-body-sm text-danger"
      >
        {message}
      </p>
    );
  }

  async function copy(text: string) {
    try {
      await writeClipboardText(text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <div ref={reveal} className="grid min-w-0 justify-items-start gap-2">
      <p role="alert" className="m-0 wrap-anywhere text-body-sm text-danger">
        Sign in to Claude on your VPS to finish setting up {name}.
      </p>
      <Button variant="subtle" size="sm" onClick={() => void copy(command)}>
        {copyState === "copied" ? "Copied" : "Copy sign-in command"}
      </Button>
      <p role="status" className="m-0 text-body-sm text-secondary">
        {copyState === "failed"
          ? "Select the command below and copy it into your VPS terminal."
          : "Run the command in your VPS terminal."}
      </p>
      {copyState === "failed" && (
        <code className="select-text wrap-anywhere text-body-sm">
          {command}
        </code>
      )}
    </div>
  );
}
