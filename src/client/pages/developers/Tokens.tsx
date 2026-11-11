import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowRight, Check, ChevronDown, KeyRound, Minus, Plus, Trash2, Loader2, X } from "lucide-react";
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

const CUSTOM = "custom";
/** Custom offers the four everyday scopes; Full control is its own choice. */
const CUSTOM_SCOPES = SCOPES.filter((x) => x !== "admin");

/** Developers > API tokens: create with scopes and expiry (shown once), list and revoke; and the API_TOKEN secret. */
export default function TokensPage() {
  const { csrf } = useBootstrap();
  const { fresh, setFresh, origin } = useDevelopers();
  const { data, loading, error, reload } = useFetch<TokensResponse>("/api/api-tokens");
  const [name, setName] = useState("");
  const [choice, setChoice] = useState<string>(SCOPE_PRESETS[0]!.id);
  const [custom, setCustom] = useState<Set<Scope>>(() => new Set<Scope>(["read"]));
  const [expiry, setExpiry] = useState<Expiry>("90");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ token: string; name: string; id: string } | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const scopes: ReadonlySet<Scope> =
    choice === CUSTOM ? custom : new Set(SCOPE_PRESETS.find((p) => p.id === choice)?.scopes ?? []);

  function pick(id: string) {
    if (id === CUSTOM && choice !== CUSTOM) {
      // Start Custom from what was selected, so nothing jumps.
      setCustom(new Set([...scopes].filter((x) => x !== "admin")));
    }
    setChoice(id);
  }

  function toggleScope(scope: Scope, on: boolean) {
    setCustom((prev) => {
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
          scopes: SCOPES.filter((s) => scopes.has(s)),
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
          A token lets the CLI, an MCP client or a script use OpenPing, limited to the permissions you choose. Give each client
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
            <legend className="mb-2 text-sm font-semibold text-ink">What can this token do?</legend>
            <div role="radiogroup" aria-label="What can this token do?" className="space-y-2">
              {SCOPE_PRESETS.map((p) => (
                <ChoiceCard
                  key={p.id}
                  id={p.id}
                  title={p.label}
                  summary={p.summary}
                  selected={choice === p.id}
                  danger={p.id === "admin"}
                  onSelect={() => pick(p.id)}
                >
                  {p.id === "admin" ? (
                    <>
                      <p className="text-sm text-ink">{p.can[0]}. Only for your own CLI.</p>
                      <p className="mt-3 flex items-start gap-2 text-xs text-degraded">
                        <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
                        Anyone holding this token can delete monitors, change alert channels and export your data. Give an AI
                        agent a narrower one.
                      </p>
                    </>
                  ) : (
                    <CanCant can={p.can} cant={p.cant} />
                  )}
                  <ScopeIds scopes={p.scopes} />
                </ChoiceCard>
              ))}
              <ChoiceCard
                id={CUSTOM}
                title="Custom"
                summary="Pick exactly what it can do"
                selected={choice === CUSTOM}
                onSelect={() => pick(CUSTOM)}
              >
                <ul className="space-y-2" aria-label="Permissions">
                  {CUSTOM_SCOPES.map((s) => (
                    <li key={s}>
                      <label className="flex cursor-pointer items-start gap-2.5">
                        <input
                          type="checkbox"
                          checked={custom.has(s)}
                          onChange={(e) => toggleScope(s, e.target.checked)}
                          className="mt-0.5 size-4 shrink-0 accent-accent"
                        />
                        <span className="min-w-0 text-sm">
                          <span className="font-medium text-ink">{SCOPE_INFO[s].label}</span>
                          <span className="block text-xs text-ink-faint">{SCOPE_INFO[s].description}</span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </ChoiceCard>
            </div>
          </fieldset>

          <div className="flex flex-wrap items-center gap-3">
            <PrimaryButton type="submit" busy={creating} disabled={!name.trim() || scopes.size === 0 || atMax}>
              {!creating && <Plus className="size-4" />}
              Create token
            </PrimaryButton>
            {scopes.size === 0 && <span className="text-xs text-ink-faint">Tick at least one permission.</span>}
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
                    <span>{scopeNames(t.scopes)}</span>
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
          Send the token as a Bearer header. A call outside its permissions gets 403 insufficient_scope, naming the scope id it needs.
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
              {SCOPE_INFO.admin.label}
            </span>
          ) : (
            t.scopes.map((s) => (
              <span
                key={s}
                title={SCOPE_INFO[s].description}
                className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[11px] text-ink-muted"
              >
                {SCOPE_INFO[s].label}
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

function scopeNames(scopes: readonly Scope[]): string {
  return scopes.includes("admin") ? SCOPE_INFO.admin.label : scopes.map((x) => SCOPE_INFO[x].label).join(", ");
}

/** Technical ids, small and muted, for people who want to match them to the API docs. */
function ScopeIds({ scopes }: { scopes: readonly Scope[] }) {
  return <p className="mt-3 font-mono text-[11px] text-ink-faint">Scopes: {scopes.join(", ")}</p>;
}

function CanCant({ can, cant }: { can: readonly string[]; cant: readonly string[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <p className="mb-1 text-xs font-semibold text-ink">Can</p>
        <ul className="space-y-1">
          {can.map((c) => (
            <li key={c} className="flex items-start gap-1.5 text-sm text-ink-muted">
              <Check className="mt-0.5 size-3.5 shrink-0 text-up" aria-hidden />
              {c}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="mb-1 text-xs font-semibold text-ink">Can&apos;t</p>
        <ul className="space-y-1">
          {cant.map((c) => (
            <li key={c} className="flex items-start gap-1.5 text-sm text-ink-muted">
              <Minus className="mt-0.5 size-3.5 shrink-0 text-ink-faint" aria-hidden />
              {c}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * One choice in a vertical radio group that opens like an FAQ accordion: the selected card shows its details.
 * A real (visually hidden) radio keeps arrow keys, focus and screen readers native.
 */
function ChoiceCard({
  id,
  title,
  summary,
  selected,
  danger,
  onSelect,
  children,
}: {
  id: string;
  title: string;
  summary: string;
  selected: boolean;
  danger?: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border transition-colors has-[input[type=radio]:focus-visible]:ring-2 has-[input[type=radio]:focus-visible]:ring-accent/60",
        selected ? (danger ? "border-degraded/50 bg-degraded/5" : "border-accent/50 bg-accent-soft/30") : "border-line hover:border-ink-faint/50",
      )}
    >
      <label className="flex cursor-pointer items-center gap-3 px-3.5 py-3">
        <input
          type="radio"
          name="token-access"
          value={id}
          checked={selected}
          onChange={onSelect}
          className="sr-only"
        />
        <span
          aria-hidden
          className={cn(
            "grid size-4 shrink-0 place-items-center rounded-full border",
            selected ? (danger ? "border-degraded" : "border-accent") : "border-ink-faint",
          )}
        >
          {selected && <span className={cn("size-2 rounded-full", danger ? "bg-degraded" : "bg-accent")} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-ink">{title}</span>
          <span className="block text-xs text-ink-muted">{summary}</span>
        </span>
        <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-ink-faint transition-transform", selected && "rotate-180")} />
      </label>
      {selected && <div className="animate-enter border-t border-line/70 px-3.5 py-3 pl-[2.625rem]">{children}</div>}
    </div>
  );
}
