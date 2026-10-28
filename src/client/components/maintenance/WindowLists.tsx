import { useId, useState, type ReactNode } from "react";
import { ChevronDown, Globe, Loader2, Megaphone, Pencil, Plus, Repeat, Server, Square, Trash2 } from "lucide-react";
import { cn } from "../../lib/cn";
import {
  formatCountdown,
  formatStartsIn,
  formatWindowRange,
  recurrenceLabel,
  type MaintenanceWindowItem,
  type WindowTiming,
} from "./windows";

export interface WindowEntry {
  win: MaintenanceWindowItem;
  timing: WindowTiming;
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
        "grid size-8 place-items-center rounded-lg text-ink-muted transition-colors duration-(--duration-fast) hover:bg-surface-2 hover:text-ink disabled:opacity-40",
        danger && "hover:bg-down/10 hover:text-down",
      )}
    >
      {children}
    </button>
  );
}

function Scope({ win, text }: { win: MaintenanceWindowItem; text: string }) {
  const global = win.scope !== "monitors";
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {global ? (
        <Globe className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
      ) : (
        <Server className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
      )}
      <span className="truncate">{text}</span>
    </span>
  );
}

function Badges({ win }: { win: MaintenanceWindowItem }) {
  return (
    <>
      {win.publicMessage != null && (
        <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[11px] text-ink-muted">
          <Megaphone className="size-3" aria-hidden /> On status page
        </span>
      )}
      {win.recurrence && (
        <span
          className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[11px] text-ink-muted"
          title={recurrenceLabel(win.recurrence)}
        >
          <Repeat className="size-3" aria-hidden /> Weekly
        </span>
      )}
    </>
  );
}

/**
 * A window in progress: a live countdown, a progress bar, and buttons to add
 * 30 minutes or end it now.
 */
export function ActiveWindowCard({
  entry,
  now,
  scopeText,
  busy,
  onEnd,
  onExtend,
  onEdit,
}: {
  entry: WindowEntry;
  now: number;
  scopeText: string;
  busy: boolean;
  onEnd: () => void;
  /** Omitted for a recurring window (extending would stretch every repeat's range). */
  onExtend?: () => void;
  onEdit: () => void;
}) {
  const { win, timing } = entry;
  const total = Math.max(1, timing.endsAt - timing.startsAt);
  const elapsed = Math.min(1, Math.max(0, (now - timing.startsAt) / total));
  const left = timing.endsAt - now;
  return (
    <article className="animate-enter relative overflow-hidden rounded-card border border-maint/40 bg-maint/[0.07] p-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-maint/40 bg-maint/10 px-2.5 py-0.5 text-[11px] font-medium text-maint">
              <span className="relative flex size-1.5">
                <span className="absolute inset-0 animate-ping rounded-full bg-maint/70 [animation-duration:2s]" />
                <span className="relative size-1.5 rounded-full bg-maint" />
              </span>
              In progress
            </span>
            <Badges win={win} />
          </div>
          <h3 className="mt-2 truncate text-base font-semibold text-ink">{win.title ?? "Maintenance"}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
            <Scope win={win} text={scopeText} />
            <span className="text-ink-faint">{formatWindowRange(timing.startsAt, timing.endsAt)}</span>
          </div>
        </div>
        <div className="shrink-0 sm:text-right">
          <div className="text-[11px] font-medium tracking-wide text-ink-faint uppercase">Ends in</div>
          <div
            className="font-mono text-2xl font-semibold text-ink tabular-nums"
            role="timer"
            aria-label={`Ends in ${formatCountdown(left)}`}
          >
            {formatCountdown(left)}
          </div>
        </div>
      </div>

      <div
        className="mt-4 h-1.5 overflow-hidden rounded-full bg-surface-2"
        role="progressbar"
        aria-label="Time elapsed"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(elapsed * 100)}
      >
        <div
          className="h-full rounded-full bg-maint transition-[width] duration-1000 ease-linear"
          style={{ width: `${elapsed * 100}%` }}
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {onExtend && (
          <button
            type="button"
            onClick={onExtend}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink transition-colors duration-(--duration-fast) hover:bg-surface-2 disabled:opacity-50"
          >
            <Plus className="size-3.5" /> 30 min
          </button>
        )}
        <button
          type="button"
          onClick={onEnd}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink transition-colors duration-(--duration-fast) hover:border-down/40 hover:bg-down/10 hover:text-down disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Square className="size-3 fill-current" />} End now
        </button>
        <button
          type="button"
          onClick={onEdit}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-ink-muted transition-colors duration-(--duration-fast) hover:text-ink disabled:opacity-50"
        >
          <Pencil className="size-3.5" /> Edit
        </button>
        <span className="text-xs text-ink-faint">Alerts resume on their own when it ends.</span>
      </div>
    </article>
  );
}

