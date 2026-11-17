// How a Workrooms build signs in to Claude: with the person's Claude account,
// through the interactive sign-in `ClaudeAuth.signIn` leaves to a build. The
// rest is `ClaudeAuth` unchanged: a setup already on the computer is used as
// it is, and an API key still works.
import { ClaudeAuth, type Step } from "./auth";

/** Whether this build is a Workrooms one, as `scripts/bravebrand-client.sh`
 * builds it. */
export const WORKROOMS = import.meta.env.VITE_BRAVEBRAND_SELF_HOSTED === "true";

/** Claude's credentials, with `claude auth login` as the sign-in: it opens
 * the person's browser, and the check after it finds the setup it made. */
export class WorkroomsClaudeAuth extends ClaudeAuth {
  override readonly attentionLabel = "Sign in to Claude";
  override readonly needs = "needs a Claude sign-in or an API key";
  override readonly signIn = (step: Step) =>
    step("claude", ["auth", "login"], "Claude sign-in");
}
