import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  ArrowDownUp,
  ChevronDown,
  Filter,
  Layers3,
  Pause,
  Play,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { useFetch } from "../lib/useFetch";
import type { OverviewResponse } from "../lib/types";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { PageTitle } from "../components/ui/PageTitle";
import { api } from "../lib/api";
import { useBootstrap } from "../lib/bootstrap";
import type { Schedule } from "../../shared/schemas";
import type { MonitorState } from "../../shared/states";
import {
  filterAndSortMonitors,
  groupMonitors,
  type MonitorSortMode,
} from "./monitors-list";
import {
  MonitorListHeader,
  MonitorListSkeleton,
  MonitorRow,
  type MonitorAction,
  type MonitorListStats,
} from "../components/monitors/MonitorRow";

/** GET /api/monitors?include=stats: the records (for schedules) and list figures. */
interface MonitorStatsResponse {
  monitors: { id: string; schedule: Schedule }[];
  stats?: Record<string, MonitorListStats>;
}

const NEW_MONITOR_OPTIONS = [
  { type: "http", label: "HTTP / API" },
  { type: "heartbeat", label: "Heartbeat / cron" },
  { type: "dns", label: "DNS record" },
  { type: "tcp", label: "TCP port" },
  { type: "domain", label: "Domain expiry" },
] as const;

export default function Monitors() {
  const { data, loading, error, reload } =
    useFetch<OverviewResponse>("/api/overview");
  // The list figures load alongside; rows show placeholders until they land.
  const { data: statsData, reload: reloadStats } =
    useFetch<MonitorStatsResponse>("/api/monitors?include=stats");
  const { csrf } = useBootstrap();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | MonitorState>("all");
  const [sort, setSort] = useState<MonitorSortMode>("status");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [showGroups, setShowGroups] = useState(false);
  const [pendingAction, setPendingAction] = useState<MonitorAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const monitors = useMemo(() => data?.monitors ?? [], [data?.monitors]);
  const stats = useMemo(() => statsData?.stats ?? {}, [statsData?.stats]);
  const schedules = useMemo(
    () => new Map((statsData?.monitors ?? []).map((m) => [m.id, m.schedule])),
    [statsData?.monitors],
  );

  const visibleMonitors = useMemo(() => {
    return filterAndSortMonitors(monitors, query, status, sort, stats);
  }, [monitors, query, sort, status, stats]);

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
    await Promise.all([reload(), reloadStats()]);
    setPendingAction(null);
  }

  const renderRow = (monitor: (typeof monitors)[number]) => (
    <MonitorRow
      key={monitor.id}
      monitor={monitor}
      stats={stats[monitor.id]}
      schedule={schedules.get(monitor.id)}
      selected={selected.has(monitor.id)}
      busy={pendingAction !== null}
      onSelect={() => toggleSelected(monitor.id)}
      onAction={(action) => void runAction(action, [monitor.id])}
    />
  );

  if (error && !data) {
    return (
      <div className="mx-auto max-w-6xl">
        <PageTitle>Monitors</PageTitle>
        <p className="mt-6 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
          Could not load monitors: {error}
        </p>
      </div>
    );
  }

  const initialLoading = loading && !data;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageTitle>Monitors</PageTitle>
        <NewMonitorControl />
      </div>

      {!initialLoading && monitors.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={<Activity className="size-6 text-accent" />}
            title="No monitors yet"
            description="Create your first monitor to begin tracking uptime."
          />
        </div>
      ) : (
        <section aria-label="Monitor list" className="mt-5 min-w-0">
          <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex items-center gap-2 rounded-lg bg-surface px-3 py-2 text-xs text-ink-muted md:hidden">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleAll}
                  aria-label="Select all visible monitors"
                  className="size-3.5 accent-accent"
                />
                {selectedIds.length} / {monitors.length}
              </label>
              <span className="hidden rounded-lg bg-surface px-3 py-2 text-xs text-ink-muted tabular-nums md:inline">
                {selectedIds.length > 0
                  ? `${selectedIds.length} of ${monitors.length} selected`
                  : `${monitors.length} monitor${monitors.length === 1 ? "" : "s"}`}
              </span>
              <button
                type="button"
                aria-pressed={showGroups}
                onClick={() => setShowGroups((current) => !current)}
                className="inline-flex items-center gap-2 rounded-lg bg-surface px-3 py-2 text-xs text-ink-muted transition-colors duration-(--duration-fast) hover:bg-surface-2 hover:text-ink aria-pressed:bg-surface-2 aria-pressed:text-ink"
              >
                <Layers3 className="size-3.5" />
                {showGroups ? "Hide groups" : "Show groups"}
              </button>
              {selectedIds.length > 0 && (
                <div
                  className="inline-flex animate-fade items-center overflow-hidden rounded-lg border border-line bg-surface"
                  role="group"
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
              <label className="relative min-w-[210px] flex-1 lg:max-w-[280px]">
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
                  <option value="suspended">Suspended</option>
                  <option value="degraded">Degraded</option>
                  <option value="scheduled_off">Scheduled off</option>
                  <option value="maintenance">Maintenance</option>
                  <option value="paused">Paused</option>
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
                  <option value="uptime">Lowest 7-day uptime</option>
                  <option value="response">Slowest response</option>
                  <option value="recent">Recently checked</option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 size-3.5 text-ink-faint" />
              </label>
            </div>
          </div>

          {(actionError || actionMessage) && (
            <div
              role={actionError ? "alert" : "status"}
              className={`mb-3 animate-enter rounded-lg border px-3 py-2 text-xs ${
                actionError
                  ? "border-down/40 bg-down/10 text-down"
                  : "border-up/30 bg-up/10 text-up"
              }`}
            >
              {actionError ?? actionMessage}
            </div>
          )}

          <Card className="p-0">
            <MonitorListHeader allSelected={allVisibleSelected} onToggleAll={toggleAll} />
            {initialLoading ? (
              <>
                <MonitorListSkeleton />
                <span className="sr-only" role="status">Loading monitors</span>
              </>
            ) : visibleMonitors.length === 0 ? (
              <p className="px-5 py-10 text-center text-sm text-ink-muted">
                No monitors match those filters.
              </p>
            ) : showGroups ? (
              <div className="divide-y divide-line">
                {groupedMonitors.map((group) => (
                  <div key={group.key} className="divide-y divide-line">
                    <div className="flex items-center justify-between bg-canvas/35 px-4 py-2 text-[11px] font-medium tracking-wide text-ink-faint uppercase">
                      <span>{group.label}</span>
                      <span>{group.monitors.length}</span>
                    </div>
                    <div className="stagger divide-y divide-line">{group.monitors.map(renderRow)}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="stagger divide-y divide-line">{visibleMonitors.map(renderRow)}</div>
            )}
          </Card>
        </section>
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
