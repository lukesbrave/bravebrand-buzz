import { useState, useSyncExternalStore } from "react";
import { npubEncode } from "nostr-tools/nip19";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { OnboardingScreen } from "../identity/OnboardingScreen";
import { PublicKeyPanel } from "../identity/PublicKeyPanel";
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
            <div className="mt-4 grid w-full max-w-md gap-4 text-left">
              <p className="m-0 text-body text-subtle">
                Setting up your own server? Give it this public key, so it knows
                you are the owner. When the server is ready, enter its address
                below.
              </p>
              <PublicKeyPanel publicKey={ownerKey} />
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
            <Field label="Invite link or community URL" error={error}>
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
              Join
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
