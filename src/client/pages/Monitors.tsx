import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  ArrowDownUp,
  ChevronDown,
  Clock3,
  Filter,
  Loader2,
  MoreHorizontal,
  Pause,
  Plus,
  Search,
} from "lucide-react";
import { useFetch } from "../lib/useFetch";
import { monitorTypeLabel, type OverviewResponse } from "../lib/types";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { UptimeBar } from "../components/ui/UptimeBar";
import { formatPct, formatRelativeTime } from "../lib/format";
import { STATE_META, type MonitorState } from "../../shared/states";

type SortMode = "status" | "name" | "recent";

const STATUS_PRIORITY: Record<MonitorState, number> = {
  down: 0,
  suspended: 1,
  degraded: 2,
  warming_up: 3,
  unknown: 4,
  maintenance: 5,
  scheduled_off: 6,
  paused: 7,
  up: 8,
};

function intervalLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} sec`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} hr`;
}

function uptimeSegments(uptime: number, state: MonitorState) {
  const count = 28;
  if (state === "unknown" && uptime === 100) {
    return Array.from({ length: count }, () => ({ state: "unknown" as const }));
  }
  const failed = Math.round(count * Math.max(0, 100 - uptime) / 100);
  return Array.from({ length: count }, (_, index) => ({
    state: index >= count - failed ? ("down" as const) : ("up" as const),
  }));
}

