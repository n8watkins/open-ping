import { Link } from "react-router-dom";
import { Activity, CalendarClock, Eye, MoreHorizontal, Pause, Pencil, Play, Trash2 } from "lucide-react";
import { cn } from "../../lib/cn";
import { monitorTypeLabel, type MonitorSummary } from "../../lib/types";
import { formatMs, formatPct, formatRelativeTime } from "../../lib/format";
import { StatusPill } from "../ui/StatusPill";
import { UptimeBar } from "../ui/UptimeBar";
import { STATE_META, type MonitorState } from "../../../shared/states";
import type { Schedule } from "../../../shared/schemas";
import { scheduleLabel, scheduleTitle } from "./schedule-label";

export type MonitorAction = "pause" | "resume" | "delete";

/** The Monitors list figures (GET /api/monitors?include=stats). */
export interface MonitorListStats {
  uptime7d: number;
  checks7d: number;
  typicalResponseMs: number | null;
  lastIncidentAt: number | null;
  incidentOpen: boolean;
}

/**
 * Column template shared by the header and every row (md and up). Columns
 * drop out as the width shrinks: schedule and typical response below xl,
 * last incident below lg.
 */
export const MONITOR_GRID =
  "md:grid md:items-center md:gap-4 md:grid-cols-[auto_minmax(0,1fr)_8.5rem_6.5rem_2.25rem] lg:grid-cols-[auto_minmax(0,1fr)_8.5rem_6.5rem_6.5rem_2.25rem] xl:grid-cols-[auto_minmax(0,1fr)_8.5rem_6.5rem_5.5rem_6.5rem_7rem_2.25rem]";

const STATE_ICON_CLASS: Record<MonitorState, string> = {
  up: "bg-up/10 text-up",
  down: "bg-down/10 text-down",
  suspended: "bg-suspended/10 text-suspended",
  degraded: "bg-degraded/10 text-degraded",
  warming_up: "bg-warming/10 text-warming",
  maintenance: "bg-maint/10 text-maint",
  scheduled_off: "bg-scheduled/10 text-scheduled",
  paused: "bg-surface-2 text-paused",
  unknown: "bg-surface-2 text-paused",
};

function recentCheckSegments(checks: { at: number; state: MonitorState }[]) {
  const count = 28;
  const recent = [...checks]
    .sort((a, b) => a.at - b.at)
    .slice(-count)
    .map((check) => ({
      state: check.state,
      title: `${STATE_META[check.state].label} at ${new Date(check.at).toLocaleString()}`,
    }));
  const missing = Array.from({ length: count - recent.length }, () => ({
    state: "unknown" as const,
    title: "No check data",
  }));
  return [...missing, ...recent];
}

/** Uptime colour: green from 99.9%, amber from 99%, red below. */
function uptimeTone(pct: number): string {
  if (pct >= 99.9) return "text-up";
  if (pct >= 99) return "text-degraded";
  return "text-down";
}

function UptimeCell({ stats, monitor }: { stats: MonitorListStats | undefined; monitor: MonitorSummary }) {
  return (
    <div className="min-w-0">
      {stats && stats.checks7d > 0 ? (
        <div className={cn("text-sm font-medium tabular-nums", uptimeTone(stats.uptime7d))}>
          {formatPct(stats.uptime7d)}
        </div>
      ) : (
        <div className="text-sm text-ink-faint" title="No checks in the last 7 days">
          No data
        </div>
      )}
      {/* The last 28 checks, as a slim strip under the figure. */}
      <div className="mt-1 [&_[role=img]]:h-1.5" title="Last 28 checks">
        <UptimeBar segments={recentCheckSegments(monitor.recentChecks)} />
      </div>
    </div>
  );
}

function LastIncidentCell({ monitor, stats }: { monitor: MonitorSummary; stats: MonitorListStats | undefined }) {
  if (!stats) return <span className="text-xs text-ink-faint">-</span>;
  if (stats.incidentOpen) {
    return (
      <Link
        to={`/incidents?monitorId=${encodeURIComponent(monitor.id)}`}
        className="text-xs font-medium text-down hover:underline"
      >
        Open now
      </Link>
    );
  }
  if (stats.lastIncidentAt == null) return <span className="text-xs text-ink-faint">None</span>;
  return (
    <Link
      to={`/incidents?monitorId=${encodeURIComponent(monitor.id)}`}
      title={new Date(stats.lastIncidentAt).toLocaleString()}
      className="text-xs text-ink-muted transition-colors hover:text-ink hover:underline"
    >
      {formatRelativeTime(stats.lastIncidentAt)}
    </Link>
  );
}

