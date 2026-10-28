import { useState } from "react";
import { Loader2, Pencil, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { formatDateTime, formatRelativeTime, formatShortDateTime } from "../lib/format";
import {
  INCIDENT_UPDATE_LABELS,
  INCIDENT_UPDATE_STATUSES,
  type IncidentUpdateStatus,
} from "../../shared/incident-updates";

/** One status update as GET /api/incidents/:id returns it. */
export interface IncidentUpdateItem {
  id: string;
  status: IncidentUpdateStatus;
  message: string;
  postedAt: number;
  updatedAt: number;
}

const MAX_MESSAGE = 2000;

const TONE: Record<IncidentUpdateStatus, string> = {
  investigating: "text-down",
  identified: "text-warming",
  monitoring: "text-maint",
  resolved: "text-up",
};

/** What POST /api/incidents/:id/updates says about the alerts it queued. */
interface PostUpdateResponse {
  alertsQueued?: number;
  alertsError?: string;
}

/** One line on what happened to a new update's alerts. */
function alertsNote(notify: boolean, r: PostUpdateResponse): string {
  if (!notify) return "Posted without alerts.";
  if (r.alertsError) return "Posted, but its alerts could not be queued.";
  const n = r.alertsQueued ?? 0;
  if (n === 0) return "Posted. No alert channel takes incident updates for this monitor.";
  return `Posted. ${n} alert channel${n === 1 ? "" : "s"} will hear about it within 12 minutes.`;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong.";
}

/** Status choice as a row of pressed buttons (four short options). */
function StatusPicker({
  value,
  onChange,
  label,
}: {
  value: IncidentUpdateStatus;
  onChange: (s: IncidentUpdateStatus) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="grid grid-cols-2 gap-1 rounded-lg border border-line bg-surface p-0.5 sm:grid-cols-4">
      {INCIDENT_UPDATE_STATUSES.map((s) => (
        <button
          key={s}
          type="button"
          aria-pressed={value === s}
          onClick={() => onChange(s)}
          className={cn(
            "rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
            value === s ? cn("bg-surface-2", TONE[s]) : "text-ink-muted hover:text-ink",
          )}
        >
          {INCIDENT_UPDATE_LABELS[s]}
        </button>
      ))}
    </div>
  );
}

/**
 * The incident's public timeline in the admin detail panel: post a new status
 * update, and edit or delete earlier ones. `onChanged` reloads the incident.
 */
export function IncidentUpdatesEditor({
  incidentId,
  updates,
  isPublic,
  csrf,
  onChanged,
}: {
  incidentId: string;
  updates: IncidentUpdateItem[];
  isPublic: boolean;
  csrf: string | undefined;
  onChanged: () => Promise<void> | void;
}) {
  // Start from the incident's current status (the newest update's).
  const [status, setStatus] = useState<IncidentUpdateStatus>(updates[0]?.status ?? "investigating");
  const [message, setMessage] = useState("");
  const [notify, setNotify] = useState(true);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function post() {
    if (!message.trim()) {
      setError("Write a message for this update.");
      return;
    }
    setPosting(true);
    setError(null);
    setNote(null);
    try {
      const r = await api<PostUpdateResponse>(`/api/incidents/${incidentId}/updates`, {
        method: "POST",
        json: { status, message, notify },
        csrf,
      });
      setMessage("");
      setNote(alertsNote(notify, r));
      await onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="border-b border-line p-4">
      <div className="mb-1 text-xs font-medium text-ink-muted">Status updates</div>
      <p className="mb-3 text-xs text-ink-faint">
        {isPublic
          ? "Shown on the public status page and its feeds, newest first."
          : "Shown publicly once this incident is on the public status page."}
      </p>

      <div className="space-y-2">
        <StatusPicker value={status} onChange={setStatus} label="Status of the new update" />
        <label className="block">
          <span className="sr-only">Update message</span>
          <textarea
            className="input"
            rows={3}
            name="update-message"
            maxLength={MAX_MESSAGE}
            value={message}
            onChange={(e) => {
              setMessage(e.target.value);
              setError(null);
              setNote(null);
            }}
            placeholder="What's happening, for the people reading the status page."
          />
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-muted">
          <input
            type="checkbox"
            name="update-notify"
            checked={notify}
            onChange={(e) => setNotify(e.target.checked)}
            className="size-3.5 accent-accent"
          />
          Alert this monitor's notification channels
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void post()}
            disabled={posting}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-canvas transition-colors hover:bg-accent-hover disabled:opacity-60"
          >
            {posting && <Loader2 className="size-4 animate-spin" />}
            Post update
          </button>
          {error && (
            <span role="alert" className="text-xs text-down">
              {error}
            </span>
          )}
          {!error && note && (
            <span role="status" className="text-xs text-ink-muted">
              {note}
            </span>
          )}
        </div>
      </div>

      {updates.length > 0 && (
        <ol className="mt-4 space-y-3">
          {updates.map((u) => (
            <UpdateRow key={u.id} incidentId={incidentId} update={u} csrf={csrf} onChanged={onChanged} />
          ))}
        </ol>
      )}
    </div>
  );
}

function UpdateRow({
  incidentId,
  update,
  csrf,
  onChanged,
}: {
  incidentId: string;
  update: IncidentUpdateItem;
  csrf: string | undefined;
  onChanged: () => Promise<void> | void;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "confirm-delete">("view");
  const [status, setStatus] = useState(update.status);
  const [message, setMessage] = useState(update.message);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = `/api/incidents/${incidentId}/updates/${update.id}`;

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onChanged();
      setMode("view");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const save = () => {
    if (!message.trim()) {
      setError("Write a message for this update.");
      return;
    }
    void run(() => api(path, { method: "PATCH", json: { status, message }, csrf }));
  };
  const remove = () => void run(() => api(path, { method: "DELETE", csrf }));

  const edited = update.updatedAt > update.postedAt + 1000;

  return (
    <li className="rounded-lg border border-line bg-surface-2/40 p-3 text-sm">
      {mode === "edit" ? (
        <div className="space-y-2">
          <StatusPicker value={status} onChange={setStatus} label="Status of this update" />
          <label className="block">
            <span className="sr-only">Update message</span>
            <textarea
              className="input"
              rows={3}
              name="update-message"
            maxLength={MAX_MESSAGE}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-canvas transition-colors hover:bg-accent-hover disabled:opacity-60"
            >
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("view");
                setStatus(update.status);
                setMessage(update.message);
                setError(null);
              }}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:text-ink"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className={cn("text-xs font-semibold", TONE[update.status])}>
                {INCIDENT_UPDATE_LABELS[update.status]}
              </span>
              <time
                dateTime={new Date(update.postedAt).toISOString()}
                title={formatDateTime(update.postedAt)}
                className="text-xs text-ink-faint"
              >
                {formatRelativeTime(update.postedAt)} · {formatShortDateTime(update.postedAt)}
                {edited && " · edited"}
              </time>
            </div>
            {mode === "view" && (
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => setMode("edit")}
                  className="rounded p-1 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
                  aria-label="Edit update"
                  title="Edit"
                >
                  <Pencil className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setMode("confirm-delete")}
                  className="rounded p-1 text-ink-faint transition-colors hover:bg-surface-2 hover:text-down"
                  aria-label="Delete update"
                  title="Delete"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            )}
          </div>
          <p className="mt-1 break-words whitespace-pre-line text-ink-muted">{update.message}</p>
          {mode === "confirm-delete" && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="text-ink-muted">Delete this update?</span>
              <button
                type="button"
                onClick={remove}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg bg-down px-2.5 py-1 font-medium text-canvas disabled:opacity-60"
              >
                {busy && <Loader2 className="size-3 animate-spin" />}
                Delete
              </button>
              <button
                type="button"
                onClick={() => setMode("view")}
                className="rounded-lg px-2.5 py-1 font-medium text-ink-muted hover:text-ink"
              >
                Keep
              </button>
            </div>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-down">
          {error}
        </p>
      )}
    </li>
  );
}
