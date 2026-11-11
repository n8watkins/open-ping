import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowRight, KeyRound, Plus, Trash2, Loader2, X } from "lucide-react";
import { api } from "../../lib/api";
import { useBootstrap } from "../../lib/bootstrap";
import { useFetch } from "../../lib/useFetch";
import { cn } from "../../lib/cn";
import { formatDateTime, formatRelativeTime } from "../../lib/format";
import { curlExample, exportTokenLine } from "../../lib/dev-snippets";
import { Card, CardHeader, CardTitle } from "../../components/ui/Card";
import { CodeBlock } from "../../components/ui/CodeBlock";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { CopyButton } from "../../components/ui/CopyButton";
import { Chip, ErrorBanner, PrimaryButton, SectionSkeleton, errMessage } from "../settings/shared";
import { useDevelopers } from "../Developers";
import { EXPIRY_DAYS, SCOPES, SCOPE_INFO, SCOPE_PRESETS, type Scope } from "../../../shared/scopes";

interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
}
interface TokensResponse {
  tokens: ApiToken[];
  revoked: ApiToken[];
  secretConfigured: boolean;
  max: number;
}

const SECRET_COMMAND = "openssl rand -base64 32 | npx wrangler secret put API_TOKEN";

type Expiry = "7" | "30" | "90" | "never";
const EXPIRY_LABEL: Record<Expiry, string> = { "7": "7 days", "30": "30 days", "90": "90 days", never: "Never" };
const EXPIRY_OPTIONS = EXPIRY_DAYS.map((d) => (d === null ? "never" : String(d)) as Expiry);

/** The preset these scopes are exactly, if any. */
function presetOf(scopes: ReadonlySet<Scope>): string | null {
  const p = SCOPE_PRESETS.find((x) => x.scopes.length === scopes.size && x.scopes.every((s) => scopes.has(s)));
  return p?.id ?? null;
}

