import { Link } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  MoonStar,
  Plus,
  ShieldCheck,
  Wrench,
  XCircle,
} from "lucide-react";
import { useFetch } from "../lib/useFetch";
import { monitorTypeLabel, type MonitorSummary, type OverviewResponse } from "../lib/types";
import { useTimeRange } from "../lib/time-range";
import { StatusPill } from "../components/ui/StatusPill";
import { Card, CardHeader, CardTitle } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { PageTitle } from "../components/ui/PageTitle";
import { RangeControl } from "../components/ui/RangeControl";
import { Skeleton } from "../components/ui/Skeleton";
import { StatusStrip, StripLegend } from "../components/charts/StatusStrip";
import { ResponseChart } from "../components/charts/ResponseChart";
import { TrendLine } from "../components/charts/TrendLine";
import { offHourBands } from "../components/charts/chart-math";
import { describeCause, groupIncidents, type IncidentGroup } from "../components/ui/incident-groups";
import { cn } from "../lib/cn";
import {
  formatDuration,
  formatMs,
  formatPct,
  formatRelativeTime,
  formatShortDateTime,
} from "../lib/format";
import {
  RANGE_SPEC,
  type MonitorRangeSummary,
  type OverviewHistoryResponse,
  type TimeRange,
} from "../../shared/time-range";

/** GET /api/overview adds maintenance to the shared overview shape. */
interface MaintenanceEntry {
  id: string;
  title: string | null;
  scope: "global" | "monitors";
  monitorIds: string[] | null;
  startsAt: number;
  endsAt: number;
  recurring: boolean;
}
/** Monitors on the overview also carry their open incident, when there is one. */
type OverviewMonitor = MonitorSummary & { activeIncidentId?: string | null };
type OverviewPayload = Omit<OverviewResponse, "monitors"> & {
  monitors: OverviewMonitor[];
  maintenance?: { active: MaintenanceEntry[]; upcoming: MaintenanceEntry[] };
};

// Outages first, then the merely slow, so the most urgent row is on top.
const ATTENTION_RANK: Partial<Record<MonitorSummary["state"], number>> = {
  down: 0,
  suspended: 1,
  degraded: 2,
};

/** The one-line verdict at the top, from the same counts as the sidebar. */
function verdict(counts: OverviewResponse["counts"] | undefined) {
  const down = (counts?.down ?? 0) + (counts?.suspended ?? 0);
  const degraded = counts?.degraded ?? 0;
  if (down > 0)
    return {
      tone: "down" as const,
      icon: XCircle,
      title: `${down} monitor${down === 1 ? " is" : "s are"} down`,
    };
  if (degraded > 0)
    return {
      tone: "degraded" as const,
      icon: CircleAlert,
      title: `${degraded} monitor${degraded === 1 ? " is" : "s are"} slow or degraded`,
    };
  if ((counts?.openIncidents ?? 0) > 0)
    return { tone: "degraded" as const, icon: CircleAlert, title: "Recovering from an incident" };
  return { tone: "up" as const, icon: CheckCircle2, title: "All systems operational" };
}

const TONE = {
  down: {
    box: "border-down/40 bg-linear-to-br from-down/[0.12] to-down/[0.03]",
    icon: "bg-down/15 text-down ring-down/25",
  },
  degraded: {
    box: "border-degraded/40 bg-linear-to-br from-degraded/[0.12] to-degraded/[0.03]",
    icon: "bg-degraded/15 text-degraded ring-degraded/25",
  },
  up: {
    box: "border-up/30 bg-linear-to-br from-up/[0.10] to-up/[0.02]",
    icon: "bg-up/15 text-up ring-up/25",
  },
} as const;

/** Tint an uptime percentage by health, using only static utility classes. */
function uptimeClass(pct: number | null): string {
  if (pct == null) return "text-ink-faint";
  if (pct >= 99.9) return "text-up";
  if (pct >= 98) return "text-ink";
  if (pct >= 95) return "text-degraded";
  return "text-down";
}

const accentButton =
  "inline-flex shrink-0 items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-canvas transition-colors hover:bg-accent-hover";

