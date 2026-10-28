import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, LogOut, Terminal } from "lucide-react";
import { api } from "../../lib/api";
import { useBootstrap } from "../../lib/bootstrap";
import { useFetch } from "../../lib/useFetch";
import { Card, CardHeader, CardTitle } from "../../components/ui/Card";
import { PasskeysCard } from "../../components/PasskeysCard";
import { EncryptionCard } from "./EncryptionCard";
import { ErrorBanner, SecondaryButton, errMessage, plural } from "./shared";

const KIND_LABEL: Record<string, string> = { github: "GitHub", email: "an email link", passkey: "a passkey" };

/** Settings > Sign-in & security: passkeys, sessions, API tokens and encryption keys. */
export default function SecuritySettings() {
  const { csrf } = useBootstrap();
  return (
    <div className="stagger space-y-6 [&>*]:animate-enter">
      <PasskeysCard csrf={csrf ?? undefined} />
      <SessionsCard csrf={csrf ?? undefined} />
      <ApiTokensPointer />
      <section id="encryption" className="scroll-mt-6">
        <EncryptionCard csrf={csrf ?? undefined} />
      </section>
    </div>
  );
}

/** This session, and signing every session out at once. */
function SessionsCard({ csrf }: { csrf: string | undefined }) {
  const { me } = useBootstrap();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOutEverywhere() {
    if (
      !window.confirm(
        "Sign out everywhere? Every browser signed in to OpenPing, this one included, is signed out. API tokens keep working.",
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/logout-all", { method: "POST", csrf });
      window.location.assign("/login");
    } catch (e) {
      setError(errMessage(e, "Could not sign out everywhere."));
      setBusy(false);
    }
  }

  return (
    <section id="sessions" className="scroll-mt-6">
      <Card className="p-5">
        <CardHeader>
          <CardTitle>Sessions</CardTitle>
        </CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-ink-muted">
            {me?.identity ? (
              <>
                Signed in as <span className="font-medium text-ink">{me.identity}</span>
                {me.identityKind ? ` with ${KIND_LABEL[me.identityKind] ?? me.identityKind}` : ""}.
              </>
            ) : (
              "Signed in."
            )}
            {me?.expiresAt ? (
              <span className="block text-xs text-ink-faint">
                This session expires on {new Date(me.expiresAt).toLocaleDateString(undefined, { dateStyle: "medium" })}.
              </span>
            ) : null}
          </p>
          <SecondaryButton onClick={() => void signOutEverywhere()} disabled={busy} className="self-start sm:self-auto">
            <LogOut className="size-4" />
            Sign out everywhere
          </SecondaryButton>
        </div>
        {error && (
          <div className="mt-3">
            <ErrorBanner>{error}</ErrorBanner>
          </div>
        )}
      </Card>
    </section>
  );
}

/** API tokens are full admin credentials too; they're managed under Developers. */
function ApiTokensPointer() {
  const { data } = useFetch<{ tokens: unknown[]; secretConfigured: boolean }>("/api/api-tokens");
  const count = data?.tokens.length ?? 0;
  const line = !data
    ? "Tokens for the CLI, MCP clients and scripts."
    : count === 0 && !data.secretConfigured
      ? "No API tokens. The CLI, MCP clients and scripts need one."
      : [count ? `${plural(count, "token")} created in the app` : null, data.secretConfigured ? "the API_TOKEN secret is set" : null]
          .filter(Boolean)
          .join(", ")
          .replace(/^./, (c) => c.toUpperCase()) + ".";
  return (
    <Link
      to="/developers/tokens"
      className="group flex items-center gap-3 rounded-card border border-line bg-surface px-5 py-4 transition-colors duration-150 hover:border-accent/40 hover:bg-surface-2/60"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
        <Terminal className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-ink">API tokens</span>
        <span className="block text-sm text-ink-muted">{line}</span>
      </span>
      <ArrowRight
        aria-hidden
        className="size-4 shrink-0 text-ink-faint transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-ink"
      />
    </Link>
  );
}
