import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  ArrowDownUp,
  ChevronDown,
  Clock3,
  Eye,
  Filter,
  Layers3,
  Loader2,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { useFetch } from "../lib/useFetch";
import {
  monitorTypeLabel,
  type MonitorSummary,
  type OverviewResponse,
} from "../lib/types";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { UptimeBar } from "../components/ui/UptimeBar";
import { formatDuration, formatPct, formatRelativeTime } from "../lib/format";
import { STATE_META, type MonitorState } from "../../shared/states";
import { api } from "../lib/api";
import { useBootstrap } from "../lib/bootstrap";
import {
  filterAndSortMonitors,
  groupMonitors,
  type MonitorSortMode,
} from "./monitors-list";

type MonitorAction = "pause" | "resume" | "delete";

const NEW_MONITOR_OPTIONS = [
  { type: "http", label: "HTTP / API" },
  { type: "heartbeat", label: "Heartbeat / cron" },
  { type: "dns", label: "DNS record" },
  { type: "tcp", label: "TCP port" },
  { type: "domain", label: "Domain expiry" },
] as const;

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

function intervalLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} sec`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} hr`;
}

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

export default function Monitors() {
  const { data, loading, error, reload } =
    useFetch<OverviewResponse>("/api/overview");
  const { csrf } = useBootstrap();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | MonitorState>("all");
  const [sort, setSort] = useState<MonitorSortMode>("status");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [showGroups, setShowGroups] = useState(false);
  const [pendingAction, setPendingAction] = useState<MonitorAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const monitors = data?.monitors ?? [];
  const counts = data?.counts;

  const visibleMonitors = useMemo(() => {
    return filterAndSortMonitors(monitors, query, status, sort);
  }, [monitors, query, sort, status]);

  const groupedMonitors = useMemo(
    () => groupMonitors(visibleMonitors),
    [visibleMonitors],
  );

  const selectedIds = useMemo(() => {
    const existing = new Set(monitors.map((monitor) => monitor.id));
    return [...selected].filter((id) => existing.has(id));
  }, [monitors, selected]);

  const allVisibleSelected =
    visibleMonitors.length > 0 &&
    visibleMonitors.every((monitor) => selected.has(monitor.id));

  function toggleAll() {
    setSelected((current) => {
      const next = new Set(current);
      if (allVisibleSelected)
        visibleMonitors.forEach((monitor) => next.delete(monitor.id));
      else visibleMonitors.forEach((monitor) => next.add(monitor.id));
      return next;
    });
  }

  function toggleSelected(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function runAction(action: MonitorAction, ids: string[]) {
    if (ids.length === 0 || pendingAction) return;
    if (
      action === "delete" &&
      !window.confirm(
        `Delete ${ids.length} monitor${ids.length === 1 ? "" : "s"}? This also removes their history and incidents.`,
      )
    ) {
      return;
    }

    setPendingAction(action);
    setActionError(null);
    setActionMessage(null);
    const results = await Promise.allSettled(
      ids.map((id) =>
        api(`/api/monitors/${id}${action === "delete" ? "" : `/${action}`}`, {
          method: action === "delete" ? "DELETE" : "POST",
          csrf: csrf ?? undefined,
        }),
      ),
    );
    const failedIds = ids.filter(
      (_, index) => results[index]?.status === "rejected",
    );
    const completed = ids.length - failedIds.length;
    setSelected(new Set(failedIds));
    if (completed > 0) {
      const verb =
        action === "delete"
          ? "Deleted"
          : action === "pause"
            ? "Paused"
            : "Resumed";
      setActionMessage(
        `${verb} ${completed} monitor${completed === 1 ? "" : "s"}.`,
      );
    }
    if (failedIds.length > 0) {
      setActionError(
        `${failedIds.length} monitor action${failedIds.length === 1 ? "" : "s"} failed. The failed selection was kept so you can retry.`,
      );
    }
    await reload();
    setPendingAction(null);
  }

  if (loading && !data) {
    return (
      <div className="grid min-h-[40vh] place-items-center">
        <Loader2 className="size-6 animate-spin text-ink-faint" />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="mx-auto max-w-[1320px]">
        <h1 className="text-2xl font-semibold tracking-tight">
          Monitors<span className="text-up">.</span>
        </h1>
        <p className="mt-6 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
          Could not load monitors: {error}
        </p>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="mx-auto max-w-[1320px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          Monitors<span className="text-up">.</span>
        </h1>
        <NewMonitorControl />
      </div>

      {monitors.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={<Activity className="size-6 text-accent" />}
            title="No monitors yet"
            description="Create your first monitor to begin tracking uptime."
          />
        </div>
      ) : (
        <div className="mt-5 grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_240px]">
          <section aria-label="Monitor list" className="min-w-0">
            <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex items-center gap-2 rounded-lg bg-surface px-3 py-2 text-xs text-ink-muted">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAll}
                    aria-label="Select all visible monitors"
                    className="size-3.5 accent-accent"
                  />
                  {selectedIds.length} / {monitors.length}
                </label>
                <button
                  type="button"
                  aria-pressed={showGroups}
                  onClick={() => setShowGroups((current) => !current)}
                  className="inline-flex items-center gap-2 rounded-lg bg-surface px-3 py-2 text-xs text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink aria-pressed:bg-surface-2 aria-pressed:text-ink"
                >
                  <Layers3 className="size-3.5" />
                  {showGroups ? "Hide groups" : "Show groups"}
                </button>
                {selectedIds.length > 0 && (
                  <div
                    className="inline-flex items-center overflow-hidden rounded-lg border border-line bg-surface"
                    aria-label="Bulk monitor actions"
                  >
                    <BulkActionButton
                      label="Pause"
                      icon={<Pause className="size-3.5" />}
                      disabled={pendingAction !== null}
                      onClick={() => void runAction("pause", selectedIds)}
                    />
                    <BulkActionButton
                      label="Resume"
                      icon={<Play className="size-3.5" />}
                      disabled={pendingAction !== null}
                      onClick={() => void runAction("resume", selectedIds)}
                    />
                    <BulkActionButton
                      label="Delete"
                      icon={<Trash2 className="size-3.5" />}
                      disabled={pendingAction !== null}
                      destructive
                      onClick={() => void runAction("delete", selectedIds)}
                    />
                  </div>
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-wrap justify-end gap-2">
                <label className="relative min-w-[210px] flex-1 lg:max-w-[260px]">
                  <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-faint" />
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search by name or URL"
                    aria-label="Search monitors"
                    className="w-full rounded-lg border border-line bg-canvas py-2 pr-3 pl-9 text-xs text-ink placeholder:text-ink-faint focus:border-transparent focus:outline-2 focus:outline-accent"
                  />
                </label>
                <label className="relative inline-flex items-center">
                  <Filter className="pointer-events-none absolute left-3 size-3.5 text-ink-faint" />
                  <select
                    value={status}
                    onChange={(event) =>
                      setStatus(event.target.value as "all" | MonitorState)
                    }
                    aria-label="Filter monitors by status"
                    className="appearance-none rounded-lg border border-line bg-surface py-2 pr-8 pl-8 text-xs text-ink"
                  >
                    <option value="all">All statuses</option>
                    <option value="up">Up</option>
                    <option value="down">Down</option>
                    <option value="degraded">Degraded</option>
                    <option value="paused">Paused</option>
                    <option value="maintenance">Maintenance</option>
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2.5 size-3.5 text-ink-faint" />
                </label>
                <label className="relative inline-flex items-center">
                  <ArrowDownUp className="pointer-events-none absolute left-3 size-3.5 text-ink-faint" />
                  <select
                    value={sort}
                    onChange={(event) =>
                      setSort(event.target.value as MonitorSortMode)
                    }
                    aria-label="Sort monitors"
                    className="appearance-none rounded-lg border border-line bg-surface py-2 pr-8 pl-8 text-xs text-ink"
                  >
                    <option value="status">Down first</option>
                    <option value="name">Name</option>
                    <option value="recent">Recently checked</option>
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2.5 size-3.5 text-ink-faint" />
                </label>
              </div>
            </div>

            {(actionError || actionMessage) && (
              <div
                role={actionError ? "alert" : "status"}
                className={`mb-3 rounded-lg border px-3 py-2 text-xs ${
                  actionError
                    ? "border-down/40 bg-down/10 text-down"
                    : "border-up/30 bg-up/10 text-up"
                }`}
              >
                {actionError ?? actionMessage}
              </div>
            )}

            <Card className="divide-y divide-line p-0">
              {visibleMonitors.length === 0 ? (
                <p className="px-5 py-10 text-center text-sm text-ink-muted">
                  No monitors match those filters.
                </p>
              ) : showGroups ? (
                groupedMonitors.map((group) => (
                  <div key={group.key} className="divide-y divide-line">
                    <div className="flex items-center justify-between bg-canvas/35 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
                      <span>{group.label}</span>
                      <span>{group.monitors.length}</span>
                    </div>
                    {group.monitors.map((monitor) => (
                      <MonitorRow
                        key={monitor.id}
                        monitor={monitor}
                        selected={selected.has(monitor.id)}
                        busy={pendingAction !== null}
                        onSelect={() => toggleSelected(monitor.id)}
                        onAction={(action) => void runAction(action, [monitor.id])}
                      />
                    ))}
                  </div>
                ))
              ) : (
                visibleMonitors.map((monitor) => (
                  <MonitorRow
                    key={monitor.id}
                    monitor={monitor}
                    selected={selected.has(monitor.id)}
                    busy={pendingAction !== null}
                    onSelect={() => toggleSelected(monitor.id)}
                    onAction={(action) => void runAction(action, [monitor.id])}
                  />
                ))
              )}
            </Card>
          </section>

          <aside
            aria-label="Monitoring summary"
            className="hidden space-y-4 xl:block"
          >
            <Card className="p-5">
              <h2 className="text-sm font-semibold">
                Current status<span className="text-up">.</span>
              </h2>
              <div className="my-5 flex justify-center">
                <span className="grid size-10 place-items-center rounded-full bg-surface-2 text-ink-muted">
                  {(counts?.paused ?? 0) === monitors.length &&
                  monitors.length > 0 ? (
                    <Pause className="size-4 fill-current" />
                  ) : (
                    <Activity className="size-4" />
                  )}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <SummaryMetric label="Down" value={counts?.down ?? 0} />
                <SummaryMetric label="Up" value={counts?.up ?? 0} />
                <SummaryMetric label="Paused" value={counts?.paused ?? 0} />
              </div>
              <p className="mt-5 text-center text-xs text-ink-muted">
                Monitoring {monitors.length} service
                {monitors.length === 1 ? "" : "s"}.
              </p>
            </Card>

            <Card className="p-5">
              <h2 className="text-sm font-semibold">
                Last 24 hours<span className="text-up">.</span>
              </h2>
              <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-5">
                <SummaryMetric
                  label="Overall uptime"
                  value={formatPct(data.analytics.overallUptime24h)}
                  accent
                />
                <SummaryMetric
                  label="MTBF"
                  value={
                    data.analytics.mtbfSeconds24h == null
                      ? "N/A"
                      : formatDuration(data.analytics.mtbfSeconds24h)
                  }
                />
                <SummaryMetric
                  label="Without incident"
                  value={
                    data.analytics.withoutIncidentSeconds == null
                      ? "N/A"
                      : formatDuration(data.analytics.withoutIncidentSeconds)
                  }
                />
                <SummaryMetric
                  label="Incidents"
                  value={data.analytics.incidents24h}
                />
              </div>
            </Card>
          </aside>
        </div>
      )}
    </div>
  );
}

function NewMonitorControl() {
  return (
    <div className="inline-flex shrink-0 overflow-visible rounded-lg bg-accent text-sm font-medium text-canvas shadow-sm">
      <Link
        to="/monitors/new?type=http"
        className="inline-flex items-center gap-2 rounded-l-lg px-4 py-2.5 transition-colors hover:bg-accent-hover"
      >
        <Plus className="size-4" />
        New
      </Link>
      <details className="group relative border-l border-canvas/20 open:z-30">
        <summary
          aria-label="Choose monitor type"
          className="grid h-full cursor-pointer list-none place-items-center rounded-r-lg px-3 transition-colors hover:bg-accent-hover [&::-webkit-details-marker]:hidden"
        >
          <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
        </summary>
        <div className="absolute top-[calc(100%+0.4rem)] right-0 z-30 min-w-48 overflow-hidden rounded-lg border border-line bg-surface py-1 text-ink shadow-xl">
          {NEW_MONITOR_OPTIONS.map((option) => (
            <Link
              key={option.type}
              to={`/monitors/new?type=${option.type}`}
              className="block px-3 py-2 text-xs transition-colors hover:bg-surface-2"
            >
              {option.label}
            </Link>
          ))}
        </div>
      </details>
    </div>
  );
}

function BulkActionButton({
  label,
  icon,
  disabled,
  destructive = false,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  disabled: boolean;
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 border-r border-line px-2.5 py-2 text-xs transition-colors last:border-r-0 disabled:cursor-wait disabled:opacity-50 ${
        destructive
          ? "text-down hover:bg-down/10"
          : "text-ink-muted hover:bg-surface-2 hover:text-ink"
      }`}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

function MonitorRow({
  monitor,
  selected,
  busy,
  onSelect,
  onAction,
}: {
  monitor: MonitorSummary;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onAction: (action: MonitorAction) => void;
}) {
  return (
    <div className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2/55 sm:grid-cols-[auto_auto_minmax(0,1fr)_80px_auto] md:grid-cols-[auto_auto_minmax(190px,1fr)_90px_minmax(130px,180px)_42px]">
      <input
        type="checkbox"
        checked={selected}
        onChange={onSelect}
        aria-label={`Select ${monitor.name}`}
        className="size-3.5 accent-accent"
      />
      <span
        title={STATE_META[monitor.state].label}
        className={`grid size-7 place-items-center rounded-full ${STATE_ICON_CLASS[monitor.state]}`}
      >
        {monitor.state === "paused" ? (
          <Pause className="size-3.5 fill-current" />
        ) : (
          <Activity className="size-3.5" />
        )}
      </span>
      <Link to={`/monitors/${monitor.id}`} className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-ink hover:text-accent-hover">
            {monitor.name}
          </span>
          {monitor.categoryName && (
            <span className="hidden shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] text-ink-faint sm:inline">
              {monitor.categoryName}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-ink-faint">
          <span className="shrink-0 rounded border border-line px-1 uppercase">
            {monitorTypeLabel(monitor.type)}
          </span>
          <span className="truncate">
            {monitor.target ?? STATE_META[monitor.state].label}
          </span>
          {monitor.lastCheckedAt && (
            <span className="hidden shrink-0 sm:inline">
              · {formatRelativeTime(monitor.lastCheckedAt)}
            </span>
          )}
        </div>
      </Link>
      <span className="hidden items-center justify-end gap-1 text-xs text-ink-faint sm:flex">
        <Clock3 className="size-3" />
        {intervalLabel(monitor.intervalSeconds)}
      </span>
      <div className="hidden md:block">
        <UptimeBar segments={recentCheckSegments(monitor.recentChecks)} />
        <div className="mt-0.5 text-right text-[10px] text-ink-muted">
          {formatPct(monitor.uptime24h)}
        </div>
      </div>
      <details className="group relative justify-self-end open:z-20">
        <summary
          aria-label={`Actions for ${monitor.name}`}
          className="cursor-pointer list-none rounded-md p-2 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink [&::-webkit-details-marker]:hidden"
        >
          <MoreHorizontal className="size-4" />
        </summary>
        <div className="absolute top-[calc(100%+0.25rem)] right-0 z-30 min-w-36 overflow-hidden rounded-lg border border-line bg-surface py-1 text-xs shadow-xl">
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
            {monitor.paused ? (
              <Play className="size-3.5" />
            ) : (
              <Pause className="size-3.5" />
            )}
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
    </div>
  );
}

function SummaryMetric({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string | number;
  accent?: boolean;
}) {
  return (
    <div>
      <div
        className={
          accent
            ? "text-base font-semibold text-up"
            : "text-base font-semibold text-ink"
        }
      >
        {value}
      </div>
      <div className="mt-0.5 text-[11px] leading-tight text-ink-muted">
        {label}
      </div>
    </div>
  );
}