export default function Dashboard() {
  const [range, setRange] = useTimeRange("overview");
  const { data, loading, error } = useFetch<OverviewPayload>("/api/overview");
  const history = useFetch<OverviewHistoryResponse>(`/api/overview/history?range=${range}`);

  if (loading && !data) return <DashboardSkeleton />;

  if (error && !data) {
    return (
      <div className="mx-auto max-w-6xl">
        <PageTitle>Overview</PageTitle>
        <p className="mt-4 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
          Could not load overview: {error}
        </p>
      </div>
    );
  }

  const counts = data?.counts;
  const monitors = data?.monitors ?? [];
  const channels = data?.channels ?? [];
  const h = history.data;
  // While a new range loads, the previous one stays on screen, dimmed.
  const stale = h != null && h.range !== range;
  const byId = new Map<string, MonitorRangeSummary>((h?.monitors ?? []).map((m) => [m.id, m]));
  const maintenance = data?.maintenance;
  const hasMaintenance = (maintenance?.active.length ?? 0) + (maintenance?.upcoming.length ?? 0) > 0;
  const attention = monitors
    .filter((m) => ATTENTION_RANK[m.state] != null)
    .sort((a, b) => (ATTENTION_RANK[a.state] ?? 9) - (ATTENTION_RANK[b.state] ?? 9));
  const failingChannels = channels.filter((ch) => !ch.healthy && ch.enabled);
  // Open incidents not already shown through their monitor's row.
  const otherOpenIncidents = Math.max(
    0,
    (counts?.openIncidents ?? 0) - attention.filter((m) => m.activeIncidentId).length,
  );

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageTitle description="Everything OpenPing is watching, at a glance.">Overview</PageTitle>
        <div className="flex flex-wrap items-center gap-2">
          {monitors.length > 0 && <RangeControl value={range} onChange={setRange} />}
          <Link to="/monitors/new" className={accentButton}>
            <Plus className="size-4" />
            Add monitor
          </Link>
        </div>
      </div>

      {monitors.length === 0 ? (
        <div className="mt-6 animate-enter">
          <EmptyState
            icon={<Activity className="size-6 text-accent" />}
            title="No monitors yet"
            description="Add a website, API, port, DNS record, domain or cron heartbeat, and OpenPing checks it on the next run, every 12 minutes."
            action={
              <Link to="/monitors/new" className={accentButton}>
                <Plus className="size-4" />
                Add your first monitor
              </Link>
            }
          />
        </div>
      ) : (
        <>
          <HeroStatus counts={counts} monitors={monitors} />

          {(attention.length > 0 || failingChannels.length > 0 || otherOpenIncidents > 0) && (
            <NeedsAttention
              monitors={attention}
              openIncidents={otherOpenIncidents}
              failingChannels={failingChannels.length}
            />
          )}

          <HistoryCard history={h} range={range} stale={stale} loading={history.loading} error={history.error} />

          <section className="mt-8 animate-enter" aria-labelledby="monitors-heading">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 id="monitors-heading" className="text-sm font-semibold text-ink">
                Monitors
              </h2>
              <Link
                to="/monitors"
                className="inline-flex items-center gap-1 rounded text-sm text-ink-muted transition-colors hover:text-ink"
              >
                Manage <ArrowRight className="size-3.5" />
              </Link>
            </div>
            <div className="stagger grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {monitors.map((m) => (
                <MonitorCard
                  key={m.id}
                  monitor={m}
                  history={byId.get(m.id)}
                  bucketMs={h?.bucketMs ?? RANGE_SPEC[range].bucketMs}
                  range={h?.range ?? range}
                  stale={stale}
                  loading={!h}
                />
              ))}
            </div>
          </section>

          <div className={cn("mt-8 grid gap-4", hasMaintenance && "lg:grid-cols-3")}>
            <IncidentsCard
              history={h}
              range={range}
              stale={stale}
              withoutIncidentSeconds={data?.analytics.withoutIncidentSeconds ?? null}
              className={hasMaintenance ? "lg:col-span-2" : undefined}
            />
            {hasMaintenance && maintenance && <MaintenanceCard maintenance={maintenance} />}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Headline
