import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Fingerprint, Github, Loader2, Mail, MailCheck } from "lucide-react";
import { api } from "../lib/api";
import { useBootstrap } from "../lib/bootstrap";
import { isLandingInstall } from "../lib/home";
import {
  conditionalMediationAvailable,
  getPasskey,
  hostMatchesRpId,
  passkeyErrorMessage,
  passkeysSupported,
  type RequestOptionsJSON,
} from "../lib/webauthn";

/**
 * The admin sign-in, shared by /login and the landing page's owner sign-in
 * dialog (docs/LANDING_AND_LOGIN_PLAN.md, section 2). It says whose OpenPing
 * this is, shows only the sign-in methods this install has set up, and gives
 * anyone who isn't the admin somewhere useful to go instead.
 */

const OPENPING_SITE = "https://openping.n8builds.dev";

const linkClass = "font-semibold text-ink underline decoration-ink-faint underline-offset-4 hover:decoration-accent";

/** The next step for someone who wanted their own OpenPing, not this one. */
function OwnOpenPingLinks({ landing }: { landing: boolean }) {
  return landing ? (
    <>
      <Link to="/install" className={linkClass}>
        deploy it free
      </Link>{" "}
      or{" "}
      <a href="/#pricing" className={linkClass}>
        join the Hosted waitlist
      </a>
    </>
  ) : (
    <a href={OPENPING_SITE} className={linkClass}>
      get your own at openping.n8builds.dev
    </a>
  );
}

const RETRYABLE = new Set(["state_invalid", "state_missing", "state_expired", "invalid_callback"]);

/** What went wrong on the way back from a sign-in, and what to do next. */
function errorMessage(error: string, landing: boolean): ReactNode {
  switch (error) {
    case "not_authorized":
      return (
        <>
          That account isn't this OpenPing's administrator, so it can't sign in here. If you wanted your own
          OpenPing, <OwnOpenPingLinks landing={landing} />.
        </>
      );
    case "github_not_configured":
      return "GitHub sign-in isn't set up on this OpenPing.";
    case "rate_limited":
      return "Too many sign-in attempts. Give it a minute and try again.";
    case "state_invalid":
    case "state_expired":
      return "Sign-in took too long and expired.";
    case "state_missing":
      return "Your sign-in session wasn't found. The link may be stale, or another tab started a new sign-in.";
    case "invalid_callback":
      return "The sign-in response from GitHub was incomplete.";
    case "token_exchange_failed":
      return "Couldn't finish signing in with GitHub. Please try again.";
    case "identity_failed":
      return "Couldn't read your GitHub account. Please try again.";
    case "magic_invalid":
      return "That sign-in link has expired or was already used. Request a new one below.";
    default:
      return "Sign-in didn't work. Please try again.";
  }
}

/**
 * Passkey sign-in: a button, plus the browser's autofill on the email field
 * where it supports conditional mediation. One request at a time: the button
 * aborts a pending autofill request before it starts its own.
 */
function usePasskeySignIn(enabled: boolean, autofill: boolean) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);

  const run = useCallback(async (conditional: boolean) => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    if (!conditional) {
      setBusy(true);
      setError(null);
    }
    try {
      const { options } = await api<{ options: RequestOptionsJSON }>("/api/auth/passkeys/login/options", {
        method: "POST",
        json: {},
        signal: controller.signal,
      });
      const credential = await getPasskey(options, { conditional, signal: controller.signal });
      await api("/api/auth/passkeys/login/verify", { method: "POST", json: { credential } });
      // Same landing as the GitHub and email flows: a fresh load of the dashboard.
      window.location.assign("/");
    } catch (err) {
      // A superseded or unmounted request is not an error worth showing.
      if (controller.signal.aborted) return;
      if (!conditional || !(err instanceof DOMException)) setError(passkeyErrorMessage(err));
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!conditional) setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled || !autofill) return;
    let cancelled = false;
    void conditionalMediationAvailable().then((ok) => {
      if (ok && !cancelled) void run(true);
    });
    return () => {
      cancelled = true;
      pending.current?.abort();
    };
  }, [enabled, autofill, run]);

  return { busy, error, signIn: () => void run(false) };
}