/** A planned window: when, for whom, and edit/delete. */
export function UpcomingRow({
  entry,
  now,
  scopeText,
  busy,
  onEdit,
  onDelete,
}: {
  entry: WindowEntry;
  now: number;
  scopeText: string;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { win, timing } = entry;
  const date = new Date(timing.startsAt);
  return (
    <li className="animate-enter flex items-center gap-4 px-4 py-3 transition-colors duration-(--duration-fast) hover:bg-surface-2/50">
      <div
        aria-hidden
        className="grid w-12 shrink-0 place-items-center rounded-lg border border-line bg-surface-2/60 py-1.5 text-center"
      >
        <span className="text-[10px] font-semibold tracking-wide text-maint uppercase">
          {date.toLocaleDateString(undefined, { month: "short" })}
        </span>
        <span className="text-lg leading-none font-semibold text-ink tabular-nums">{date.getDate()}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-ink">{win.title ?? "Maintenance"}</span>
          <span className="text-xs text-ink-faint">{formatStartsIn(timing.startsAt - now)}</span>
          <Badges win={win} />
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-muted">
          <span>{formatWindowRange(timing.startsAt, timing.endsAt)}</span>
          <Scope win={win} text={scopeText} />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton title={`Edit ${win.title ?? "window"}`} onClick={onEdit} disabled={busy}>
          <Pencil className="size-4" />
        </IconButton>
        <IconButton title={`Delete ${win.title ?? "window"}`} onClick={onDelete} disabled={busy} danger>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
        </IconButton>
      </div>
    </li>
  );
}

/** Finished windows, collapsed behind a toggle. */
export function PastWindows({
  entries,
  scopeText,
  busyIds,
  onDelete,
}: {
  entries: WindowEntry[];
  scopeText: (w: MaintenanceWindowItem) => string;
  busyIds: Record<string, boolean>;
  onDelete: (w: MaintenanceWindowItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  if (entries.length === 0) return null;
  return (
    <section aria-label="Past maintenance">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex items-center gap-2 rounded-lg px-1 py-1 text-sm font-semibold text-ink transition-colors hover:text-accent-hover"
      >
        <ChevronDown
          className={cn("size-4 text-ink-faint transition-transform duration-(--duration-base) ease-out-quart", !open && "-rotate-90")}
          aria-hidden
        />
        Past
        <span className="text-xs font-normal text-ink-faint">{entries.length}</span>
      </button>
      <div
        id={panelId}
        inert={!open}
        className={cn(
          "grid transition-[grid-template-rows] duration-(--duration-slow) ease-out-quart",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <ul className="mt-2 divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
            {entries.map(({ win, timing }) => (
              <li key={win.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-ink-muted">{win.title ?? "Maintenance"}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-ink-faint">
                    <span>{formatWindowRange(timing.startsAt, timing.endsAt)}</span>
                    <Scope win={win} text={scopeText(win)} />
                  </div>
                </div>
                <IconButton
                  title={`Delete ${win.title ?? "window"}`}
                  onClick={() => onDelete(win)}
                  disabled={!!busyIds[win.id]}
                  danger
                >
                  {busyIds[win.id] ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                </IconButton>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
