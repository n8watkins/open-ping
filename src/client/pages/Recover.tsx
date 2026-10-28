import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Fingerprint, Loader2 } from "lucide-react";
import { Logo } from "../components/Logo";
import { defaultPasskeyName } from "../components/PasskeysCard";
import { useBootstrap } from "../lib/bootstrap";
import { setPageMeta } from "../lib/meta";
import { hostMatchesRpId, passkeyErrorMessage, passkeysSupported, registerPasskey } from "../lib/webauthn";

/**
 * /recover: add a passkey and sign in with a new SETUP_TOKEN, for an admin who
 * lost every passkey (docs/SECURITY.md, "Passkeys"). The token proves control
 * of the Cloudflare account; each one works once.
 */

const C = ({ children }: { children: string }) => (
  <code className="whitespace-nowrap rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.8125rem] text-ink">{children}</code>
);

function recoveryError(err: unknown): string {
  const code = err instanceof Error ? err.message : "";
  switch (code) {
    case "setup_token_invalid":
      return "That setup token doesn't match the SETUP_TOKEN secret.";
    case "setup_token_spent":
      return "That setup token was already used. Set a new SETUP_TOKEN in Cloudflare, then try again with it.";
    case "setup_token_not_configured":
      return "No SETUP_TOKEN is set on this OpenPing. Set one in Cloudflare first.";
    case "setup_incomplete":
      return "Setup isn't finished yet. Use the setup wizard instead.";
    default:
      return passkeyErrorMessage(err);
  }
}

export default function Recover() {
  const { status } = useBootstrap();
  const [token, setToken] = useState("");
  const [name, setName] = useState(defaultPasskeyName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPageMeta({ title: "Recover access | OpenPing", noindex: true });
  }, []);

  const supported = passkeysSupported();
  const rpId = status?.passkeyRpId;
  const here = hostMatchesRpId(rpId);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!token.trim()) {
      setError("Enter the new setup token.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await registerPasskey("/api/auth/passkeys/recover", name.trim() || "Passkey", {
        headers: { "x-setup-token": token.trim() },
      });
      window.location.assign("/settings?recovered=1#sign-in");
    } catch (err) {
      setError(recoveryError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-full place-items-center px-4 py-10">
      <main className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>

        <form onSubmit={(e) => void submit(e)} className="rounded-card border border-line bg-surface p-6" noValidate>
          <h1 className="text-center text-lg font-semibold tracking-tight text-ink">Recover access</h1>
          <p className="mt-3 text-sm leading-relaxed text-ink-muted">
            Lost every passkey? Set a new setup token in Cloudflare, then enter it here to create a new passkey and
            sign in. Each token works once, and every other device is signed out.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg border border-line bg-canvas/60 px-3 py-2 font-mono text-xs text-ink">
            npx wrangler secret put SETUP_TOKEN
          </pre>
          <p className="mt-2 text-xs leading-relaxed text-ink-faint">
            Use a new random value, for example from <C>openssl rand -base64 32</C>. GitHub or email sign-in, if set up,
            still work too.
          </p>

          {!supported ? (
            <p role="alert" className="mt-4 rounded-lg border border-degraded/40 bg-degraded/10 px-3 py-2.5 text-sm text-ink">
              This browser can't create passkeys.
            </p>
          ) : rpId && !here ? (
            <p role="alert" className="mt-4 rounded-lg border border-degraded/40 bg-degraded/10 px-3 py-2.5 text-sm text-ink">
              Passkeys for this OpenPing work at{" "}
              <a href={`${status?.passkeyOrigin ?? `https://${rpId}`}/recover`} className="font-semibold underline underline-offset-4">
                {rpId}
              </a>
              . Recover there.
            </p>
          ) : null}

          <label className="mt-5 block">
            <span className="mb-1.5 block text-xs font-medium text-ink-muted">New setup token</span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              className="input"
            />
          </label>
          <label className="mt-4 block">
            <span className="mb-1.5 block text-xs font-medium text-ink-muted">Passkey name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
              autoComplete="off"
              className="input"
            />
          </label>

          {error && (
            <p role="alert" className="mt-4 rounded-lg border border-down/40 bg-down/10 px-3 py-2.5 text-sm text-ink">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy || !supported || (!!rpId && !here)}
            className="mt-5 flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-ink px-4 text-sm font-semibold text-canvas transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Fingerprint className="size-4" aria-hidden />}
            Create a passkey and sign in
          </button>
        </form>

        <p className="mt-6 text-center">
          <Link to="/login" className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink">
            <ArrowLeft className="size-4" aria-hidden />
            Back to sign-in
          </Link>
        </p>
      </main>
    </div>
  );
}
