import { Github, Mail, Loader2 } from "lucide-react";
import { Navigate, useSearchParams } from "react-router-dom";
import { Logo } from "../components/Logo";
import { useBootstrap } from "../lib/bootstrap";

const ERROR_MESSAGES: Record<string, string> = {
  github_not_configured: "GitHub sign-in isn't configured on this installation.",
  not_authorized: "That account isn't the configured administrator.",
  state_invalid: "Sign-in session expired. Please try again.",
  invalid_callback: "The sign-in response was invalid. Please try again.",
  token_exchange_failed: "Could not complete GitHub sign-in. Please try again.",
  identity_failed: "Could not read your GitHub identity. Please try again.",
};

export default function Login() {
  const { loading, status, me } = useBootstrap();
  const [params] = useSearchParams();
  const error = params.get("error");

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
            <a
              href="/auth/github/start"
              aria-disabled={!status?.githubEnabled}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-canvas transition-opacity hover:opacity-90 aria-disabled:pointer-events-none aria-disabled:opacity-40"
            >
              <Github className="size-4" />
              Continue with GitHub
            </a>
            <button
              type="button"
              disabled
              title="Email magic link arrives in a later phase"
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-line bg-surface-2 px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-line disabled:opacity-40"
            >
              <Mail className="size-4" />
              Email magic link
            </button>
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-ink-faint">
          Self-hosted on your own Cloudflare account.
        </p>
      </div>
    </div>
  );
}