function ResponseCell({ stats }: { stats: MonitorListStats | undefined }) {
  return (
    <span
      className="text-xs text-ink-muted tabular-nums"
      title="Median of the hourly average response times over the last 7 days"
    >
      {stats?.typicalResponseMs != null ? formatMs(stats.typicalResponseMs) : "-"}
    </span>
  );
}

function ScheduleCell({ schedule }: { schedule: Schedule | undefined }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-ink-muted" title={scheduleTitle(schedule)}>
      <CalendarClock className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
      <span className="truncate">{scheduleLabel(schedule)}</span>
    </span>
  );
}

function StateIcon({ state }: { state: MonitorState }) {
  return (
    <span
      aria-hidden
      className={cn("grid size-7 shrink-0 place-items-center rounded-full", STATE_ICON_CLASS[state])}
    >
      {state === "paused" ? <Pause className="size-3.5 fill-current" /> : <Activity className="size-3.5" />}
    </span>
  );
}

function ActionsMenu({
  monitor,
  busy,
  onAction,
}: {
  monitor: MonitorSummary;
  busy: boolean;
  onAction: (action: MonitorAction) => void;
}) {
  return (
    <details className="group relative justify-self-end open:z-20">
      <summary
        aria-label={`Actions for ${monitor.name}`}
        className="cursor-pointer list-none rounded-md p-2 text-ink-faint transition-colors duration-(--duration-fast) hover:bg-surface-2 hover:text-ink [&::-webkit-details-marker]:hidden"
      >
        <MoreHorizontal className="size-4" />
      </summary>
      <div className="absolute top-[calc(100%+0.25rem)] right-0 z-30 min-w-36 animate-fade overflow-hidden rounded-lg border border-line bg-surface py-1 text-xs shadow-xl">
        <Link
          to={`/monitors/${monitor.id}`}
          className="flex items-center gap-2 px-3 py-2 text-ink-muted hover:bg-surface-2 hover:text-ink"
        >
          <Eye className="size-3.5" /> View
        </Link>
        <Link
          to={`/monitors/${monitor.id}/edit`}
          className="flex items-center gap-2 px-3 py-2 text-ink-muted hover:bg-surface-2 hover:text-ink"
        >
          <Pencil className="size-3.5" /> Edit
        </Link>
        <button
          type="button"
          disabled={busy}
          onClick={(event) => {
            event.currentTarget.closest("details")?.removeAttribute("open");
            onAction(monitor.paused ? "resume" : "pause");
          }}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-ink-muted hover:bg-surface-2 hover:text-ink disabled:opacity-50"
        >
          {monitor.paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
          {monitor.paused ? "Resume" : "Pause"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={(event) => {
            event.currentTarget.closest("details")?.removeAttribute("open");
            onAction("delete");
          }}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-down hover:bg-down/10 disabled:opacity-50"
        >
          <Trash2 className="size-3.5" /> Delete
        </button>
      </div>
    </details>
  );
}

/** Column headings for the table layout (md and up). */
export function MonitorListHeader({ allSelected, onToggleAll }: { allSelected: boolean; onToggleAll: () => void }) {
  return (
    <div
      className={cn(
        "hidden border-b border-line bg-canvas/35 px-4 py-2 text-[11px] font-medium tracking-wide text-ink-faint uppercase",
        MONITOR_GRID,
      )}
    >
      <input
        type="checkbox"
        checked={allSelected}
        onChange={onToggleAll}
        aria-label="Select all visible monitors"
        className="size-3.5 accent-accent"
      />
      <span>Monitor</span>
      <span>Status</span>
      <span>7-day uptime</span>
      <span className="hidden xl:block" title="Typical (median) response time over the last 7 days">Response</span>
      <span className="hidden lg:block">Last incident</span>
      <span className="hidden xl:block">Schedule</span>
      <span className="sr-only">Actions</span>
    </div>
  );
}

/**
 * One monitor: a table row from md up, a card on phones. Both carry the same
 * figures (state, 7-day uptime, typical response, last incident, schedule).
 */
export function MonitorRow({
  monitor,
  stats,
  schedule,
  selected,
  busy,
  onSelect,
  onAction,
}: {
  monitor: MonitorSummary;
  stats: MonitorListStats | undefined;
  schedule: Schedule | undefined;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onAction: (action: MonitorAction) => void;
}) {
  const nameBlock = (
    <Link to={`/monitors/${monitor.id}`} className="group/name flex min-w-0 items-center gap-3">
      <StateIcon state={monitor.state} />
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-ink transition-colors group-hover/name:text-accent-hover">
            {monitor.name}
          </span>
          {monitor.categoryName && (
            <span className="hidden shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] text-ink-faint sm:inline">
              {monitor.categoryName}
            </span>
          )}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-ink-faint">
          <span className="shrink-0 rounded border border-line px-1 uppercase">{monitorTypeLabel(monitor.type)}</span>
          <span className="truncate">{monitor.target ?? STATE_META[monitor.state].label}</span>
        </span>
      </span>
    </Link>
  );

  const checkbox = (
    <input
      type="checkbox"
      checked={selected}
      onChange={onSelect}
      aria-label={`Select ${monitor.name}`}
      className="size-3.5 shrink-0 accent-accent"
    />
  );

  return (
    <div
      className={cn(
        "animate-enter px-4 py-3 transition-colors duration-(--duration-fast) hover:bg-surface-2/55",
        selected && "bg-accent-soft/40 hover:bg-accent-soft/60",
      )}
    >
      {/* Table row, md and up. */}
      <div className={cn("hidden", MONITOR_GRID)}>
        {checkbox}
        {nameBlock}
        <span className="min-w-0">
          <StatusPill state={monitor.state} />
          {monitor.lastCheckedAt != null && (
            <span
              className="mt-1 block truncate text-[11px] text-ink-faint"
              title={new Date(monitor.lastCheckedAt).toLocaleString()}
            >
              Checked {formatRelativeTime(monitor.lastCheckedAt)}
            </span>
          )}
        </span>
        <UptimeCell stats={stats} monitor={monitor} />
        <span className="hidden xl:block">
          <ResponseCell stats={stats} />
        </span>
        <span className="hidden lg:block">
          <LastIncidentCell monitor={monitor} stats={stats} />
        </span>
        <span className="hidden min-w-0 xl:block">
          <ScheduleCell schedule={schedule} />
        </span>
        <ActionsMenu monitor={monitor} busy={busy} onAction={onAction} />
      </div>

      {/* Card, phones. */}
      <div className="md:hidden">
        <div className="flex items-center gap-3">
          {checkbox}
          <div className="min-w-0 flex-1">{nameBlock}</div>
          <ActionsMenu monitor={monitor} busy={busy} onAction={onAction} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 pl-[1.625rem]">
          <StatusPill state={monitor.state} />
          <ScheduleCell schedule={schedule} />
        </div>
        <dl className="mt-3 grid grid-cols-3 gap-3 pl-[1.625rem]">
          <div className="min-w-0">
            <dt className="text-[10px] font-medium tracking-wide text-ink-faint uppercase">7-day</dt>
            <dd className="mt-0.5">
              {stats && stats.checks7d > 0 ? (
                <span className={cn("text-sm font-medium tabular-nums", uptimeTone(stats.uptime7d))}>
                  {formatPct(stats.uptime7d)}
                </span>
              ) : (
                <span className="text-sm text-ink-faint">No data</span>
              )}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-[10px] font-medium tracking-wide text-ink-faint uppercase">Response</dt>
            <dd className="mt-0.5">
              <ResponseCell stats={stats} />
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-[10px] font-medium tracking-wide text-ink-faint uppercase">Last incident</dt>
            <dd className="mt-0.5">
              <LastIncidentCell monitor={monitor} stats={stats} />
            </dd>
          </div>
        </dl>
        <div className="mt-3 pl-[1.625rem] [&_[role=img]]:h-1.5" title="Last 28 checks">
          <UptimeBar segments={recentCheckSegments(monitor.recentChecks)} />
        </div>
      </div>
    </div>
  );
}

/** Placeholder rows while the list loads. */
export function MonitorListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-hidden className="divide-y divide-line">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3.5">
          <div className="skeleton size-3.5 shrink-0 rounded-sm!" />
          <div className="skeleton size-7 shrink-0 rounded-full!" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="skeleton h-3.5 w-32" />
            <div className="skeleton h-3 w-56 max-w-full" />
          </div>
          <div className="skeleton hidden h-6 w-24 rounded-full! md:block" />
          <div className="skeleton hidden h-6 w-20 md:block" />
          <div className="skeleton hidden h-4 w-16 xl:block" />
          <div className="skeleton hidden h-4 w-16 lg:block" />
        </div>
      ))}
    </div>
  );
}
