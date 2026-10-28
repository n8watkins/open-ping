import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Fingerprint, Loader2, Plus, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { useFetch } from "../lib/useFetch";
import { formatDateTime, formatRelativeTime } from "../lib/format";
import { hostMatchesRpId, passkeyErrorMessage, passkeysSupported, registerPasskey } from "../lib/webauthn";
import { Card, CardHeader, CardTitle } from "./ui/Card";

interface Passkey {
  id: string;
  name: string;
  rpId: string;
  createdAt: number;
  lastUsedAt: number | null;
  synced: boolean;
}
interface PasskeysResponse {
  passkeys: Passkey[];
  rpId: string;
  origin: string;
  currentPasskeyId: string | null;
  otherSignIn: { github: boolean; email: boolean };
}

/** "MacBook" from a user agent, as a default passkey name. */
export function defaultPasskeyName(ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent): string {
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  if (/Macintosh|Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/CrOS/.test(ua)) return "Chromebook";
  if (/Linux/.test(ua)) return "Linux computer";
  return "Passkey";
}

/**
 * Settings > Sign-in: the admin's passkeys (add, remove), and what else can
 * sign in. A passkey is bound to the install's hostname, so adding one is
 * offered only on that hostname.
 */
export function PasskeysCard({ csrf }: { csrf: string | undefined }) {
  const { data, loading, error, reload } = useFetch<PasskeysResponse>("/api/passkeys");
  const [name, setName] = useState(defaultPasskeyName);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // /recover lands here: every other session was just signed out, but a lost
  // device's passkey still works until it is removed.
  const [params, setParams] = useSearchParams();
  const recovered = params.has("recovered");
  function dismissRecovered() {
    const next = new URLSearchParams(params);
    next.delete("recovered");
    setParams(next, { replace: true, preventScrollReset: true });
  }

  const supported = passkeysSupported();
  const here = hostMatchesRpId(data?.rpId);

  async function add(e: FormEvent) {
    e.preventDefault();
    setAdding(true);
    setActionError(null);
    try {
      await registerPasskey("/api/passkeys/register", name.trim() || "Passkey", { csrf });
      setName(defaultPasskeyName());
      await reload();
    } catch (err) {
      setActionError(passkeyErrorMessage(err));
    } finally {
      setAdding(false);
    }
  }

  async function remove(p: Passkey) {
    const current = p.id === data?.currentPasskeyId;
    const msg = current
      ? `Remove "${p.name}"? You're signed in with it, so this signs you out.`
      : `Remove "${p.name}"? Sessions signed in with it end too.`;
    if (!window.confirm(msg)) return;
    setRemoving(p.id);
    setActionError(null);
    try {
      await api(`/api/passkeys/${encodeURIComponent(p.id)}`, { method: "DELETE", csrf });
      if (current) {
        window.location.assign("/login");
        return;
      }
      await reload();
    } catch (err) {
      setActionError(
        err instanceof Error && err.message === "last_sign_in_method"
          ? "This is your only way to sign in. Add another passkey, or set up GitHub or email sign-in, first."
          : "Couldn't remove the passkey. Please try again.",
      );
    } finally {
      setRemoving(null);
    }
  }

  const others = data
    ? [data.otherSignIn.github && "GitHub", data.otherSignIn.email && "an email link"].filter(Boolean).join(" and ")
    : "";

  return (
    <section id="sign-in" className="scroll-mt-6">
      <Card>
        <CardHeader>
          <CardTitle>Passkeys</CardTitle>
        </CardHeader>
        <p className="-mt-1 mb-4 text-sm text-ink-muted">
          Sign in with your fingerprint, face, screen lock or a security key.
          {data && (
            <>
              {" "}
              Passkeys are tied to this install&apos;s address and work only at{" "}
              <span className="font-mono text-ink">{data.rpId}</span>.
            </>
          )}
        </p>

        {loading && !data ? (
          <div className="grid place-items-center py-6">
            <Loader2 className="size-5 animate-spin text-ink-faint" />
          </div>
        ) : error && !data ? (
          <p role="alert" className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
            Could not load passkeys: {error}
          </p>
        ) : data ? (
          <div className="space-y-4">
            {recovered && (
              <div
                role="status"
                className="flex flex-col gap-2 rounded-lg border border-degraded/40 bg-degraded/10 px-3 py-2.5 text-sm text-ink sm:flex-row sm:items-start"
              >
                <p className="flex-1">
                  Access recovered, and every other device was signed out. Remove any passkey below that you no longer
                  have or don&apos;t recognize: it still signs in until you do.
                </p>
                <button
                  type="button"
                  onClick={dismissRecovered}
                  className="self-start rounded-md px-2 py-0.5 text-xs font-medium text-ink-muted hover:bg-surface-2 hover:text-ink"
                >
                  Done
                </button>
              </div>
            )}
            {data.passkeys.length === 0 ? (
              <p className="rounded-lg border border-dashed border-line px-3 py-3 text-sm text-ink-muted">
                No passkeys yet.
              </p>
            ) : (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {data.passkeys.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 px-3 py-2.5">
                    <Fingerprint className="size-4 shrink-0 text-ink-faint" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="truncate text-sm font-medium text-ink">{p.name}</span>
                        <span className="rounded-full border border-line px-1.5 py-px text-[11px] text-ink-muted">
                          {p.synced ? "Synced" : "This device only"}
                        </span>
                        {p.id === data.currentPasskeyId && (
                          <span className="rounded-full bg-accent-soft px-1.5 py-px text-[11px] text-accent">
                            This session
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-xs text-ink-faint">
                        <span title={formatDateTime(p.createdAt)}>Added {formatRelativeTime(p.createdAt)}</span>
                        {" · "}
                        {p.lastUsedAt ? (
                          <span title={formatDateTime(p.lastUsedAt)}>Last used {formatRelativeTime(p.lastUsedAt)}</span>
                        ) : (
                          "Never used"
                        )}
                        {p.rpId !== data.rpId && <span className="text-degraded"> · for {p.rpId}</span>}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void remove(p)}
                      disabled={removing === p.id}
                      aria-label={`Remove ${p.name}`}
                      className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-surface-2 hover:text-down disabled:opacity-60"
                    >
                      {removing === p.id ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {!supported ? (
              <p className="text-sm text-ink-muted">This browser can&apos;t create passkeys.</p>
            ) : !here ? (
              <p className="rounded-lg border border-degraded/40 bg-degraded/10 px-3 py-2 text-sm text-ink">
                To add a passkey, open OpenPing at{" "}
                <a href={`${data.origin}/settings#sign-in`} className="font-semibold underline underline-offset-4">
                  {data.rpId}
                </a>
                .
              </p>
            ) : (
              <form onSubmit={(e) => void add(e)} className="flex flex-col gap-2 sm:flex-row">
                <label htmlFor="passkey-name" className="sr-only">
                  Passkey name
                </label>
                <input
                  id="passkey-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={64}
                  placeholder="Name, like MacBook or YubiKey"
                  autoComplete="off"
                  className="input sm:max-w-xs"
                />
                <button
                  type="submit"
                  disabled={adding}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-canvas transition-colors hover:bg-accent-hover disabled:opacity-60"
                >
                  {adding ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                  Add a passkey
                </button>
              </form>
            )}
            {actionError && (
              <p role="alert" className="text-sm text-down">
                {actionError}
              </p>
            )}

            <p className="border-t border-line pt-3 text-xs leading-relaxed text-ink-faint">
              {others ? `You can also sign in with ${others}. ` : "Passkeys are your only way to sign in. "}
              Lost every passkey? Set a new <span className="font-mono">SETUP_TOKEN</span> in Cloudflare and use it at{" "}
              <a href="/recover" className="underline underline-offset-2 hover:text-ink">
                /recover
              </a>
              .
            </p>
          </div>
        ) : null}
      </Card>
    </section>
  );
}
