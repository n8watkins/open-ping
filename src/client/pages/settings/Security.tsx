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

const KIND_LABEL: Record<string, string> = {
  github: "GitHub",
  email: "an email link",
  passkey: "a passkey",
  hosted: "OpenPing Hosted",
  hosted_support: "OpenPing Hosted, as support",
};

/** Settings > Sign-in & security: passkeys, sessions, API tokens and encryption keys. */
export default function SecuritySettings() {
  const { csrf, me } = useBootstrap();
  return (
    <div className="stagger space-y-6 [&>*]:animate-enter">
      <PasskeysCard csrf={csrf ?? undefined} />
      <SessionsCard csrf={csrf ?? undefined} />
      {me?.hosted && <SupportActivityCard />}
      <ApiTokensPointer />
      {/* On OpenPing Hosted the platform holds and rotates the encryption key. */}
      {!me?.hosted && (
        <section id="encryption" className="scroll-mt-6">
          <EncryptionCard csrf={csrf ?? undefined} />
        </section>
      )}
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
            {me?.hosted && (
              <span className="block text-xs text-ink-faint">
                Your OpenPing Hosted account signs you in here.{" "}
                <a href={me.hosted.accountUrl} className="underline underline-offset-2 hover:text-ink">
                  Manage your account
                </a>
                .
              </span>
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

interface SupportActivityEntry {
  id: number;
  at: number;
  kind: "signed_in" | "change" | "refused";
  identity: string;
  method: string | null;
  path: string | null;
  status: number | null;
}

/** What part of OpenPing an API path is, in words. */
const AREA: Record<string, string> = {
  monitors: "monitors",
  "status-pages": "status pages",
  channels: "alert channels",
  settings: "settings",
  incidents: "incidents",
  maintenance: "maintenance windows",
  categories: "categories",
  push: "push devices",
  reports: "reports",
  passkeys: "passkeys",
  "api-tokens": "API tokens",
  data: "data import",
  auth: "sessions",
  admin: "the encryption key",
};

function describeSupport(e: SupportActivityEntry): string {
  if (e.kind === "signed_in") return `${e.identity} signed in as support`;
  const segment = e.path?.split("/")[2] ?? "";
  const area = AREA[segment] ?? (segment || "something");
  if (e.kind === "refused") return `Tried to ${e.method === "DELETE" ? "delete from" : "change"} ${area}, and was refused`;
  return `Changed ${area}`;
}

/**
 * OpenPing Hosted only: each time support signed in here, what it changed,
 * and what it was refused (support can't touch sign-in, tokens or keys, or
 * delete anything). Support sign-ins last an hour at most.
 */
function SupportActivityCard() {
  const { data } = useFetch<{ entries: SupportActivityEntry[] }>("/api/auth/support-activity");
  const entries = data?.entries ?? [];
  return (
    <section id="support" className="scroll-mt-6">
      <Card className="p-5">
        <CardHeader>
          <CardTitle>Support access</CardTitle>
        </CardHeader>
        <p className="text-sm text-ink-muted">
          When OpenPing Hosted support signs in to help, it is listed here with everything it changed. Support sign-ins last an hour, and can't change
          passkeys, sessions, API tokens or keys, or delete anything.
        </p>
        {data && entries.length === 0 && <p className="mt-3 text-sm text-ink-faint">Support has never signed in to this OpenPing.</p>}
        {entries.length > 0 && (
          <ul className="mt-3 divide-y divide-line">
            {entries.map((e) => (
              <li key={e.id} className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                <span className="min-w-0 text-sm text-ink">
                  <span className={e.kind === "refused" ? "text-down" : undefined}>{describeSupport(e)}</span>
                  {e.path && <span className="block truncate font-mono text-xs text-ink-faint">{`${e.method ?? ""} ${e.path}`}</span>}
                </span>
                <time dateTime={new Date(e.at).toISOString()} className="shrink-0 text-xs text-ink-faint">
                  {new Date(e.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                </time>
              </li>
            ))}
          </ul>
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
