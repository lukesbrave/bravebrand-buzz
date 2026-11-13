import { useState, useSyncExternalStore } from "react";
import { npubEncode } from "nostr-tools/nip19";
import { writeClipboardText } from "../../shared/clipboard";
import { CopyIcon } from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { OnboardingScreen } from "../identity/OnboardingScreen";
import type { SettingsCards } from "../settings/service";
import { CommunityDialog } from "./CommunityDialog";
import type { FederatedIdentity } from "../federated-identity/service";
import {
  type InviteLink,
  parsePastedInvite,
  pastedInviteError,
} from "./invite-link";
import type { JoinRequest } from "./invite-intent";
import type { Communities } from "./service";

/** First run with no community: joining replaces the empty shell. */
export function CommunityLanding({
  communities,
  federatedIdentity,
  invite,
  onInviteClose,
  settingsCards,
  onJoined,
  onCreate,
  selfHosted = import.meta.env.VITE_BRAVEBRAND_SELF_HOSTED === "true",
}: {
  communities: Communities;
  federatedIdentity?: FederatedIdentity | undefined;
  invite?: (JoinRequest & { requestId: number }) | undefined;
  onInviteClose(requestId: number): void;
  settingsCards: Pick<SettingsCards, "subscribe" | "has">;
  onJoined(id: string): void;
  onCreate(): void;
  /**
   * A build for servers people run themselves: such a server admits its owner
   * by key, so the landing shows this device's public key.
   */
  selfHosted?: boolean;
}) {
  // The app re-renders the landing whenever the client's viewer changes.
  const viewer = selfHosted ? communities.snapshot().viewer : undefined;
  const ownerKey = viewer ? npubEncode(viewer) : undefined;
  const [copy, setCopy] = useState<"copied" | "failed">();
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const [joining, setJoining] = useState<InviteLink>();
  const hostedAvailable = useSyncExternalStore(settingsCards.subscribe, () =>
    settingsCards.has("block.builderlab/login"),
  );
  const opened = invite ?? joining;
  if (opened)
    return (
      <CommunityDialog
        key={invite ? invite.requestId : `${opened.community} ${opened.code}`}
        communities={communities}
        federatedIdentity={federatedIdentity}
        mode="join"
        onboarding
        submittedDestination={!invite || invite.submitted === true}
        invite={opened}
        onJoined={onJoined}
        close={() => {
          setJoining(undefined);
          if (invite) onInviteClose(invite.requestId);
        }}
      />
    );
  return (
    <OnboardingScreen
      labelledBy="community-landing-title"
      intro={
        <>
          <h1 id="community-landing-title" className="text-heading">
            {ownerKey ? "Connect your workspace" : "Join a community"}
          </h1>
          {ownerKey && (
            <div className="mt-4 grid w-full max-w-md gap-2 text-left">
              <h2 className="m-0 text-label text-standard">
                1. Copy this code and send it to your coding agent
              </h2>
              <div
                className="flex items-center gap-2 p-3"
                style={{
                  background: "var(--affordance-subtle)",
                  borderRadius: "var(--radius-control)",
                }}
              >
                <code className="min-w-0 flex-1 select-text break-all font-mono text-mono">
                  {ownerKey}
                </code>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Copy code"
                  onClick={() =>
                    writeClipboardText(ownerKey).then(
                      () => setCopy("copied"),
                      () => setCopy("failed"),
                    )
                  }
                >
                  <CopyIcon size={16} aria-hidden="true" />
                  {copy === "copied" ? "Copied" : "Copy"}
                </Button>
              </div>
              <span
                role="status"
                className={
                  copy === "failed" ? "text-body-sm text-subtle" : "sr-only"
                }
              >
                {copy === "copied"
                  ? "Code copied."
                  : copy === "failed"
                    ? "Could not copy. Select the code to copy it."
                    : ""}
              </span>
            </div>
          )}
          <form
            className="mt-4 grid w-full max-w-md gap-4 text-left"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              const parsed = parsePastedInvite(link);
              if (parsed) setJoining(parsed);
              else
                setError(
                  pastedInviteError(
                    link,
                    "Paste an invite link or community URL.",
                  ),
                );
            }}
          >
            <Field
              label={
                ownerKey ? (
                  // The same weight as step 1's heading.
                  <span className="text-label">
                    2. Paste the workspace address your agent sends back
                  </span>
                ) : (
                  "Invite link or community URL"
                )
              }
              error={error}
            >
              <Input
                autoFocus
                value={link}
                spellCheck={false}
                autoComplete="off"
                placeholder="https://"
                onChange={(event) => {
                  setLink(event.target.value);
                  setError("");
                }}
              />
            </Field>
            <Button
              type="submit"
              size="lg"
              variant="prominent"
              disabled={!link.trim()}
            >
              {ownerKey ? "Connect" : "Join"}
            </Button>
          </form>
        </>
      }
    >
      {hostedAvailable && (
        <Button size="lg" variant="subtle" onClick={onCreate}>
          Create a community
        </Button>
      )}
    </OnboardingScreen>
  );
}
