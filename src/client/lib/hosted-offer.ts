import type { AuthStatus } from "./bootstrap";
import { hostedSignInUrl, parseHostedSignupUrl } from "../../shared/hosted-offer";

/**
 * Whether the landing page offers OpenPing Hosted's free trial or its
 * waitlist, from the HOSTED_SIGNUP_URL the server reports (shared/hosted-offer.ts).
 * Parsed again here, so a bad value never shows a trial button that goes nowhere.
 */
export type HostedOffer =
  | { open: false }
  | {
      open: true;
      /** The platform's sign-up page: every "Start a free trial" button. */
      signupUrl: string;
      /** The platform's sign-in page, for customers who already have an account. */
      signInUrl: string;
      /** Where Hosted accounts live, for the "who runs it" line (app.example.com). */
      host: string;
    };

export const HOSTED_CLOSED: HostedOffer = { open: false };

export function hostedOffer(status: Pick<AuthStatus, "hostedSignupUrl"> | null): HostedOffer {
  const signupUrl = parseHostedSignupUrl(status?.hostedSignupUrl);
  if (!signupUrl) return HOSTED_CLOSED;
  return { open: true, signupUrl, signInUrl: hostedSignInUrl(signupUrl), host: new URL(signupUrl).host };
}
