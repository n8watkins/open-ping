import { useEffect, useState } from "react";
import { ArrowLeft, Fingerprint, Loader2 } from "lucide-react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { Logo } from "../components/Logo";
import { AppSignInPanel, SignInPanel, usePasskeySignIn } from "../components/SignInPanel";
import { hasAppBridge, isInApp } from "../lib/native-app";
import { useBootstrap, type AuthStatus } from "../lib/bootstrap";
import { setPageMeta } from "../lib/meta";
import { hostMatchesRpId, passkeysSupported } from "../lib/webauthn";

export default function Login() {
  const { loading, status, me, error: bootstrapError, refresh } = useBootstrap();
  const [params] = useSearchParams();
  const error = params.get("error");
  // Opened from the Android app's browser sign-in (routes/app-signin.ts).
  const forApp = params.get("app") === "1";

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
  if (
    status &&
    !status.setupComplete &&
    !status.githubAdminConfigured &&
    !status.emailAdminConfigured &&
    !status.passkeyConfigured
  )
    return <Navigate to="/setup" replace />;
  // Signing in for the Android app needs a fresh sign-in, even in a browser
  // that is signed in already (routes/app-signin.ts).
  if (me?.authenticated && !forApp) return <Navigate to="/" replace />;
  // Inside the Android app, every sign-in goes through the phone's browser.
  if (status?.appSignIn && isInApp() && hasAppBridge()) {
    return (
      <div className="grid min-h-full place-items-center px-4 py-10">
        <main className="w-full max-w-sm">
          <div className="mb-8 flex justify-center">
            <Logo />
          </div>
          <div className="rounded-card border border-line bg-surface p-6">
            <AppSignInPanel error={error} hosted={!!status.hosted} />
          </div>
        </main>
      </div>
    );
  }
  // OpenPing Hosted signs its customer in; their own passkeys work here too.
  if (status?.hosted) return <HostedSignIn status={status} signInUrl={status.hosted.signInUrl} />;

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

        {forApp && (
          <p role="status" className="mb-4 rounded-lg border border-accent/40 bg-accent-soft px-3.5 py-3 text-center text-sm leading-relaxed text-ink">
            Signing in for the OpenPing app. Sign in here, even if you already are, and you go back to the app.
          </p>
        )}
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

/**
 * Sign-in on OpenPing Hosted: through the platform's account (which hands the
 * browser back signed in), or with a passkey the customer added here.
 */
function HostedSignIn({ status, signInUrl }: { status: AuthStatus; signInUrl: string }) {
  const host = typeof window === "undefined" ? "" : window.location.host;
  const passkeyHere = !!status.passkeyConfigured && passkeysSupported() && hostMatchesRpId(status.passkeyRpId);
  const passkey = usePasskeySignIn(passkeyHere, false);

  return (
    <div className="grid min-h-full place-items-center px-4 py-10">
      <main className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>

        <div className="rounded-card border border-line bg-surface p-6">
          <h1 className="text-center text-lg font-semibold tracking-tight text-ink">Sign in to this OpenPing</h1>
          {host && (
            <p className="mt-2 flex justify-center">
              <span className="max-w-full truncate rounded-md border border-line bg-canvas/60 px-2 py-0.5 font-mono text-xs text-ink-muted">
                {host}
              </span>
            </p>
          )}
          <p className="mt-3 text-center text-sm leading-relaxed text-ink-muted">
            This OpenPing runs on OpenPing Hosted. Sign in with your OpenPing Hosted account.
          </p>

          <div className="mt-6 space-y-3">
            <a
              href={signInUrl}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-ink px-4 text-sm font-semibold text-canvas transition-opacity hover:opacity-90"
            >
              Sign in with OpenPing Hosted
            </a>

            {passkeyHere && (
              <>
                <div className="flex items-center gap-3 text-xs text-ink-faint" aria-hidden="true">
                  <span className="h-px flex-1 bg-line" />
                  or
                  <span className="h-px flex-1 bg-line" />
                </div>
                <button
                  type="button"
                  onClick={passkey.signIn}
                  disabled={passkey.busy}
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-line bg-surface-2 px-4 text-sm font-semibold text-ink transition-colors hover:bg-line disabled:opacity-60"
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
              </>
            )}
          </div>
        </div>

        <p className="mt-6 text-center">
          <Link to="/" className="inline-flex min-h-11 items-center gap-1.5 text-sm text-ink-muted hover:text-ink">
            <ArrowLeft className="size-4" aria-hidden />
            Back to the home page
          </Link>
        </p>
      </main>
    </div>
  );
}