export function SignInPanel({
  titleId,
  titleAs: Title = "h1",
  error,
  onNavigate,
}: {
  /** The heading's id, for a dialog's aria-labelledby. */
  titleId?: string;
  titleAs?: "h1" | "h2";
  /** The `?error=` code a sign-in redirect came back with. */
  error?: string | null;
  /** Called when one of the "not the admin" links is followed (a dialog closes itself). */
  onNavigate?: () => void;
}) {
  const { status } = useBootstrap();
  const githubEnabled = status?.githubEnabled ?? false;
  const emailEnabled = status?.emailAdminConfigured ?? false;
  const landing = isLandingInstall(status);
  const host = typeof window === "undefined" ? "" : window.location.host;
  // Passkeys are bound to one hostname (the install's address), so they are
  // offered only there; elsewhere (say, the workers.dev address of an install
  // on its own domain) a note points to it.
  const passkeyConfigured = !!status?.passkeyConfigured && passkeysSupported();
  const passkeyHere = passkeyConfigured && hostMatchesRpId(status?.passkeyRpId);
  const passkeyElsewhere = passkeyConfigured && !passkeyHere && !!status?.passkeyRpId;
  const passkey = usePasskeySignIn(passkeyHere, emailEnabled);

  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  async function requestMagicLink(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) {
      setEmailError("Enter the admin's email address.");
      return;
    }
    setSubmitting(true);
    setEmailError(null);
    try {
      // The server answers { ok: true } whether or not the address is the
      // admin's, so the confirmation is the same either way.
      await api("/api/auth/magic/request", { method: "POST", json: { email } });
      setSent(true);
    } catch (err) {
      setEmailError(
        err instanceof Error && err.message === "validation"
          ? "That doesn't look like an email address."
          : "Couldn't send a sign-in link. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <Title id={titleId} className="text-center text-lg font-semibold tracking-tight text-ink">
        Sign in to this OpenPing
      </Title>
      {host && (
        <p className="mt-2 flex justify-center">
          <span className="max-w-full truncate rounded-md border border-line bg-canvas/60 px-2 py-0.5 font-mono text-xs text-ink-muted">
            {host}
          </span>
        </p>
      )}
      <p className="mt-3 text-center text-sm leading-relaxed text-ink-muted">
        This OpenPing is run by its owner in their own Cloudflare account. Only its administrator can sign in.
      </p>

      {error && (
        <p role="alert" className="mt-4 rounded-lg border border-down/40 bg-down/10 px-3 py-2.5 text-sm leading-relaxed text-ink">
          {errorMessage(error, landing)}
          {githubEnabled && RETRYABLE.has(error) && (
            <>
              {" "}
              <a href="/auth/github/start" className={linkClass}>
                Try again
              </a>
            </>
          )}
        </p>
      )}

      <div className="mt-6 space-y-3">
        {passkeyHere && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={passkey.signIn}
              disabled={passkey.busy}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-ink px-4 text-sm font-semibold text-canvas transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {passkey.busy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Fingerprint className="size-4" aria-hidden />
              )}
              Sign in with a passkey
            </button>
            {passkey.error && (
              <p role="alert" className="text-center text-sm text-down">
                {passkey.error}
              </p>
            )}
          </div>
        )}

        {passkeyElsewhere && (
          <p className="rounded-lg border border-line bg-surface-2/60 px-3 py-2.5 text-center text-sm leading-relaxed text-ink-muted">
            Passkeys for this OpenPing work at{" "}
            <a href={`${status?.passkeyOrigin ?? `https://${status?.passkeyRpId}`}/login`} className={linkClass}>
              {status?.passkeyRpId}
            </a>
            .
          </p>
        )}

        {passkeyHere && (githubEnabled || emailEnabled) && (
          <div className="flex items-center gap-3 text-xs text-ink-faint" aria-hidden="true">
            <span className="h-px flex-1 bg-line" />
            or
            <span className="h-px flex-1 bg-line" />
          </div>
        )}

        {githubEnabled && (
          <a
            href="/auth/github/start"
            className={
              passkeyHere
                ? "flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-line bg-surface-2 px-4 text-sm font-semibold text-ink transition-colors hover:bg-line"
                : "flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-ink px-4 text-sm font-semibold text-canvas transition-opacity hover:opacity-90"
            }
          >
            <Github className="size-4" aria-hidden />
            Continue with GitHub
          </a>
        )}

        {githubEnabled && emailEnabled && (
          <div className="flex items-center gap-3 text-xs text-ink-faint" aria-hidden="true">
            <span className="h-px flex-1 bg-line" />
            or
            <span className="h-px flex-1 bg-line" />
          </div>
        )}

        {emailEnabled &&
          (sent ? (
            <div role="status" className="rounded-lg border border-up/40 bg-up/10 px-3.5 py-3 text-sm leading-relaxed text-ink">
              <p className="flex items-center gap-2 font-semibold">
                <MailCheck className="size-4 shrink-0 text-up" aria-hidden />
                Check your email
              </p>
              <p className="mt-1 text-ink-muted">
                If that's this OpenPing's admin address, a sign-in link is on its way. It works once, for 15 minutes:
                open it on this device. Nothing after a minute? Check your spam folder.
              </p>
            </div>
          ) : (
            <form onSubmit={(e) => void requestMagicLink(e)} noValidate className="space-y-2">
              <label htmlFor="signin-email" className="sr-only">
                Admin email address
              </label>
              <input
                id="signin-email"
                type="email"
                // "webauthn" lets the browser offer passkeys in this field's autofill.
                autoComplete={passkeyHere ? "email webauthn" : "email"}
                inputMode="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                aria-invalid={emailError ? true : undefined}
                aria-describedby={emailError ? "signin-email-error" : undefined}
                className="input h-11"
              />
              <button
                type="submit"
                disabled={submitting}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-line bg-surface-2 px-4 text-sm font-semibold text-ink transition-colors hover:bg-line disabled:opacity-60"
              >
                {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Mail className="size-4" aria-hidden />}
                Email me a sign-in link
              </button>
              {emailError && (
                <p id="signin-email-error" className="text-center text-sm text-down">
                  {emailError}
                </p>
              )}
            </form>
          ))}

        {status && !githubEnabled && !emailEnabled && !passkeyConfigured && (
          <p className="rounded-lg border border-line bg-surface-2/60 px-3 py-2.5 text-center text-sm text-ink-muted">
            No sign-in method is set up on this OpenPing yet. Its owner adds a passkey, GitHub or an email address in
            the setup wizard.
          </p>
        )}

        {passkeyHere && (
          <p className="text-center text-xs text-ink-faint">
            Lost your passkey?{" "}
            <Link to="/recover" onClick={onNavigate} className="underline underline-offset-4 hover:text-ink">
              Recover access
            </Link>
          </p>
        )}
      </div>

      <div className="mt-6 border-t border-line pt-5 text-center text-sm text-ink-muted">
        <p className="text-balance">Not the admin? You can't make an account here.</p>
        <p className="mt-3 flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
          {landing ? (
            <>
              <Link to="/install" onClick={onNavigate} className="inline-flex items-center gap-1 font-semibold text-accent hover:text-accent-hover">
                Deploy free to your Cloudflare
                <ArrowRight className="size-3.5" aria-hidden />
              </Link>
              <a href="/#pricing" onClick={onNavigate} className="inline-flex items-center gap-1 font-semibold text-accent hover:text-accent-hover">
                Join the Hosted waitlist
                <ArrowRight className="size-3.5" aria-hidden />
              </a>
            </>
          ) : (
            <>
              <Link to="/" onClick={onNavigate} className="inline-flex items-center gap-1 font-semibold text-accent hover:text-accent-hover">
                See the status page
                <ArrowRight className="size-3.5" aria-hidden />
              </Link>
              <a href={OPENPING_SITE} onClick={onNavigate} className="inline-flex items-center gap-1 text-xs text-ink-faint hover:text-ink">
                Get your own OpenPing
              </a>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
