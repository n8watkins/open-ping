import {
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Loader2,
  Plus,
  Pencil,
  Trash2,
  X,
  Wrench,
  Globe,
  Server,
} from "lucide-react";
import { useFetch } from "../lib/useFetch";
import { api, ApiError } from "../lib/api";
import { useBootstrap } from "../lib/bootstrap";
import { Card, CardHeader, CardTitle } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { formatDateTime } from "../lib/format";
import { cn } from "../lib/cn";

// ---------------------------------------------------------------------------
// Types (mirror the server records; the client owns its view)
// ---------------------------------------------------------------------------

type MaintenanceScope = "global" | "monitors";

interface MaintenanceWindow {
  id: string;
  title: string;
  scope: MaintenanceScope | string;
  monitorIds: string[] | null;
  startsAt: number;
  endsAt: number;
  recurrence: unknown;
  publicMessage: string | null;
  privateNotes: string | null;
}

interface MonitorOption {
  id: string;
  name: string;
}

type WindowState = "active" | "upcoming" | "ended";

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

/**
 * The list route is expected to return `{ windows: [...] }`, but tolerate a
 * `{ maintenance: [...] }` envelope or a bare array so the page renders
 * regardless of the final server shape.
 */
function extractWindows(data: unknown): MaintenanceWindow[] {
  if (!data) return [];
  if (Array.isArray(data)) return data as MaintenanceWindow[];
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.windows)) return obj.windows as MaintenanceWindow[];
    if (Array.isArray(obj.maintenance))
      return obj.maintenance as MaintenanceWindow[];
  }
  return [];
}

function windowState(w: MaintenanceWindow, now: number): WindowState {
  if (now >= w.startsAt && now < w.endsAt) return "active";
  if (now < w.startsAt) return "upcoming";
  return "ended";
}

const STATE_RANK: Record<WindowState, number> = {
  active: 0,
  upcoming: 1,
  ended: 2,
};

