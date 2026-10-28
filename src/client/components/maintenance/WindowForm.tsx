import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { CalendarPlus, Loader2, X } from "lucide-react";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { MonitorPicker, choiceSummary, type MonitorChoice, type MonitorOption } from "./MonitorPicker";
import { formatSpan, formatWindowRange, recurrenceLabel, type MaintenanceWindowItem } from "./windows";

const DURATIONS = [30, 60, 120, 240, 480] as const;
type DurationChoice = (typeof DURATIONS)[number] | "custom";

const DEFAULT_NOTICE = "Scheduled maintenance: some services may be briefly unavailable while we work.";

/** Epoch ms as a `datetime-local` value in the browser's timezone. */
export function toLocalInput(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The next whole hour from now: a sensible default start. */
function nextHour(): number {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d.getTime();
}

function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-xs font-medium text-ink-muted">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-ink-faint">{hint}</p>}
    </div>
  );
}

/** Schedule a planned window, or edit one. */
export function WindowForm({
  existing,
  monitors,
  csrf,
  onSaved,
  onCancel,
  errorMessage,
}: {
  existing: MaintenanceWindowItem | null;
  monitors: MonitorOption[];
  csrf: string | undefined;
  onSaved: () => void;
  onCancel: () => void;
  errorMessage: (e: unknown, fallback: string) => string;
}) {
  const isEdit = existing != null;
  const byId = useMemo(() => new Map(monitors.map((m) => [m.id, m.name])), [monitors]);

  const initialStart = existing?.startsAt ?? nextHour();
  const initialMinutes = existing ? Math.round((existing.endsAt - existing.startsAt) / 60_000) : 60;
  const presetMatch = (DURATIONS as readonly number[]).includes(initialMinutes);

  const [title, setTitle] = useState(existing?.title ?? "");
  const [choice, setChoice] = useState<MonitorChoice>(
    existing && existing.scope === "monitors" && existing.monitorIds?.length ? existing.monitorIds : "all",
  );
  const [start, setStart] = useState(toLocalInput(initialStart));
  const [duration, setDuration] = useState<DurationChoice>(
    presetMatch ? (initialMinutes as DurationChoice) : "custom",
  );
  const [end, setEnd] = useState(toLocalInput(existing?.endsAt ?? initialStart + 60 * 60_000));
  const [announce, setAnnounce] = useState(existing ? existing.publicMessage != null : true);
  const [publicMessage, setPublicMessage] = useState(existing?.publicMessage ?? DEFAULT_NOTICE);
  const [privateNotes, setPrivateNotes] = useState(existing?.privateNotes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Bring the form into view and put the cursor in its first field.
  const formRef = useRef<HTMLFormElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    formRef.current?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
    titleRef.current?.focus({ preventScroll: true });
  }, []);

  const startMs = start ? new Date(start).getTime() : NaN;
  const endMs =
    duration === "custom" ? (end ? new Date(end).getTime() : NaN) : startMs + duration * 60_000;
  const valid = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return setError("Give the window a title, for example \"Database upgrade\".");
    if (!valid) return setError("Choose a start, and an end after it.");
    if (announce && !publicMessage.trim()) return setError("Write the status page notice, or turn it off.");

    const notice = announce ? publicMessage.trim() : null;
    const notes = privateNotes.trim() || null;
    const payload = {
      title: title.trim(),
      scope: choice === "all" ? "global" : "monitors",
      monitorIds: choice === "all" ? (isEdit ? null : undefined) : choice,
      startsAt: startMs,
      endsAt: endMs,
      // Create omits empty optional text; an edit clears it with null.
      publicMessage: isEdit ? notice : (notice ?? undefined),
      privateNotes: isEdit ? notes : (notes ?? undefined),
    };

    setSaving(true);
    setError(null);
    try {
      await api(isEdit ? `/api/maintenance/${existing.id}` : "/api/maintenance", {
        method: isEdit ? "PUT" : "POST",
        csrf,
        json: payload,
      });
      onSaved();
    } catch (err) {
      setError(errorMessage(err, "Could not save the maintenance window."));
    } finally {
      setSaving(false);
    }
  }

  const pastStart = valid && !isEdit && endMs <= Date.now();

  return (
    <form
      ref={formRef}
      onSubmit={submit}
      aria-label={isEdit ? "Edit maintenance window" : "Plan maintenance"}
      className="animate-enter space-y-4 rounded-card border border-accent/30 bg-surface p-4 shadow-[0_0_0_4px_color-mix(in_oklab,var(--color-accent)_6%,transparent)]"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <CalendarPlus className="size-4 text-accent" />
          {isEdit ? "Edit maintenance window" : "Plan maintenance"}
        </h3>
        <button
          type="button"
          onClick={onCancel}
          className="grid size-7 place-items-center rounded-lg text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
          aria-label="Cancel"
        >
          <X className="size-4" />
        </button>
      </div>

      {existing?.recurrence && (
        <p className="rounded-lg border border-line bg-surface-2/50 px-3 py-2 text-xs text-ink-muted">
          This window repeats ({recurrenceLabel(existing.recurrence)}). The start and end below bound the
          repetition.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2 lg:gap-6">
        <div className="min-w-0 space-y-4">
          <Field label="What's happening" htmlFor="mw-title">
            <input
              id="mw-title"
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Database upgrade"
              maxLength={200}
              className="input"
            />
          </Field>

          <Field label="Monitors">
            <MonitorPicker monitors={monitors} value={choice} onChange={setChoice} label="Monitors in this window" />
          </Field>

          <div className="grid gap-4">
            <Field label="Starts" htmlFor="mw-start">
              <input
                id="mw-start"
                type="datetime-local"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="input scheme-dark sm:max-w-[14rem]"
              />
            </Field>
            <Field label="How long">
              <div role="group" aria-label="Duration" className="flex flex-wrap gap-1.5">
                {[...DURATIONS, "custom" as const].map((d) => (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={duration === d}
                    onClick={() => {
                      if (d === "custom" && Number.isFinite(endMs)) setEnd(toLocalInput(endMs));
                      setDuration(d);
                    }}
                    className={cn(
                      "rounded-lg border px-2.5 py-2 text-xs font-medium transition-colors duration-(--duration-fast)",
                      duration === d
                        ? "border-accent/60 bg-accent-soft text-ink"
                        : "border-line text-ink-muted hover:border-ink-faint/50 hover:text-ink",
                    )}
                  >
                    {d === "custom" ? "Until..." : formatSpan(d)}
                  </button>
                ))}
              </div>
            </Field>
          </div>

          {duration === "custom" && (
            <div className="animate-enter sm:w-[14rem]">
              <Field label="Ends" htmlFor="mw-end">
                <input
                  id="mw-end"
                  type="datetime-local"
                  value={end}
                  min={start || undefined}
                  onChange={(e) => setEnd(e.target.value)}
                  className="input scheme-dark"
                />
              </Field>
            </div>
          )}
        </div>
        <div className="min-w-0 space-y-4">
          <div className="rounded-lg border border-line bg-surface-2/30 p-3">
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={announce}
                onChange={(e) => setAnnounce(e.target.checked)}
                className="size-4 accent-accent"
              />
              Show a notice on the status page
            </label>
            {announce && (
              <div className="mt-2 animate-fade">
                <textarea
                  aria-label="Status page notice"
                  value={publicMessage}
                  onChange={(e) => setPublicMessage(e.target.value)}
                  rows={2}
                  maxLength={2000}
                  className="input resize-y"
                />
                <p className="mt-1 text-xs text-ink-faint">Visitors see it from 14 days before the window starts.</p>
              </div>
            )}
          </div>

          <Field label="Private notes (optional)" hint="Only you see these." htmlFor="mw-notes">
            <textarea
              id="mw-notes"
              value={privateNotes}
              onChange={(e) => setPrivateNotes(e.target.value)}
              placeholder="Runbook link, rollback plan…"
              rows={2}
              maxLength={2000}
              className="input resize-y"
            />
          </Field>
        </div>
      </div>

      {valid && (
        <p className="rounded-lg bg-maint/10 px-3 py-2 text-xs text-ink-muted" aria-live="polite">
          Alerts for <span className="text-ink">{choiceSummary(choice, byId)}</span> pause{" "}
          <span className="text-ink">{formatWindowRange(startMs, endMs)}</span> (
          {formatSpan((endMs - startMs) / 60_000)})
          {announce ? ", and the status page says it's planned." : "."}
          {pastStart && <span className="text-degraded"> That time is already over.</span>}
        </p>
      )}

      {error && (
        <p role="alert" className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-canvas transition-colors duration-(--duration-fast) hover:bg-accent-hover disabled:opacity-60"
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