// ---------------------------------------------------------------------------

function HeroStatus({
  counts,
  monitors,
}: {
  counts: OverviewResponse["counts"] | undefined;
  monitors: MonitorSummary[];
}) {
  const v = verdict(counts);
  const lastChecked = monitors.reduce<number | null>(
    (max, m) => (m.lastCheckedAt != null && (max == null || m.lastCheckedAt > max) ? m.lastCheckedAt : max),
    null,
  );
  const down = (counts?.down ?? 0) + (counts?.suspended ?? 0);
  const chips: { n: number; label: string; dot: string; text: string }[] = [
    { n: counts?.up ?? 0, label: "up", dot: "bg-up", text: "text-up" },
    { n: counts?.degraded ?? 0, label: "degraded", dot: "bg-degraded", text: "text-degraded" },
    { n: down, label: "down", dot: "bg-down", text: "text-down" },
    { n: counts?.scheduled_off ?? 0, label: "off-hours", dot: "bg-scheduled", text: "text-ink" },
    { n: counts?.paused ?? 0, label: "paused", dot: "bg-paused", text: "text-ink" },
    { n: counts?.maintenance ?? 0, label: "in maintenance", dot: "bg-maint", text: "text-maint" },
    {
      n: counts?.openIncidents ?? 0,
      label: counts?.openIncidents === 1 ? "open incident" : "open incidents",
      dot: "bg-down",
      text: "text-down",
    },
  ];
  return (
    <section
      aria-label="Current status"
      className={cn(
        "mt-6 flex animate-enter flex-wrap items-center gap-x-6 gap-y-4 rounded-card border p-5",
        TONE[v.tone].box,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <span className={cn("grid size-12 shrink-0 place-items-center rounded-full ring-4", TONE[v.tone].icon)}>
          <v.icon className="size-6" />
        </span>
        <div className="min-w-0">
          <p className="text-xl font-semibold tracking-tight text-ink">{v.title}</p>
          <ul className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
            <li>
              <span className="font-medium text-ink tabular-nums">{counts?.total ?? 0}</span> monitor
              {counts?.total === 1 ? "" : "s"}
            </li>
            {chips
              // Always show up/degraded/down; the rest only when they apply.
              .filter((c, i) => i < 3 || c.n > 0)
              .map((c) => (
                <li key={c.label} className="inline-flex items-center gap-1.5">
                  <span className={cn("size-1.5 rounded-full", c.n > 0 ? c.dot : "bg-line")} aria-hidden="true" />
                  <span className={cn("font-medium tabular-nums", c.n > 0 ? c.text : "text-ink-faint")}>{c.n}</span>
                  <span className={c.n > 0 ? undefined : "text-ink-faint"}>{c.label}</span>
                </li>
              ))}
            {lastChecked != null && <li className="text-ink-faint">Last check {formatRelativeTime(lastChecked)}</li>}
          </ul>
        </div>
      </div>
    </section>
  );
}

function NeedsAttention({
  monitors,
  openIncidents,
  failingChannels,
}: {
  monitors: OverviewMonitor[];
  openIncidents: number;
  failingChannels: number;
}) {
  return (
    <section className="mt-6 animate-enter" aria-labelledby="attention-heading">
      <h2 id="attention-heading" className="mb-3 inline-flex items-center gap-2 text-sm font-semibold text-ink">
        <AlertTriangle className="size-4 text-degraded" />
        Needs attention
      </h2>
      <Card className="divide-y divide-line overflow-hidden p-0">
        {monitors.map((m) => (
          <Link
            key={m.id}
            to={m.activeIncidentId ? `/incidents?incident=${encodeURIComponent(m.activeIncidentId)}` : `/monitors/${m.id}`}
            className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2/50"
          >
            {/* A fixed column, so the names line up whatever the pill says. */}
            <span className="w-24 shrink-0">
              <StatusPill state={m.state} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{m.name}</span>
              <span className="block truncate text-xs text-ink-faint">
                {m.state === "degraded" && m.lastDurationMs != null
                  ? `Responding in ${formatMs(m.lastDurationMs)}`
                  : m.state === "suspended"
                    ? "Suspended by the host"
                    : m.lastStatusCode != null
                      ? `Last response ${m.lastStatusCode}`
                      : "Not responding"}
                {m.stateSince != null && `, since ${formatRelativeTime(m.stateSince)}`}
              </span>
            </span>
            <ArrowRight className="size-4 shrink-0 text-ink-faint" />
          </Link>
        ))}
        {openIncidents > 0 && (
          <Link to="/incidents" className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2/50">
            <span className="w-24 shrink-0">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 py-1 text-xs font-medium text-down">
                <span className="size-1.5 rounded-full bg-down" />
                Open
              </span>
            </span>
            <span className="min-w-0 flex-1 truncate font-medium">
              {openIncidents} {monitors.length > 0 ? "other " : ""}open incident{openIncidents === 1 ? "" : "s"}
            </span>
            <ArrowRight className="size-4 shrink-0 text-ink-faint" />
          </Link>
        )}
        {failingChannels > 0 && (
          <Link
            to="/integrations"
            className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2/50"
          >
            <span className="w-24 shrink-0">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 py-1 text-xs font-medium text-degraded">
                <span className="size-1.5 rounded-full bg-degraded" />
                Failing
              </span>
            </span>
            <span className="min-w-0 flex-1 truncate font-medium">
              {failingChannels} alert channel{failingChannels === 1 ? " is" : "s are"} failing to deliver
            </span>
            <ArrowRight className="size-4 shrink-0 text-ink-faint" />
          </Link>
        )}
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Install-wide history
// ---------------------------------------------------------------------------

function Kpi({ label, value, hint, valueClass }: { label: string; value: string; hint?: string; valueClass?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-medium text-ink-muted">{label}</div>
      <div className={cn("mt-1 truncate text-xl font-semibold tabular-nums tracking-tight text-ink", valueClass)}>{value}</div>
      {hint && <div className="mt-0.5 truncate text-xs text-ink-faint">{hint}</div>}
    </div>
  );
}

function HistoryCard({
  history: h,
  range,
  stale,
  loading,
  error,
}: {
  history: OverviewHistoryResponse | null;
  range: TimeRange;
  stale: boolean;
  loading: boolean;
  error: string | null;
}) {
  const spec = RANGE_SPEC[range];
  return (
    <Card className="mt-6 animate-enter p-5">
      <CardHeader>
        <CardTitle>Availability and response time</CardTitle>
        <span className="text-xs text-ink-faint">{spec.long}, all monitors</span>
      </CardHeader>

      {!h ? (
        error && !loading ? (
          <p className="text-sm text-down">Could not load history: {error}</p>
        ) : (
          <HistorySkeleton />
        )
      ) : (
        <div className={cn("transition-opacity duration-(--duration-base)", stale && "opacity-50")} aria-busy={stale}>
          <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
            <Kpi
              label="Uptime"
              value={h.overall.uptimePct != null ? formatPct(h.overall.uptimePct) : "-"}
              valueClass={uptimeClass(h.overall.uptimePct)}
              hint={`${h.overall.checks.toLocaleString()} checks`}
            />
            <Kpi
              label="Downtime"
              value={h.overall.downtimeSeconds > 0 ? formatDuration(h.overall.downtimeSeconds) : "None"}
              valueClass={h.overall.downtimeSeconds > 0 ? undefined : "text-up"}
              hint={
                h.overall.suspendedSeconds > 0
                  ? `summed over monitors, ${Math.round((h.overall.suspendedSeconds / h.overall.downtimeSeconds) * 100)}% suspended`
                  : "summed over monitors"
              }
            />
            <Kpi
              label="Incidents"
              value={String(h.incidentCount)}
              valueClass={h.incidentCount > 0 ? undefined : "text-up"}
              hint={h.incidentCount > 0 ? "started or open in range" : "none in range"}
            />
            <Kpi
              label="Median response"
              value={formatMs(h.overall.latency.median)}
              hint={h.overall.latency.basis === "checks" ? "of every check" : `of ${h.overall.latency.basis} averages`}
            />
            <Kpi label="p95 response" value={formatMs(h.overall.latency.p95)} hint={`max ${formatMs(h.overall.latency.max)}`} />
          </div>

          <div key={h.range} className="mt-5 animate-fade">
            <StatusStrip
              buckets={h.overall.buckets}
              bucketMs={h.bucketMs}
              label={`All monitors, ${RANGE_SPEC[h.range].long.toLowerCase()}`}
              size="lg"
              minSegmentPx={range === "24h" ? 8 : 4}
            />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <StripLegend states={h.overall.buckets.map((b) => b.state)} />
              <span className="text-xs text-ink-faint">
                {h.bucketMs >= 86_400_000 ? "One bar per day (UTC)" : "One bar per hour"}
              </span>
            </div>

            <div className="mt-5 border-t border-line pt-4">
              <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-xs font-medium text-ink-muted">
                  Average response time per {h.bucketMs >= 86_400_000 ? "day" : "hour"}
                </span>
                <ChartKey
                  median={h.overall.latency.median}
                  offHours={h.overall.offSeconds > 0}
                />
              </div>
              <ResponseChart
                points={h.overall.buckets.flatMap((b) => (b.avgMs != null ? [{ t: b.t, ms: b.avgMs }] : []))}
                from={h.from}
                to={h.to}
                bucketMs={h.bucketMs}
                kind="bucket"
                gapMs={h.bucketMs * 1.5}
                bands={offHourBands(h.overall.buckets, h.bucketMs)}
                median={h.overall.latency.median}
                label={`Average response time of all monitors, ${RANGE_SPEC[h.range].long.toLowerCase()}`}
                height={150}
              />
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

/** The key under a response chart: the median line and the off-hours shading. */
export function ChartKey({ median, offHours }: { median: number | null; offHours: boolean }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
      {median != null && (
        <span className="inline-flex items-center gap-1.5">
          <span className="w-3.5 border-t border-dashed border-up/70" aria-hidden="true" />
          Median {formatMs(median)}
        </span>
      )}
      {offHours && (
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-[2px] bg-scheduled/30" aria-hidden="true" />
          Off-hours, not downtime
        </span>
      )}
    </span>
  );
}

function HistorySkeleton() {
  return (
    <div aria-hidden="true">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i}>
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-2 h-6 w-20" />
            <Skeleton className="mt-1.5 h-3 w-24" />
          </div>
        ))}
      </div>
      <Skeleton className="mt-5 h-10 w-full" />
      <Skeleton className="mt-6 h-[150px] w-full" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Monitor cards
// ---------------------------------------------------------------------------

function MonitorCard({
  monitor: m,
  history,
  bucketMs,
  range,
  stale,
  loading,
}: {
  monitor: MonitorSummary;
  history: MonitorRangeSummary | undefined;
  bucketMs: number;
  range: TimeRange;
  stale: boolean;
  loading: boolean;
}) {
  const uptime = history?.uptimePct ?? null;
  return (
    <Card className="group relative flex h-full animate-enter flex-col p-4 transition-[border-color,transform,box-shadow] duration-(--duration-base) ease-out-quart hover:-translate-y-0.5 hover:border-ink-faint/40 hover:shadow-lg hover:shadow-black/20">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {/* The name is the card's link; it stretches over the card, under the strip. */}
          <Link
            to={`/monitors/${m.id}`}
            className="block truncate font-medium text-ink after:absolute after:inset-0 after:rounded-card focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-accent"
          >
            {m.name}
          </Link>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-faint">
            {monitorTypeLabel(m.type)}
            {m.scheduleMode !== "always" && (
              <span className="inline-flex items-center gap-1">
                <MoonStar className="size-3" /> scheduled
              </span>
            )}
          </div>
        </div>
        <StatusPill state={m.state} />
      </div>

      {loading ? (
        <div aria-hidden="true" className="mt-4">
          <div className="flex justify-between">
            <Skeleton className="h-6 w-20" />
            <Skeleton className="h-6 w-14" />
          </div>
          <Skeleton className="mt-3 h-5 w-full" />
          <Skeleton className="mt-3 h-8 w-full" />
        </div>
      ) : (
        <div className={cn("transition-opacity duration-(--duration-base)", stale && "opacity-50")}>
          <div className="mt-4 flex items-end justify-between gap-3">
            <div>
              <div className={cn("text-lg font-semibold leading-none tabular-nums", uptimeClass(uptime))}>
                {uptime != null ? formatPct(uptime) : "No checks"}
              </div>
              <div className="mt-1 text-xs text-ink-faint">uptime, {RANGE_SPEC[range].short}</div>
            </div>
            <div className="text-right">
              <div className="text-sm font-medium leading-none tabular-nums text-ink">
                {formatMs(history?.latency.median ?? null)}
              </div>
              <div className="mt-1 text-xs text-ink-faint">median response</div>
            </div>
          </div>
          {history && (
            <div key={range} className="animate-fade">
              <StatusStrip
                buckets={history.buckets}
                bucketMs={bucketMs}
                label={`${m.name}, ${RANGE_SPEC[range].long.toLowerCase()}`}
                size="sm"
                minSegmentPx={range === "24h" ? 6 : 5}
                className="relative z-10 mt-3"
              />
              <TrendLine values={history.buckets.map((b) => b.avgMs)} height={30} className="mt-3" />
            </div>
          )}
        </div>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 pt-3 text-xs text-ink-faint">
        <span>{m.lastCheckedAt ? `Checked ${formatRelativeTime(m.lastCheckedAt)}` : "Not checked yet"}</span>
        <span className="tabular-nums">{m.lastDurationMs != null ? `last ${formatMs(m.lastDurationMs)}` : ""}</span>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Incidents and maintenance
// ---------------------------------------------------------------------------

const INCIDENT_GROUPS_SHOWN = 6;

function IncidentsCard({
  history: h,
  range,
  stale,
  withoutIncidentSeconds,
  className,
}: {
  history: OverviewHistoryResponse | null;
  range: TimeRange;
  stale: boolean;
  withoutIncidentSeconds: number | null;
  className?: string;
}) {
  const groups = h ? groupIncidents(h.incidents, h.now) : [];
  return (
    <Card className={cn("animate-enter p-5", className)}>
      <CardHeader>
        <CardTitle>Incidents</CardTitle>
        <Link
          to="/incidents"
          className="inline-flex items-center gap-1 rounded text-sm text-ink-muted transition-colors hover:text-ink"
        >
          All incidents <ArrowRight className="size-3.5" />
        </Link>
      </CardHeader>
      {!h ? (
        <div aria-hidden="true" className="space-y-4">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="flex gap-3">
              <Skeleton className="size-3 rounded-full" />
              <div className="flex-1">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="mt-1.5 h-3 w-64 max-w-full" />
              </div>
            </div>
          ))}
        </div>
      ) : groups.length === 0 ? (
        <div className={cn("flex items-center gap-3 py-2 transition-opacity", stale && "opacity-50")}>
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-up/10 text-up">
            <ShieldCheck className="size-5" />
          </span>
          <div>
            <p className="text-sm font-medium text-ink">No incidents, {RANGE_SPEC[range].long.toLowerCase()}</p>
            {withoutIncidentSeconds != null && withoutIncidentSeconds > 0 && (
              <p className="text-xs text-ink-faint">Incident-free for {formatDuration(withoutIncidentSeconds)}</p>
            )}
          </div>
        </div>
      ) : (
        <div className={cn("transition-opacity duration-(--duration-base)", stale && "opacity-50")}>
          <ol className="stagger relative">
            {groups.slice(0, INCIDENT_GROUPS_SHOWN).map((g, i, shown) => (
              <IncidentRow key={g.id} group={g} last={i === shown.length - 1} now={h.now} />
            ))}
          </ol>
          {groups.length > INCIDENT_GROUPS_SHOWN && (
            <p className="mt-1 pl-7 text-xs text-ink-faint">
              {groups.length - INCIDENT_GROUPS_SHOWN} earlier event{groups.length - INCIDENT_GROUPS_SHOWN === 1 ? "" : "s"} in
              range.{" "}
              <Link to="/incidents" className="text-accent hover:underline">
                See all
              </Link>
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

function IncidentRow({ group: g, last, now }: { group: IncidentGroup; last: boolean; now: number }) {
  const many = g.monitors.length > 1;
  const title = many
    ? `${g.monitors.length} monitors went down together`
    : `${g.monitors[0]?.name ?? "A monitor"} went down`;
  return (
    <li className="relative flex animate-enter gap-3 pb-4">
      {!last && <span aria-hidden="true" className="absolute top-4 bottom-0 left-[5px] w-px bg-line" />}
      <span
        aria-hidden="true"
        className={cn(
          "relative mt-1 size-[11px] shrink-0 rounded-full ring-4 ring-surface",
          g.open ? "bg-down" : "bg-ink-faint/60",
        )}
      />
      <Link
        to={`/incidents?incident=${encodeURIComponent(g.id)}`}
        className="-mx-2 -my-1 min-w-0 flex-1 rounded-lg px-2 py-1 transition-colors hover:bg-surface-2/60"
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-ink">{title}</span>
          {g.open ? (
            <span className="rounded-full border border-down/40 bg-down/10 px-2 py-0.5 text-[11px] font-medium text-down">
              Ongoing
            </span>
          ) : null}
          {g.causes[0] && (
            <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[11px] text-ink-muted">
              {describeCause(g.causes[0])}
            </span>
          )}
        </div>
        <div className="mt-0.5 text-xs text-ink-faint">
          {formatShortDateTime(g.startedAt, now)}
          {" · "}
          {g.open ? `down for ${formatDuration(g.durationSeconds)} so far` : `lasted ${formatDuration(g.durationSeconds)}`}
          {many && ` · ${g.monitors.map((mon) => mon.name).join(", ")}`}
        </div>
      </Link>
    </li>
  );
}

function MaintenanceCard({
  maintenance,
}: {
  maintenance: { active: MaintenanceEntry[]; upcoming: MaintenanceEntry[] };
}) {
  const rows = [
    ...maintenance.active.map((w) => ({ w, active: true })),
    ...maintenance.upcoming.map((w) => ({ w, active: false })),
  ];
  return (
    <Card className="animate-enter p-5">
      <CardHeader>
        <CardTitle>Maintenance</CardTitle>
        <Link
          to="/maintenance"
          className="inline-flex items-center gap-1 rounded text-sm text-ink-muted transition-colors hover:text-ink"
        >
          Manage <ArrowRight className="size-3.5" />
        </Link>
      </CardHeader>
      <ul className="space-y-3">
        {rows.map(({ w, active }) => (
          <li key={`${w.id}-${w.startsAt}`} className="flex gap-3">
            <span
              className={cn(
                "grid size-8 shrink-0 place-items-center rounded-lg",
                active ? "bg-maint/15 text-maint" : "bg-surface-2 text-ink-muted",
              )}
            >
              {active ? <Wrench className="size-4" /> : <CalendarClock className="size-4" />}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm font-medium text-ink">{w.title ?? "Maintenance"}</span>
                {active && (
                  <span className="rounded-full border border-maint/40 bg-maint/10 px-2 py-0.5 text-[11px] font-medium text-maint">
                    In progress
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-xs text-ink-muted">
                {active ? `Until ${formatShortDateTime(w.endsAt)}` : `${formatShortDateTime(w.startsAt)} - ${formatShortDateTime(w.endsAt)}`}
              </div>
              <div className="text-xs text-ink-faint">
                {w.scope === "global"
                  ? "All monitors"
                  : `${w.monitorIds?.length ?? 0} monitor${w.monitorIds?.length === 1 ? "" : "s"}`}
                {w.recurring && " · weekly"}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div className="mx-auto max-w-6xl animate-fade" aria-busy="true" aria-label="Loading overview">
      <div className="flex items-end justify-between gap-3">
        <div>
          <Skeleton className="h-7 w-36" />
          <Skeleton className="mt-2 h-4 w-64" />
        </div>
        <Skeleton className="h-9 w-56" />
      </div>
      <Skeleton className="mt-6 h-[92px] w-full rounded-card" />
      <Skeleton className="mt-6 h-[380px] w-full rounded-card" />
      <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-[196px] rounded-card" />
        ))}
      </div>
    </div>
  );
}
