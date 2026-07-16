import { useState, type FormEvent, type ReactNode } from "react";
import {
  Loader2,
  Plus,
  Send,
  Pencil,
  Trash2,
  X,
  MessageSquare,
  Webhook,
  Mail,
  Smartphone,
  KeyRound,
  Power,
  PowerOff,
  CheckCircle2,
  XCircle,
  Bell,
} from "lucide-react";
import { useFetch } from "../lib/useFetch";
import { api, ApiError } from "../lib/api";
import { useBootstrap } from "../lib/bootstrap";
import {
  isPushSupported,
  registerServiceWorker,
  subscribeToPush,
} from "../lib/push";
import { Card, CardHeader, CardTitle } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { formatRelativeTime } from "../lib/format";
import { cn } from "../lib/cn";

// ---------------------------------------------------------------------------
// Types (local — these mirror the server records but the client owns its view)
// ---------------------------------------------------------------------------

type ChannelType = "discord" | "webhook" | "email";

interface Channel {
  id: string;
  type: ChannelType | "push" | string;
  name: string | null;
  enabled: boolean;
  config: Record<string, unknown>;
  events: string[] | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
}

interface PushDevice {
  id: string;
  label: string | null;
  userAgent: string | null;
  platform: string | null;
  createdAt: number;
  lastSuccessAt: number | null;
  disabled: boolean;
}

interface TestResult {
  state: "loading" | "done";
  ok?: boolean;
  error?: string;
}

const CHANNEL_META: Record<
  string,
  { label: string; icon: ReactNode }
> = {
  discord: { label: "Discord", icon: <MessageSquare className="size-4" /> },
  webhook: { label: "Webhooks", icon: <Webhook className="size-4" /> },
  email: { label: "Email", icon: <Mail className="size-4" /> },
  push: { label: "Push", icon: <Bell className="size-4" /> },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const d = e.data as { error?: string } | null;
    if (d && typeof d.error === "string") return d.error;
  }
  return e instanceof Error ? e.message : fallback;
}

/** Channel is healthy when it has never failed, or last success is newer. */
function channelHealthy(ch: Channel): boolean {
  if (ch.lastFailureAt == null) return true;
  if (ch.lastSuccessAt == null) return false;
  return ch.lastSuccessAt >= ch.lastFailureAt;
}

function cfgStr(config: Record<string, unknown>, key: string): string {
  const v = config[key];
  return typeof v === "string" ? v : "";
}

function metaFor(type: string) {
  return CHANNEL_META[type] ?? { label: type, icon: <Webhook className="size-4" /> };
}