/** Developers > API tokens: create with scopes and expiry (shown once), list and revoke; and the API_TOKEN secret. */
export default function TokensPage() {
  const { csrf } = useBootstrap();
  const { fresh, setFresh, origin } = useDevelopers();
  const { data, loading, error, reload } = useFetch<TokensResponse>("/api/api-tokens");
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Set<Scope>>(() => new Set<Scope>(["read"]));
  const [expiry, setExpiry] = useState<Expiry>("90");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ token: string; name: string; id: string } | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const isAdmin = scopes.has("admin");
  const preset = presetOf(scopes);

  function toggleScope(scope: Scope, on: boolean) {
    setScopes((prev) => {
      const next = new Set(prev);
      if (on) next.add(scope);
      else next.delete(scope);
      return next;
    });
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const res = await api<{ token: string; apiToken: ApiToken }>("/api/api-tokens", {
        method: "POST",
        csrf: csrf ?? undefined,
        json: {
          name: name.trim(),
          scopes: isAdmin ? ["admin"] : SCOPES.filter((s) => scopes.has(s)),
          expiresInDays: expiry === "never" ? null : Number(expiry),
        },
      });
      setRevealed({ token: res.token, name: res.apiToken.name, id: res.apiToken.id });
      setFresh({ token: res.token, id: res.apiToken.id });
      setName("");
      await reload();
    } catch (err) {
      setCreateError(errMessage(err, "Could not create the token."));
    } finally {
      setCreating(false);
    }
  }

  // Revoking can't be undone, so it asks first in the app's own dialog.
  const [confirming, setConfirming] = useState<ApiToken | null>(null);

  async function revoke(t: ApiToken) {
    setConfirming(null);
    setRevoking(t.id);
    setListError(null);
    try {
      await api(`/api/api-tokens/${encodeURIComponent(t.id)}`, { method: "DELETE", csrf: csrf ?? undefined });
      if (revealed?.id === t.id) setRevealed(null);
      if (fresh?.id === t.id) setFresh(null);
      await reload();
    } catch (err) {
      setListError(errMessage(err, "Could not revoke the token."));
    } finally {
      setRevoking(null);
    }
  }

  const atMax = !!data && data.tokens.length >= data.max;

  return (
    <div className="stagger space-y-6 [&>*]:animate-enter">
      <Card className="p-5">
        <CardHeader>
          <CardTitle as="h2">API tokens</CardTitle>
          {data && <Chip tone="neutral">{data.tokens.length === 1 ? "1 token" : `${data.tokens.length} tokens`}</Chip>}
        </CardHeader>
        <p className="-mt-1 mb-5 text-sm text-ink-muted">
          A token lets the CLI, an MCP client or a script use OpenPing, limited to the scopes you choose. Give each client
          its own token with the least it needs, so you can revoke one without the others. OpenPing keeps only a hash, so
          a token is shown once. Only you, signed in here, can create or revoke tokens.
        </p>

        {revealed && (
          <div role="status" className="mb-5 animate-enter rounded-lg border border-accent/40 bg-accent-soft/60 p-4">
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm text-ink">
                <span className="font-semibold">&ldquo;{revealed.name}&rdquo; is ready.</span> Copy it now: it won&apos;t be
                shown again.
              </p>
              <button
                type="button"
                onClick={() => setRevealed(null)}
                aria-label="Hide the new token"
                className="-mt-1 -mr-1 grid size-7 shrink-0 place-items-center rounded-md text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
              <code className="min-w-0 flex-1 overflow-x-auto rounded-md border border-line bg-canvas/70 px-3 py-2 font-mono text-[13px] whitespace-nowrap text-ink">
                {revealed.token}
              </code>
              <CopyButton text={revealed.token} label="Copy token" className="self-start px-3 py-2 sm:self-auto" />
            </div>
            <p className="mt-3 text-xs text-ink-faint">
              The MCP and CLI pages fill it in for you until you leave or reload this page.
            </p>
          </div>
        )}

        <form onSubmit={(e) => void create(e)} className="space-y-4 rounded-lg border border-line p-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <div>
              <label htmlFor="token-name" className="mb-1.5 block text-xs font-medium text-ink-muted">
                Name
              </label>
              <input
                id="token-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={64}
                placeholder="Like Claude Code or Laptop CLI"
                autoComplete="off"
                className="input"
              />
            </div>
            <div>
              <label htmlFor="token-expiry" className="mb-1.5 block text-xs font-medium text-ink-muted">
                Expires after
              </label>
              <select
                id="token-expiry"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value as Expiry)}
                className="input sm:w-36"
              >
                {EXPIRY_OPTIONS.map((o) => (
                  <option key={o} value={o}>
                    {EXPIRY_LABEL[o]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <fieldset>
            <legend className="mb-1.5 text-xs font-medium text-ink-muted">Access</legend>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Presets">
              {SCOPE_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  title={p.hint}
                  aria-pressed={preset === p.id}
                  onClick={() => setScopes(new Set(p.scopes))}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                    preset === p.id
                      ? "border-accent/50 bg-accent-soft text-ink"
                      : "border-line text-ink-muted hover:border-accent/40 hover:text-ink",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <ul className="mt-3 space-y-2">
              {SCOPES.map((s) => {
                const implied = isAdmin && s !== "admin";
                return (
                  <li key={s}>
                    <label className={cn("flex cursor-pointer items-start gap-2.5", implied && "cursor-default opacity-60")}>
                      <input
                        type="checkbox"
                        checked={scopes.has(s) || implied}
                        disabled={implied}
                        onChange={(e) => toggleScope(s, e.target.checked)}
                        className="mt-0.5 size-4 shrink-0 accent-accent"
                      />
                      <span className="min-w-0 text-sm">
                        <span className="font-mono text-[13px] text-ink">{s}</span>
                        <span className="block text-xs text-ink-faint">{SCOPE_INFO[s].description}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            {isAdmin && (
              <p className="mt-3 flex items-start gap-2 text-xs text-degraded">
                <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
                Admin can delete monitors, change alert channels and export your data. Give an AI agent a narrower token.
              </p>
            )}
          </fieldset>

          <div className="flex flex-wrap items-center gap-3">
            <PrimaryButton type="submit" busy={creating} disabled={!name.trim() || scopes.size === 0 || atMax}>
              {!creating && <Plus className="size-4" />}
              Create token
            </PrimaryButton>
            {scopes.size === 0 && <span className="text-xs text-ink-faint">Choose at least one scope.</span>}
            {atMax && <span className="text-xs text-ink-faint">That&apos;s the most tokens an install keeps; revoke one first.</span>}
          </div>
          {createError && <ErrorBanner>{createError}</ErrorBanner>}
        </form>

        <div className="mt-5">
          {loading && !data ? (
            <SectionSkeleton rows={2} />
          ) : error && !data ? (
            <ErrorBanner>Could not load tokens: {error}</ErrorBanner>
          ) : data && data.tokens.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-sm text-ink-muted">
              No tokens yet. Create one above for each client that should reach OpenPing.
            </p>
          ) : data ? (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {data.tokens.map((t) => (
                <TokenRow
                  key={t.id}
                  token={t}
                  busy={revoking === t.id}
                  onRevoke={() => {
                    setListError(null);
                    setConfirming(t);
                  }}
                />
              ))}
            </ul>
          ) : null}
          {listError && (
            <div className="mt-3">
              <ErrorBanner>{listError}</ErrorBanner>
            </div>
          )}
          {data && data.revoked.length > 0 && (
            <details className="group mt-4">
              <summary className="cursor-pointer text-xs font-medium text-ink-muted hover:text-ink">
                Revoked tokens ({data.revoked.length})
              </summary>
              <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
                {data.revoked.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-xs text-ink-faint">
                    <span className="font-medium text-ink-muted">{t.name}</span>
                    <span className="font-mono">{t.prefix}…</span>
                    <span>{t.scopes.join(", ")}</span>
                    {t.revokedAt && <span title={formatDateTime(t.revokedAt)}>Revoked {formatRelativeTime(t.revokedAt)}</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </Card>

      <Card className="p-5">
        <CardHeader>
          <CardTitle as="h2">Try it</CardTitle>
        </CardHeader>
        <p className="-mt-1 mb-4 text-sm text-ink-muted">
          Send the token as a Bearer header. A call outside its scopes gets 403 insufficient_scope, naming the scope it needs.
        </p>
        <div className="space-y-3">
          <CodeBlock label="Terminal" code={`${exportTokenLine(fresh?.token ?? null)}\n${curlExample(origin)}`} />
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <NextLink to="/developers/mcp">Connect Claude</NextLink>
          <NextLink to="/developers/cli">Use the CLI</NextLink>
        </div>
      </Card>

      <Card className="p-5">
        <CardHeader>
          <CardTitle as="h2">API_TOKEN Worker secret</CardTitle>
          {data && (
            <Chip tone={data.secretConfigured ? "up" : "neutral"}>{data.secretConfigured ? "Set" : "Not set"}</Chip>
          )}
        </CardHeader>
        <p className="-mt-1 mb-4 text-sm text-ink-muted">
          The older way to make a token: a secret on the Worker with full admin access, which works beside the tokens
          above. Cloudflare never shows its value, so OpenPing can&apos;t either.{" "}
          {data?.secretConfigured
            ? "To rotate it, set a new value; every client using the old one is cut off at once."
            : "You don't need it if you use the tokens above."}
        </p>
        <CodeBlock label="Set or rotate (from your OpenPing checkout)" code={SECRET_COMMAND} />
        {data?.secretConfigured && (
          <p className="mt-3 flex items-start gap-2 text-xs text-ink-faint">
            <AlertTriangle className="mt-px size-3.5 shrink-0 text-degraded" aria-hidden />
            To turn it off, delete it: <code className="font-mono text-ink-muted">npx wrangler secret delete API_TOKEN</code>
          </p>
        )}
      </Card>
      <ConfirmDialog
        open={confirming !== null}
        title={`Revoke “${confirming?.name ?? "token"}”?`}
        confirmLabel="Revoke token"
        onConfirm={() => confirming && void revoke(confirming)}
        onCancel={() => setConfirming(null)}
      >
        <p>
          Anything using this token gets &ldquo;unauthorized&rdquo; from now on. It can&apos;t be undone: to restore access,
          create a new token and update those clients. A record of it stays under Revoked tokens.
        </p>
      </ConfirmDialog>
    </div>
  );
}

function TokenRow({ token: t, busy, onRevoke }: { token: ApiToken; busy: boolean; onRevoke: () => void }) {
  const now = Date.now();
  const expired = t.expiresAt != null && t.expiresAt <= now;
  const admin = t.scopes.includes("admin");
  return (
    <li className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-surface-2/30">
      <KeyRound className="size-4 shrink-0 self-start text-ink-faint sm:mt-0.5" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-medium text-ink">{t.name}</span>
          <span className="font-mono text-xs text-ink-faint">{t.prefix}…</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {admin ? (
            <span
              title={SCOPE_INFO.admin.description}
              className="inline-flex items-center gap-1 rounded-full border border-degraded/40 bg-degraded/10 px-2 py-0.5 text-[11px] font-medium text-degraded"
            >
              <AlertTriangle className="size-3" aria-hidden />
              Full admin
            </span>
          ) : (
            t.scopes.map((s) => (
              <span
                key={s}
                title={SCOPE_INFO[s].description}
                className="rounded-full border border-line bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-ink-muted"
              >
                {s}
              </span>
            ))
          )}
        </div>
        <div className="mt-1 text-xs text-ink-faint">
          <span title={formatDateTime(t.createdAt)}>Created {formatRelativeTime(t.createdAt)}</span>
          {" · "}
          {t.lastUsedAt ? (
            <span title={formatDateTime(t.lastUsedAt)}>Last used {formatRelativeTime(t.lastUsedAt)}</span>
          ) : (
            "Never used"
          )}
          {" · "}
          {t.expiresAt == null ? (
            "Never expires"
          ) : expired ? (
            <span className="font-medium text-down" title={formatDateTime(t.expiresAt)}>
              Expired {formatRelativeTime(t.expiresAt)}
            </span>
          ) : (
            <span title={formatDateTime(t.expiresAt)}>Expires {formatRelativeTime(t.expiresAt)}</span>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onRevoke}
        disabled={busy}
        aria-label={`Revoke ${t.name}`}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:bg-down/10 hover:text-down disabled:opacity-60"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
        Revoke
      </button>
    </li>
  );
}

function NextLink({ to, children }: { to: string; children: string }) {
  return (
    <Link
      to={to}
      className="group inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink-muted transition-colors hover:border-accent/40 hover:text-ink"
    >
      {children}
      <ArrowRight aria-hidden className="size-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
    </Link>
  );
}
