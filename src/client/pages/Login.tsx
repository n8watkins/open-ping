import { useEffect, useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { Logo } from "../components/Logo";
import { SignInPanel } from "../components/SignInPanel";
import { useBootstrap } from "../lib/bootstrap";
import { setPageMeta } from "../lib/meta";

export default function Login() {
  const { loading, status, me, error: bootstrapError, refresh } = useBootstrap();
  const [params] = useSearchParams();
  const error = params.get("error");

  useEffect(() => {
    setPageMeta({ title: "Sign in | OpenPing", noindex: true });
  }, []);

  const [retrying, setRetrying] = useState(false);

  async function retry() {
    setRetrying(true);
    try {
      await refresh();
    } finally {
      setRetrying(false);
    }
  }

  if (loading) {
    return (
      <div className="grid min-h-full place-items-center">
        <Loader2 className="size-6 animate-spin text-ink-faint" />
      </div>
    );
  }
  // Only force the first-run wizard when setup is incomplete AND no admin is
  // configured yet. If an admin is already configured (e.g. via the
  // ADMIN_GITHUB_LOGIN env secret), the anonymous wizard is unnecessary (and is
  // locked server-side), so let the operator sign in here instead of trapping
  // them on /setup.
  if (status && !status.setupComplete && !status.githubAdminConfigured && !status.emailAdminConfigured)
    return <Navigate to="/setup" replace />;
  if (me?.authenticated) return <Navigate to="/" replace />;

  // A failed bootstrap leaves `status` null, which would otherwise render every
  // provider as disabled ("no sign-in options"). Show a retryable error instead
  // so a transient outage doesn't masquerade as a misconfigured install.
  if (bootstrapError && !status) {
    return (
      <div className="grid min-h-full place-items-center px-4">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex justify-center">
            <Logo />
          </div>
          <div className="rounded-card border border-line bg-surface p-6 text-center">
            <h1 className="text-lg font-semibold tracking-tight">
              Can't reach the server
            </h1>
            <p className="mt-2 text-sm text-ink-muted">
              We couldn't load sign-in options. This is usually a temporary
              network or server issue.
            </p>
            <button
              type="button"
              onClick={() => void retry()}
              disabled={retrying}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg border border-line bg-surface-2 px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-line disabled:opacity-40"
            >
              {retrying ? <Loader2 className="size-4 animate-spin" /> : null}
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="grid min-h-full place-items-center px-4 py-10">
      <main className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>

        <div className="rounded-card border border-line bg-surface p-6">
          <SignInPanel error={error} />
        </div>

        <p className="mt-6 text-center">
          <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink">
            <ArrowLeft className="size-4" aria-hidden />
            Back to the home page
          </Link>
        </p>
      </main>
    </div>
  );
}
