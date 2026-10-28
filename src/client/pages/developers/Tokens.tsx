import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowRight, KeyRound, Plus, Trash2, Loader2, X } from "lucide-react";
import { api } from "../../lib/api";
import { useBootstrap } from "../../lib/bootstrap";
import { useFetch } from "../../lib/useFetch";
import { formatDateTime, formatRelativeTime } from "../../lib/format";
import { curlExample, exportTokenLine } from "../../lib/dev-snippets";
import { Card, CardHeader, CardTitle } from "../../components/ui/Card";
import { CodeBlock } from "../../components/ui/CodeBlock";
import { CopyButton } from "../../components/ui/CopyButton";
import { Chip, ErrorBanner, PrimaryButton, SectionSkeleton, errMessage } from "../settings/shared";
import { useDevelopers } from "../Developers";

interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}
interface TokensResponse {
  tokens: ApiToken[];
  secretConfigured: boolean;
  max: number;
}

const SECRET_COMMAND = "openssl rand -base64 32 | npx wrangler secret put API_TOKEN";

/** Developers > API tokens: create (shown once), list and revoke; and the API_TOKEN secret. */
export default function TokensPage() {
  const { csrf } = useBootstrap();
  const { fresh, setFresh, origin } = useDevelopers();
  const { data, loading, error, reload } = useFetch<TokensResponse>("/api/api-tokens");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ token: string; name: string; id: string } | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const res = await api<{ token: string; apiToken: ApiToken }>("/api/api-tokens", {
        method: "POST",
        csrf: csrf ?? undefined,
        json: { name: name.trim() },
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

  async function revoke(t: ApiToken) {
    if (!window.confirm(`Revoke "${t.name}"? Anything using it gets "unauthorized" from now on.`)) return;
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
          <CardTitle>API tokens</CardTitle>
          {data && <Chip tone="neutral">{data.tokens.length === 1 ? "1 token" : `${data.tokens.length} tokens`}</Chip>}
        </CardHeader>
        <p className="-mt-1 mb-5 text-sm text-ink-muted">
          A token signs the CLI, an MCP client or a script in as you, with full admin access. Give each one its own token,
          so you can revoke one without the others. OpenPing keeps only a hash, so a token is shown once.
        </p>

        {revealed && (
          <div
            role="status"
            className="mb-5 animate-enter rounded-lg border border-accent/40 bg-accent-soft/60 p-4"
          >
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

        <form onSubmit={(e) => void create(e)} className="flex flex-col gap-2 sm:flex-row">
          <label htmlFor="token-name" className="sr-only">
            Token name
          </label>
          <input
            id="token-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={64}
            placeholder="Name, like Claude Code or Laptop CLI"
            autoComplete="off"
            className="input sm:max-w-xs"
          />
          <PrimaryButton type="submit" busy={creating} disabled={!name.trim() || atMax}>
            {!creating && <Plus className="size-4" />}
            Create token
          </PrimaryButton>
        </form>
        {atMax && <p className="mt-2 text-xs text-ink-faint">That&apos;s the most tokens an install keeps; revoke one first.</p>}
        {createError && (
          <div className="mt-3">
            <ErrorBanner>{createError}</ErrorBanner>
          </div>
        )}

        <div className="mt-5">
          {loading && !data ? (
            <SectionSkeleton rows={2} />
          ) : error && !data ? (
            <ErrorBanner>Could not load tokens: {error}</ErrorBanner>
          ) : data && data.tokens.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-sm text-ink-muted">
              No tokens yet.
            </p>
          ) : data ? (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {data.tokens.map((t) => (
                <li key={t.id} className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-surface-2/30">
                  <KeyRound className="size-4 shrink-0 text-ink-faint" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="truncate text-sm font-medium text-ink">{t.name}</span>
                      <span className="font-mono text-xs text-ink-faint">{t.prefix}…</span>
                    </div>
                    <div className="mt-0.5 text-xs text-ink-faint">
                      <span title={formatDateTime(t.createdAt)}>Created {formatRelativeTime(t.createdAt)}</span>
                      {" · "}
                      {t.lastUsedAt ? (
                        <span title={formatDateTime(t.lastUsedAt)}>Last used {formatRelativeTime(t.lastUsedAt)}</span>
                      ) : (
                        "Never used"
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void revoke(t)}
                    disabled={revoking === t.id}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:bg-down/10 hover:text-down disabled:opacity-60"
                  >
                    {revoking === t.id ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {listError && (
            <div className="mt-3">
              <ErrorBanner>{listError}</ErrorBanner>
            </div>
          )}
        </div>
      </Card>

      <Card className="p-5">
        <CardHeader>
          <CardTitle>Try it</CardTitle>
        </CardHeader>
        <p className="-mt-1 mb-4 text-sm text-ink-muted">
          Send the token as a Bearer header. Every admin endpoint the app uses accepts it.
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
          <CardTitle>API_TOKEN Worker secret</CardTitle>
          {data && (
            <Chip tone={data.secretConfigured ? "up" : "neutral"}>{data.secretConfigured ? "Set" : "Not set"}</Chip>
          )}
        </CardHeader>
        <p className="-mt-1 mb-4 text-sm text-ink-muted">
          The older way to make a token: a secret on the Worker, which works beside the tokens above. Cloudflare never shows
          its value, so OpenPing can&apos;t either.{" "}
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
    </div>
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
