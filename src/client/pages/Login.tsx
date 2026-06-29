import { useState, type FormEvent } from "react";
import { Github, Mail, Loader2 } from "lucide-react";
import { Navigate, useSearchParams } from "react-router-dom";
import { Logo } from "../components/Logo";
import { api } from "../lib/api";
import { useBootstrap } from "../lib/bootstrap";

const ERROR_MESSAGES: Record<string, string> = {
  github_not_configured: "GitHub sign-in isn't configured on this installation.",
  not_authorized: "That account isn't the configured administrator.",
  state_invalid: "Sign-in session expired. Please try again.",
  invalid_callback: "The sign-in response was invalid. Please try again.",
  token_exchange_failed: "Could not complete GitHub sign-in. Please try again.",
  identity_failed: "Could not read your GitHub identity. Please try again.",
  magic_invalid: "That sign-in link is invalid or has expired. Please request a new one.",
};

export default function Login() {
  const { loading, status, me } = useBootstrap();
  const [params] = useSearchParams();
  const error = params.get("error");

  const githubEnabled = status?.githubEnabled ?? false;
  const emailEnabled = status?.emailAdminConfigured ?? false;

  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  async function requestMagicLink(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setEmailError(null);
    try {
      // The server always responds { ok: true } regardless of whether the
      // address is allowed, so we show the same generic confirmation either way.
      await api("/api/auth/magic/request", { method: "POST", json: { email } });
      setSent(true);
    } catch (err) {
      setEmailError(
        err instanceof Error ? err.message : "Could not send a sign-in link. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="grid min-h-full place-items-center">
        <Loader2 className="size-6 animate-spin text-ink-faint" />
      </div>
    );
  }
  if (status && !status.setupComplete) return <Navigate to="/setup" replace />;
  if (me?.authenticated) return <Navigate to="/" replace />;

  return (
    <div className="grid min-h-full place-items-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>

        <div className="rounded-card border border-line bg-surface p-6">
          <h1 className="text-center text-lg font-semibold tracking-tight">Sign in</h1>
          <p className="mt-1 text-center text-sm text-ink-muted">
            OpenPing is single-administrator. Only the configured identity can sign in.
          </p>

          {error && (
            <p className="mt-4 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-center text-sm text-down">
              {ERROR_MESSAGES[error] ?? "Sign-in failed. Please try again."}
            </p>
          )}

          <div className="mt-6 space-y-3">
            {githubEnabled ? (
              <a
                href="/auth/github/start"
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-canvas transition-opacity hover:opacity-90"
              >
                <Github className="size-4" />
                Continue with GitHub
              </a>
            ) : (
              <button
                type="button"
                disabled
                title="GitHub sign-in isn't configured on this installation."
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-canvas transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Github className="size-4" />
                Continue with GitHub
              </button>
            )}

            {emailEnabled &&
              (sent ? (
                <p className="rounded-lg border border-up/40 bg-up/10 px-3 py-2 text-center text-sm text-up">
                  If that address is allowed, a sign-in link has been sent.
                </p>
              ) : (
                <form onSubmit={(e) => void requestMagicLink(e)} className="space-y-2">
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    aria-label="Email address"
                    className="input"
                  />
                  <button
                    type="submit"
                    disabled={submitting}
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-line bg-surface-2 px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-line disabled:opacity-40"
                  >
                    {submitting ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Mail className="size-4" />
                    )}
                    Email magic link
                  </button>
                  {emailError && (
                    <p className="text-center text-sm text-down">{emailError}</p>
                  )}
                </form>
              ))}
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-ink-faint">
          Self-hosted on your own Cloudflare account.
        </p>
      </div>
    </div>
  );
}