/** Convert epoch ms to a `datetime-local` value in the browser's local tz. */
function toLocalInput(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

function scopeSummary(
  w: MaintenanceWindow,
  byId: Map<string, string>,
): string {
  if (w.scope !== "monitors") return "All monitors";
  const ids = w.monitorIds ?? [];
  if (ids.length === 0) return "No monitors";
  const names = ids.map((id) => byId.get(id) ?? "Unknown monitor");
  if (names.length <= 2) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2} more`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Maintenance() {
  const { csrf } = useBootstrap();

  const {
    data,
    loading,
    error,
    reload,
  } = useFetch<unknown>("/api/maintenance");
  const { data: monData } = useFetch<{ monitors: MonitorOption[] }>(
    "/api/monitors",
  );

  const monitors = monData?.monitors ?? [];
  const monitorsById = useMemo(() => {
    const m = new Map<string, string>();
    for (const mon of monitors) m.set(mon.id, mon.name);
    return m;
  }, [monitors]);

  const now = Date.now();
  const windows = useMemo(() => {
    const list = extractWindows(data);
    return [...list].sort((a, b) => {
      const ra = STATE_RANK[windowState(a, now)];
      const rb = STATE_RANK[windowState(b, now)];
      if (ra !== rb) return ra - rb;
      // Upcoming: soonest first. Active/ended: most recent start first.
      return ra === 1 ? a.startsAt - b.startsAt : b.startsAt - a.startsAt;
    });
  }, [data, now]);

  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({});

  async function deleteWindow(w: MaintenanceWindow) {
    if (!window.confirm(`Delete maintenance window "${w.title}"?`)) return;
    setRowBusy((m) => ({ ...m, [w.id]: true }));
    try {
      await api(`/api/maintenance/${w.id}`, {
        method: "DELETE",
        csrf: csrf ?? undefined,
      });
      await reload();
    } catch {
      /* surfaced on next load */
    } finally {
      setRowBusy((m) => ({ ...m, [w.id]: false }));
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Maintenance</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Schedule maintenance windows to suppress alerts and show planned
          downtime on your status page.
        </p>
      </div>

      <section className="mt-6">
        <Card>
          <CardHeader>
            <CardTitle>Maintenance windows</CardTitle>
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
                Schedule maintenance
              </button>
            )}
          </CardHeader>

          {adding && (
            <div className="mb-4">
              <MaintenanceForm
                existing={null}
                monitors={monitors}
                csrf={csrf ?? undefined}
                onSaved={() => {
                  setAdding(false);
                  void reload();
                }}
                onCancel={() => setAdding(false)}
              />
            </div>
          )}

          {loading && !data ? (
            <div className="grid place-items-center py-10">
              <Loader2 className="size-5 animate-spin text-ink-faint" />
            </div>
          ) : error ? (
            <p className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
              Could not load maintenance windows: {error}
            </p>
          ) : windows.length === 0 && !adding ? (
            <EmptyState
              icon={<Wrench className="size-6 text-accent" />}
              title="No maintenance scheduled"
              description="Schedule a maintenance window to pause alerting and let visitors know about planned work."
            />
          ) : (
            <div className="divide-y divide-line overflow-hidden rounded-lg border border-line">
              {windows.map((w) =>
                editingId === w.id ? (
                  <div key={w.id} className="p-3">
                    <MaintenanceForm
                      existing={w}
                      monitors={monitors}
                      csrf={csrf ?? undefined}
                      onSaved={() => {
                        setEditingId(null);
                        void reload();
                      }}
                      onCancel={() => setEditingId(null)}
                    />
                  </div>
                ) : (
                  <WindowRow
                    key={w.id}
                    win={w}
                    state={windowState(w, now)}
                    scopeText={scopeSummary(w, monitorsById)}
                    busy={!!rowBusy[w.id]}
                    onEdit={() => {
                      setEditingId(w.id);
                      setAdding(false);
                    }}
                    onDelete={() => void deleteWindow(w)}
                  />
                ),
              )}
            </div>
          )}
        </Card>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Window row
// ---------------------------------------------------------------------------

function WindowRow({
  win: w,
  state,
  scopeText,
  busy,
  onEdit,
  onDelete,
}: {
  win: MaintenanceWindow;
  state: WindowState;
  scopeText: string;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const global = w.scope !== "monitors";
  return (
    <div className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{w.title}</span>
          <StateBadge state={state} />
          {w.recurrence ? (
            <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] text-ink-faint">
              Recurring
            </span>
          ) : null}
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-xs text-ink-muted">
          {global ? (
            <Globe className="size-3.5 text-ink-faint" />
          ) : (
            <Server className="size-3.5 text-ink-faint" />
          )}
          {scopeText}
        </div>
        <div className="mt-0.5 text-xs text-ink-faint">
          {formatDateTime(w.startsAt)} — {formatDateTime(w.endsAt)}
        </div>
        {w.publicMessage && (
          <p className="mt-1 max-w-prose text-xs text-ink-muted">
            {w.publicMessage}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <IconButton title="Edit" onClick={onEdit} disabled={busy}>
          <Pencil className="size-4" />
        </IconButton>
        <IconButton title="Delete" onClick={onDelete} disabled={busy} danger>
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Trash2 className="size-4" />
          )}
        </IconButton>
      </div>
    </div>
  );
}

function StateBadge({ state }: { state: WindowState }) {
  if (state === "active") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-maint/40 bg-maint/10 px-2.5 py-0.5 text-[11px] font-medium text-maint">
        <span className="size-1.5 rounded-full bg-maint" />
        Active now
      </span>
    );
  }
  if (state === "upcoming") {
    return (
      <span className="inline-flex items-center rounded-full border border-line bg-surface-2 px-2.5 py-0.5 text-[11px] font-medium text-ink-muted">
        Scheduled
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full border border-line bg-surface-2 px-2.5 py-0.5 text-[11px] font-medium text-ink-faint">
      Ended
    </span>
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
// Schedule / edit form
// ---------------------------------------------------------------------------

function MaintenanceForm({
  existing,
  monitors,
  csrf,
  onSaved,
  onCancel,
}: {
  existing: MaintenanceWindow | null;
  monitors: MonitorOption[];
  csrf: string | undefined;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const isEdit = existing != null;

  const [title, setTitle] = useState(existing?.title ?? "");
  const [scope, setScope] = useState<MaintenanceScope>(
    existing?.scope === "monitors" ? "monitors" : "global",
  );
  const [monitorIds, setMonitorIds] = useState<string[]>(
    existing?.monitorIds ?? [],
  );
  const [startsAt, setStartsAt] = useState(
    existing ? toLocalInput(existing.startsAt) : "",
  );
  const [endsAt, setEndsAt] = useState(
    existing ? toLocalInput(existing.endsAt) : "",
  );
  const [publicMessage, setPublicMessage] = useState(
    existing?.publicMessage ?? "",
  );
  const [privateNotes, setPrivateNotes] = useState(existing?.privateNotes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleMonitor(id: string) {
    setMonitorIds((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id],
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const startMs = startsAt ? new Date(startsAt).getTime() : NaN;
    const endMs = endsAt ? new Date(endsAt).getTime() : NaN;

    if (!title.trim()) {
      setError("Title is required.");
      return;
    }
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      setError("Start and end times are required.");
      return;
    }
    if (endMs <= startMs) {
      setError("End time must be after the start time.");
      return;
    }
    if (scope === "monitors" && monitorIds.length === 0) {
      setError("Select at least one monitor, or switch to all monitors.");
      return;
    }

    const payload = {
      title: title.trim(),
      scope,
      monitorIds: scope === "monitors" ? monitorIds : undefined,
      startsAt: startMs,
      endsAt: endMs,
      publicMessage: publicMessage.trim() || undefined,
      privateNotes: privateNotes.trim() || undefined,
    };

    setSaving(true);
    setError(null);
    try {
      if (isEdit && existing) {
        await api(`/api/maintenance/${existing.id}`, {
          method: "PUT",
          csrf,
          json: payload,
        });
      } else {
        await api("/api/maintenance", {
          method: "POST",
          csrf,
          json: payload,
        });
      }
      onSaved();
    } catch (err) {
      setError(errMessage(err, "Could not save maintenance window."));
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
          {isEdit ? "Edit maintenance window" : "Schedule maintenance"}
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

      <Field label="Title">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Database upgrade"
          className="input"
          required
        />
      </Field>

      <Field label="Scope">
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as MaintenanceScope)}
          className="input"
        >
          <option value="global">All monitors</option>
          <option value="monitors">Specific monitors</option>
        </select>
      </Field>

      {scope === "monitors" && (
        <Field label="Monitors">
          {monitors.length === 0 ? (
            <p className="text-xs text-ink-faint">No monitors available.</p>
          ) : (
            <div className="max-h-48 space-y-1.5 overflow-y-auto rounded-lg border border-line bg-surface p-2.5">
              {monitors.map((m) => (
                <label
                  key={m.id}
                  className="flex cursor-pointer items-center gap-2 text-sm text-ink"
                >
                  <input
                    type="checkbox"
                    checked={monitorIds.includes(m.id)}
                    onChange={() => toggleMonitor(m.id)}
                    className="size-4 accent-accent"
                  />
                  <span className="truncate">{m.name}</span>
                </label>
              ))}
            </div>
          )}
        </Field>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Starts">
          <input
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            className="input"
            required
          />
        </Field>
        <Field label="Ends">
          <input
            type="datetime-local"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
            className="input"
            required
          />
        </Field>
      </div>

      <Field
        label="Public message (optional)"
        hint="Shown to visitors on your public status page."
      >
        <textarea
          value={publicMessage}
          onChange={(e) => setPublicMessage(e.target.value)}
          placeholder="We're performing scheduled maintenance and expect brief downtime."
          rows={2}
          className="input resize-y"
        />
      </Field>

      <Field
        label="Private notes (optional)"
        hint="Internal only — never shown publicly."
      >
        <textarea
          value={privateNotes}
          onChange={(e) => setPrivateNotes(e.target.value)}
          placeholder="Runbook link, on-call owner, rollback plan…"
          rows={2}
          className="input resize-y"
        />
      </Field>

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
          {isEdit ? "Save changes" : "Schedule"}
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
// Shared field wrapper
// ---------------------------------------------------------------------------

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-ink-muted">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-faint">{hint}</span>}
    </label>
  );
}