export default function Monitors() {
  const { data, loading, error } = useFetch<OverviewResponse>("/api/overview");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | MonitorState>("all");
  const [sort, setSort] = useState<SortMode>("status");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const monitors = data?.monitors ?? [];
  const counts = data?.counts;

  const visibleMonitors = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return monitors
      .filter((monitor) => {
        const matchesQuery =
          !normalizedQuery ||
          monitor.name.toLowerCase().includes(normalizedQuery) ||
          monitorTypeLabel(monitor.type).toLowerCase().includes(normalizedQuery);
        return matchesQuery && (status === "all" || monitor.state === status);
      })
      .sort((a, b) => {
        if (sort === "name") return a.name.localeCompare(b.name);
        if (sort === "recent") return (b.lastCheckedAt ?? 0) - (a.lastCheckedAt ?? 0);
        return STATUS_PRIORITY[a.state] - STATUS_PRIORITY[b.state] || a.name.localeCompare(b.name);
      });
  }, [monitors, query, sort, status]);

  const allVisibleSelected =
    visibleMonitors.length > 0 && visibleMonitors.every((monitor) => selected.has(monitor.id));

  function toggleAll() {
    setSelected((current) => {
      const next = new Set(current);
      if (allVisibleSelected) visibleMonitors.forEach((monitor) => next.delete(monitor.id));
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

  const overallUptime = monitors.length
    ? monitors.reduce((sum, monitor) => sum + monitor.uptime24h, 0) / monitors.length
    : 100;

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

  return (
    <div className="mx-auto max-w-[1320px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          Monitors<span className="text-up">.</span>
        </h1>
        <Link
          to="/monitors/new"
          className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-canvas shadow-sm transition-colors hover:bg-accent-hover"
        >
          <Plus className="size-4" />
          New monitor
        </Link>
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
              <label className="inline-flex w-fit items-center gap-2 rounded-lg bg-surface px-3 py-2 text-xs text-ink-muted">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleAll}
                  aria-label="Select all visible monitors"
                  className="size-3.5 accent-accent"
                />
                {selected.size} / {monitors.length}
              </label>
              <div className="flex min-w-0 flex-1 flex-wrap justify-end gap-2">
                <label className="relative min-w-[210px] flex-1 lg:max-w-[260px]">
                  <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-faint" />
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search by name or type"
                    aria-label="Search monitors"
                    className="w-full rounded-lg border border-line bg-canvas py-2 pr-3 pl-9 text-xs text-ink placeholder:text-ink-faint focus:border-transparent focus:outline-2 focus:outline-accent"
                  />
                </label>
                <label className="relative inline-flex items-center">
                  <Filter className="pointer-events-none absolute left-3 size-3.5 text-ink-faint" />
                  <select
                    value={status}
                    onChange={(event) => setStatus(event.target.value as "all" | MonitorState)}
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
                    onChange={(event) => setSort(event.target.value as SortMode)}
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

            <Card className="divide-y divide-line overflow-hidden p-0">
              {visibleMonitors.length === 0 ? (
                <p className="px-5 py-10 text-center text-sm text-ink-muted">
                  No monitors match those filters.
                </p>
              ) : (
                visibleMonitors.map((monitor) => (
                  <div
                    key={monitor.id}
                    className="grid grid-cols-[auto_auto_minmax(150px,1fr)_110px_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2/55 md:grid-cols-[auto_auto_minmax(190px,1fr)_90px_minmax(130px,180px)_42px]"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(monitor.id)}
                      onChange={() => toggleSelected(monitor.id)}
                      aria-label={`Select ${monitor.name}`}
                      className="size-3.5 accent-accent"
                    />
                    <span
                      title={STATE_META[monitor.state].label}
                      className="grid size-7 place-items-center rounded-full bg-surface-2 text-paused"
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
                      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-faint">
                        <span className="rounded border border-line px-1 uppercase">
                          {monitorTypeLabel(monitor.type)}
                        </span>
                        <span>{STATE_META[monitor.state].label}</span>
                        {monitor.lastCheckedAt && (
                          <span className="hidden sm:inline">· {formatRelativeTime(monitor.lastCheckedAt)}</span>
                        )}
                      </div>
                    </Link>
                    <span className="flex items-center justify-end gap-1 text-xs text-ink-faint">
                      <Clock3 className="size-3" />
                      {intervalLabel(monitor.intervalSeconds)}
                    </span>
                    <div className="hidden md:block">
                      <UptimeBar segments={uptimeSegments(monitor.uptime24h, monitor.state)} />
                      <div className="mt-0.5 text-right text-[10px] text-ink-muted">
                        {formatPct(monitor.uptime24h)}
                      </div>
                    </div>
                    <Link
                      to={`/monitors/${monitor.id}`}
                      aria-label={`Open ${monitor.name} details`}
                      className="justify-self-end rounded-md p-2 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
                    >
                      <MoreHorizontal className="size-4" />
                    </Link>
                  </div>
                ))
              )}
            </Card>
          </section>

          <aside aria-label="Monitoring summary" className="hidden space-y-4 xl:block">
            <Card className="p-5">
              <h2 className="text-sm font-semibold">
                Current status<span className="text-up">.</span>
              </h2>
              <div className="my-5 flex justify-center">
                <span className="grid size-10 place-items-center rounded-full bg-surface-2 text-ink-muted">
                  {(counts?.paused ?? 0) === monitors.length && monitors.length > 0 ? (
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
                Monitoring {monitors.length} service{monitors.length === 1 ? "" : "s"}.
              </p>
            </Card>

            <Card className="p-5">
              <h2 className="text-sm font-semibold">
                Last 24 hours<span className="text-up">.</span>
              </h2>
              <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-5">
                <SummaryMetric label="Overall uptime" value={formatPct(overallUptime)} accent />
                <SummaryMetric label="MTBF" value="N/A" />
                <SummaryMetric
                  label="Without incident"
                  value={(counts?.openIncidents ?? 0) === 0 ? "1d" : "0d"}
                />
                <SummaryMetric label="Incidents" value={counts?.openIncidents ?? 0} />
              </div>
            </Card>
          </aside>
        </div>
      )}
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
      <div className={accent ? "text-base font-semibold text-up" : "text-base font-semibold text-ink"}>
        {value}
      </div>
      <div className="mt-0.5 text-[11px] leading-tight text-ink-muted">{label}</div>
    </div>
  );
}