function deviceName(d: PushDevice): string {
  if (d.label) return d.label;
  if (d.platform) return d.platform;
  return "Unknown device";
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Integrations() {
  const { csrf } = useBootstrap();

  const {
    data: chData,
    loading: chLoading,
    error: chError,
    reload: reloadChannels,
  } = useFetch<{ channels: Channel[] }>("/api/channels");

  const channels = chData?.channels ?? [];

  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({});

  async function testChannel(id: string) {
    setTestResults((m) => ({ ...m, [id]: { state: "loading" } }));
    try {
      const res = await api<{ ok: boolean; error?: string }>(
        `/api/channels/${id}/test`,
        { method: "POST", csrf: csrf ?? undefined },
      );
      setTestResults((m) => ({
        ...m,
        [id]: { state: "done", ok: res.ok, error: res.error },
      }));
    } catch (e) {
      setTestResults((m) => ({
        ...m,
        [id]: { state: "done", ok: false, error: errMessage(e, "Test failed") },
      }));
    }
  }

  async function toggleChannel(ch: Channel) {
    setRowBusy((m) => ({ ...m, [ch.id]: true }));
    try {
      await api(`/api/channels/${ch.id}`, {
        method: "PUT",
        csrf: csrf ?? undefined,
        json: { enabled: !ch.enabled },
      });
      await reloadChannels();
    } catch {
      /* surfaced on next load; keep UI responsive */
    } finally {
      setRowBusy((m) => ({ ...m, [ch.id]: false }));
    }
  }

  async function deleteChannel(ch: Channel) {
    if (!window.confirm(`Delete channel "${ch.name ?? ch.type}"?`)) return;
    setRowBusy((m) => ({ ...m, [ch.id]: true }));
    try {
      await api(`/api/channels/${ch.id}`, {
        method: "DELETE",
        csrf: csrf ?? undefined,
      });
      await reloadChannels();
    } catch {
      /* ignore */
    } finally {
      setRowBusy((m) => ({ ...m, [ch.id]: false }));
    }
  }

  // Group channels by type, preserving a stable order.
  const groups = new Map<string, Channel[]>();
  for (const ch of channels) {
    const arr = groups.get(ch.type) ?? [];
    arr.push(ch);
    groups.set(ch.type, arr);
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Integrations</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Notification channels and push devices that receive OpenPing alerts.
        </p>
      </div>

      {/* ---- Notification channels --------------------------------------- */}
      <section className="mt-6">
        <Card>
          <CardHeader>
            <CardTitle>Notification channels</CardTitle>
            {!adding && (
              <button
                type="button"
                onClick={() => {
                  setAdding(true);
                  setEditingId(null);
                }}
                className="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-canvas transition-colors hover:bg-accent-hover"
              >
                <Plus className="size-4" />
                Add channel
              </button>
            )}
          </CardHeader>

          {adding && (
            <div className="mb-4">
              <ChannelForm
                existing={null}
                csrf={csrf ?? undefined}
                onSaved={() => {
                  setAdding(false);
                  void reloadChannels();
                }}
                onCancel={() => setAdding(false)}
              />
            </div>
          )}

          {chLoading && !chData ? (
            <div className="grid place-items-center py-10">
              <Loader2 className="size-5 animate-spin text-ink-faint" />
            </div>
          ) : chError ? (
            <p className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
              Could not load channels: {chError}
            </p>
          ) : channels.length === 0 && !adding ? (
            <EmptyState
              icon={<Bell className="size-6 text-accent" />}
              title="No channels yet"
              description="Add a Discord, webhook, or email channel to start receiving incident notifications."
            />
          ) : (
            <div className="space-y-5">
              {[...groups.entries()].map(([type, list]) => {
                const meta = metaFor(type);
                return (
                  <div key={type}>
                    <div className="mb-2 flex items-center gap-2 text-xs font-medium text-ink-muted">
                      {meta.icon}
                      {meta.label}
                    </div>
                    <div className="divide-y divide-line overflow-hidden rounded-lg border border-line">
                      {list.map((ch) =>
                        editingId === ch.id ? (
                          <div key={ch.id} className="p-3">
                            <ChannelForm
                              existing={ch}
                              csrf={csrf ?? undefined}
                              onSaved={() => {
                                setEditingId(null);
                                void reloadChannels();
                              }}
                              onCancel={() => setEditingId(null)}
                            />
                          </div>
                        ) : (
                          <ChannelRow
                            key={ch.id}
                            channel={ch}
                            busy={!!rowBusy[ch.id]}
                            test={testResults[ch.id]}
                            onTest={() => void testChannel(ch.id)}
                            onToggle={() => void toggleChannel(ch)}
                            onEdit={() => {
                              setEditingId(ch.id);
                              setAdding(false);
                            }}
                            onDelete={() => void deleteChannel(ch)}
                          />
                        ),
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </section>

      {/* ---- Push devices ------------------------------------------------ */}
      <section className="mt-6">
        <PushDevices csrf={csrf ?? undefined} />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Channel row
// ---------------------------------------------------------------------------

function ChannelRow({
  channel,
  busy,
  test,
  onTest,
  onToggle,
  onEdit,
  onDelete,
}: {
  channel: Channel;
  busy: boolean;
  test: TestResult | undefined;
  onTest: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const healthy = channelHealthy(channel);
  const target =
    cfgStr(channel.config, "to") ||
    (channel.type === "email" ? "" : "Destination stored securely");

  return (
    <div className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <span
          className={cn(
            "mt-1.5 size-2 shrink-0 rounded-full",
            !channel.enabled ? "bg-paused" : healthy ? "bg-up" : "bg-down",
          )}
          title={
            !channel.enabled
              ? "Disabled"
              : healthy
                ? "Healthy"
                : channel.lastError ?? "Failing"
          }
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">
              {channel.name ?? metaFor(channel.type).label}
            </span>
            {!channel.enabled && (
              <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] text-ink-faint">
                Disabled
              </span>
            )}
          </div>
          {target && (
            <div className="truncate text-xs text-ink-faint">{target}</div>
          )}
          {channel.enabled && !healthy && channel.lastError && (
            <div className="mt-0.5 truncate text-xs text-down">
              {channel.lastError}
            </div>
          )}
          {test?.state === "done" && (
            <div
              className={cn(
                "mt-1 flex items-center gap-1.5 text-xs",
                test.ok ? "text-up" : "text-down",
              )}
            >
              {test.ok ? (
                <CheckCircle2 className="size-3.5" />
              ) : (
                <XCircle className="size-3.5" />
              )}
              {test.ok ? "Test delivered" : test.error ?? "Test failed"}
            </div>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <IconButton title="Send test" onClick={onTest} disabled={busy}>
          {test?.state === "loading" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Send className="size-4" />
          )}
        </IconButton>
        <IconButton
          title={channel.enabled ? "Disable" : "Enable"}
          onClick={onToggle}
          disabled={busy}
        >
          {channel.enabled ? (
            <PowerOff className="size-4" />
          ) : (
            <Power className="size-4" />
          )}
        </IconButton>
        <IconButton title="Edit" onClick={onEdit} disabled={busy}>
          <Pencil className="size-4" />
        </IconButton>
        <IconButton title="Delete" onClick={onDelete} disabled={busy} danger>
          <Trash2 className="size-4" />
        </IconButton>
      </div>
    </div>
  );
}

function IconButton({
  children,
  title,
  onClick,
  disabled,
  danger,
}: {
  children: ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "grid size-8 place-items-center rounded-lg text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40",
        danger && "hover:text-down",
      )}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Add / edit channel form
// ---------------------------------------------------------------------------

function ChannelForm({
  existing,
  csrf,
  onSaved,
  onCancel,
}: {
  existing: Channel | null;
  csrf: string | undefined;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const isEdit = existing != null;
  const initialType: ChannelType =
    existing?.type === "email" ||
    existing?.type === "discord" ||
    existing?.type === "webhook"
      ? existing.type
      : "discord";

  const [type, setType] = useState<ChannelType>(initialType);
  const [name, setName] = useState(existing?.name ?? "");
  const [url, setUrl] = useState(existing ? cfgStr(existing.config, "url") : "");
  const [secret, setSecret] = useState(
    existing ? cfgStr(existing.config, "secret") : "",
  );
  const [to, setTo] = useState(existing ? cfgStr(existing.config, "to") : "");
  const [from, setFrom] = useState(
    existing ? cfgStr(existing.config, "from") : "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function buildConfig(): Record<string, unknown> {
    if (type === "discord") return { url: url.trim() };
    if (type === "webhook")
      return secret.trim()
        ? { url: url.trim(), secret: secret.trim() }
        : { url: url.trim() };
    return from.trim() ? { to: to.trim(), from: from.trim() } : { to: to.trim() };
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const config = buildConfig();
      const trimmedName = name.trim();
      if (isEdit && existing) {
        await api(`/api/channels/${existing.id}`, {
          method: "PUT",
          csrf,
          json: { name: trimmedName || undefined, config },
        });
      } else {
        await api("/api/channels", {
          method: "POST",
          csrf,
          json: { type, name: trimmedName || undefined, config },
        });
      }
      onSaved();
    } catch (err) {
      setError(errMessage(err, "Could not save channel."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-lg border border-line bg-surface-2/40 p-4"
    >
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium">
          {isEdit ? "Edit channel" : "Add channel"}
        </h4>
        <button
          type="button"
          onClick={onCancel}
          className="grid size-7 place-items-center rounded-lg text-ink-muted hover:bg-surface-2 hover:text-ink"
          aria-label="Cancel"
        >
          <X className="size-4" />
        </button>
      </div>

      {!isEdit && (
        <Field label="Type">
          <select
            value={type}
            onChange={(e) => setType(e.target.value as ChannelType)}
            className="input"
          >
            <option value="discord">Discord</option>
            <option value="webhook">Webhook</option>
            <option value="email">Email</option>
          </select>
        </Field>
      )}

      <Field label="Name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. On-call Discord"
          className="input"
        />
      </Field>

      {type === "discord" && (
        <Field label="Discord webhook URL">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={
              isEdit
                ? "Leave blank to keep the current URL"
                : "https://discord.com/api/webhooks/..."
            }
            type="url"
            required={!isEdit}
            className="input"
          />
        </Field>
      )}

      {type === "webhook" && (
        <>
          <Field label="Webhook URL">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={
                isEdit
                  ? "Leave blank to keep the current URL"
                  : "https://example.com/hooks/openping"
              }
              type="url"
              required={!isEdit}
              className="input"
            />
          </Field>
          <Field label="Signing secret (optional)">
            <input
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="Used to sign the payload (HMAC)"
              className="input"
            />
          </Field>
        </>
      )}

      {type === "email" && (
        <>
          <Field label="Recipient address">
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="alerts@example.com"
              type="email"
              required
              className="input"
            />
          </Field>
          <Field label="From address (optional)">
            <input
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              placeholder="openping@example.com"
              type="email"
              className="input"
            />
          </Field>
        </>
      )}

      {error && (
        <p className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-canvas transition-colors hover:bg-accent-hover disabled:opacity-60"
        >
          {saving && <Loader2 className="size-4 animate-spin" />}
          {isEdit ? "Save changes" : "Add channel"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-3 py-2 text-sm text-ink-muted transition-colors hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Push devices
// ---------------------------------------------------------------------------

function PushDevices({ csrf }: { csrf: string | undefined }) {
  const {
    data: vapidData,
    loading: vapidLoading,
    reload: reloadVapid,
  } = useFetch<{ publicKey: string | null }>("/api/push/vapid-public-key");
  const {
    data: devData,
    loading: devLoading,
    error: devListError,
    reload: reloadDevices,
  } = useFetch<{ devices: PushDevice[] }>("/api/push/devices");

  const publicKey = vapidData?.publicKey ?? null;
  const devices = devData?.devices ?? [];
  const supported = isPushSupported();

  const [vapidBusy, setVapidBusy] = useState(false);
  const [enableBusy, setEnableBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({});
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});

  async function generateVapid() {
    setVapidBusy(true);
    setError(null);
    try {
      await api("/api/push/generate-vapid", {
        method: "POST",
        csrf,
      });
      await reloadVapid();
    } catch (e) {
      setError(errMessage(e, "Could not generate VAPID keys."));
    } finally {
      setVapidBusy(false);
    }
  }

  async function enableThisDevice() {
    setEnableBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (!supported) {
        setError("Push notifications aren't supported in this browser.");
        return;
      }
      if (!publicKey) {
        setError("Generate VAPID keys before enabling push.");
        return;
      }
      const reg = await registerServiceWorker();
      if (!reg) {
        setError("Could not register the service worker.");
        return;
      }
      const sub = await subscribeToPush(publicKey);
      if (!sub) {
        setError("Push permission was denied or unavailable.");
        return;
      }
      await api("/api/push/subscribe", {
        method: "POST",
        csrf,
        json: { endpoint: sub.endpoint, keys: sub.keys },
      });
      setNotice("This device is now subscribed to push notifications.");
      await reloadDevices();
    } catch (e) {
      setError(errMessage(e, "Could not enable push on this device."));
    } finally {
      setEnableBusy(false);
    }
  }

  async function testDevice(id: string) {
    setTestResults((m) => ({ ...m, [id]: { state: "loading" } }));
    try {
      const res = await api<{ ok: boolean; error?: string }>(
        `/api/push/devices/${id}/test`,
        { method: "POST", csrf },
      );
      setTestResults((m) => ({
        ...m,
        [id]: { state: "done", ok: res.ok, error: res.error },
      }));
      await reloadDevices();
    } catch (e) {
      setTestResults((m) => ({
        ...m,
        [id]: { state: "done", ok: false, error: errMessage(e, "Test failed") },
      }));
    }
  }

  async function toggleDevice(d: PushDevice) {
    setRowBusy((m) => ({ ...m, [d.id]: true }));
    try {
      await api(`/api/push/devices/${d.id}/${d.disabled ? "enable" : "disable"}`, {
        method: "POST",
        csrf,
      });
      await reloadDevices();
    } catch (e) {
      setError(errMessage(e, "Could not update device."));
    } finally {
      setRowBusy((m) => ({ ...m, [d.id]: false }));
    }
  }

  async function removeDevice(d: PushDevice) {
    if (!window.confirm(`Remove "${deviceName(d)}"?`)) return;
    setRowBusy((m) => ({ ...m, [d.id]: true }));
    try {
      await api(`/api/push/devices/${d.id}`, { method: "DELETE", csrf });
      await reloadDevices();
    } catch (e) {
      setError(errMessage(e, "Could not remove device."));
    } finally {
      setRowBusy((m) => ({ ...m, [d.id]: false }));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Push devices</CardTitle>
        <div className="flex items-center gap-2">
          {publicKey == null && !vapidLoading && (
            <button
              type="button"
              onClick={() => void generateVapid()}
              disabled={vapidBusy}
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-canvas transition-colors hover:bg-accent-hover disabled:opacity-60"
            >
              {vapidBusy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <KeyRound className="size-4" />
              )}
              Enable push / generate keys
            </button>
          )}
          {publicKey != null && (
            <button
              type="button"
              onClick={() => void enableThisDevice()}
              disabled={enableBusy || !supported}
              title={supported ? undefined : "Not supported in this browser"}
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-canvas transition-colors hover:bg-accent-hover disabled:opacity-60"
            >
              {enableBusy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Smartphone className="size-4" />
              )}
              Enable on this device
            </button>
          )}
        </div>
      </CardHeader>

      {error && (
        <p
          role="alert"
          className="mb-3 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down"
        >
          {error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="mb-3 rounded-lg border border-up/40 bg-up/10 px-3 py-2 text-sm text-up"
        >
          {notice}
        </p>
      )}
      {!supported && (
        <p className="mb-3 rounded-lg border border-degraded/40 bg-degraded/10 px-3 py-2 text-sm text-degraded">
          This browser doesn't support web push. On Android, open OpenPing in
          Chrome, use the menu to "Add to Home screen", then enable push from the
          installed app for reliable delivery.
        </p>
      )}
      {supported && (
        <p className="mb-3 text-xs text-ink-faint">
          On Android Chrome, install OpenPing ("Add to Home screen") and grant the
          notification permission when prompted so alerts arrive even when the tab
          is closed.
        </p>
      )}

      {devLoading && !devData ? (
        <div className="grid place-items-center py-10">
          <Loader2 className="size-5 animate-spin text-ink-faint" />
        </div>
      ) : devListError ? (
        <p className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
          Could not load devices: {devListError}
        </p>
      ) : devices.length === 0 ? (
        <EmptyState
          icon={<Smartphone className="size-6 text-accent" />}
          title="No push devices"
          description="Enable push on this device to receive incident notifications even when OpenPing isn't open."
        />
      ) : (
        <div className="divide-y divide-line overflow-hidden rounded-lg border border-line">
          {devices.map((d) => {
            const test = testResults[d.id];
            return (
              <div
                key={d.id}
                className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {deviceName(d)}
                    </span>
                    {d.disabled && (
                      <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] text-ink-faint">
                        Disabled
                      </span>
                    )}
                  </div>
                  {d.userAgent && (
                    <div className="truncate text-xs text-ink-faint">
                      {d.userAgent}
                    </div>
                  )}
                  <div className="mt-0.5 text-xs text-ink-faint">
                    Added {formatRelativeTime(d.createdAt)}
                    {d.lastSuccessAt
                      ? ` · last push ${formatRelativeTime(d.lastSuccessAt)}`
                      : ""}
                  </div>
                  {test?.state === "done" && (
                    <div
                      className={cn(
                        "mt-1 flex items-center gap-1.5 text-xs",
                        test.ok ? "text-up" : "text-down",
                      )}
                    >
                      {test.ok ? (
                        <CheckCircle2 className="size-3.5" />
                      ) : (
                        <XCircle className="size-3.5" />
                      )}
                      {test.ok ? "Test delivered" : test.error ?? "Test failed"}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <IconButton
                    title="Send test"
                    onClick={() => void testDevice(d.id)}
                    disabled={!!rowBusy[d.id]}
                  >
                    {test?.state === "loading" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Send className="size-4" />
                    )}
                  </IconButton>
                  <IconButton
                    title={d.disabled ? "Enable" : "Disable"}
                    onClick={() => void toggleDevice(d)}
                    disabled={!!rowBusy[d.id]}
                  >
                    {d.disabled ? (
                      <Power className="size-4" />
                    ) : (
                      <PowerOff className="size-4" />
                    )}
                  </IconButton>
                  <IconButton
                    title="Remove"
                    onClick={() => void removeDevice(d)}
                    disabled={!!rowBusy[d.id]}
                    danger
                  >
                    <Trash2 className="size-4" />
                  </IconButton>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Shared field wrapper
// ---------------------------------------------------------------------------

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-ink-muted">
        {label}
      </span>
      {children}
    </label>
  );
}
