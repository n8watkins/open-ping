import { Link } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Loader2,
  MoonStar,
  Plus,
  XCircle,
} from "lucide-react";
import { useFetch } from "../lib/useFetch";
import { monitorTypeLabel, type MonitorSummary, type OverviewResponse } from "../lib/types";
import { StatusPill } from "../components/ui/StatusPill";
import { Card } from "../components/ui/Card";
import { Stat } from "../components/ui/Stat";
import { EmptyState } from "../components/ui/EmptyState";
import { UptimeBar } from "../components/ui/UptimeBar";
import { PageTitle } from "../components/ui/PageTitle";
import { cn } from "../lib/cn";
import { formatMs, formatPct, formatRelativeTime } from "../lib/format";

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
  return { tone: "up" as const, icon: CheckCircle2, title: "All systems operational" };
}

const TONE = {
  down: { box: "border-down/40 bg-down/[0.07]", icon: "bg-down/15 text-down" },
  degraded: { box: "border-degraded/40 bg-degraded/[0.07]", icon: "bg-degraded/15 text-degraded" },
  up: { box: "border-up/35 bg-up/[0.06]", icon: "bg-up/15 text-up" },
} as const;

export default function Dashboard() {
  const { data, loading, error } = useFetch<OverviewResponse>("/api/overview");

  if (loading && !data) {
    return (
      <div className="grid min-h-[40vh] place-items-center">
        <Loader2 className="size-6 animate-spin text-ink-faint" />
      </div>
    );
  }

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
  const v = verdict(counts);
  const down = (counts?.down ?? 0) + (counts?.suspended ?? 0);
  const offHours = counts?.scheduled_off ?? 0;
  const lastChecked = monitors.reduce<number | null>(
    (max, m) => (m.lastCheckedAt != null && (max == null || m.lastCheckedAt > max) ? m.lastCheckedAt : max),
    null,
  );
  const attention = monitors
    .filter((m) => ATTENTION_RANK[m.state] != null)
    .sort((a, b) => (ATTENTION_RANK[a.state] ?? 9) - (ATTENTION_RANK[b.state] ?? 9));

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageTitle description="Everything OpenPing is watching, at a glance.">Overview</PageTitle>
        <Link
          to="/monitors/new"
          className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-canvas transition-colors hover:bg-accent-hover"
        >
          <Plus className="size-4" />
          Add monitor
        </Link>
      </div>

      {monitors.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={<Activity className="size-6 text-accent" />}
            title="No monitors yet"
            description="Add a website, API, port, DNS record, domain or cron heartbeat, and OpenPing checks it on the next run, every 12 minutes."
            action={
              <Link
                to="/monitors/new"
                className="inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-canvas transition-colors hover:bg-accent-hover"
              >
                <Plus className="size-4" />
                Add your first monitor
              </Link>
            }
          />
        </div>
      ) : (
        <>
          {/* The verdict */}
          <div className={cn("mt-6 flex items-center gap-4 rounded-card border p-5", TONE[v.tone].box)}>
            <span className={cn("grid size-11 shrink-0 place-items-center rounded-full", TONE[v.tone].icon)}>
              <v.icon className="size-6" />
            </span>
            <div className="min-w-0">
              <p className="text-lg font-semibold tracking-tight text-ink">{v.title}</p>
              <p className="mt-0.5 text-sm text-ink-muted">
                {counts?.total ?? 0} monitor{counts?.total === 1 ? "" : "s"}
                {offHours > 0 && `, ${offHours} off-hours right now`}
                {lastChecked != null && `, last checked ${formatRelativeTime(lastChecked)}`}
              </p>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Card className="p-4"><Stat label="Monitors" value={counts?.total ?? 0} /></Card>
            <Card className="p-4"><Stat label="Up" value={counts?.up ?? 0} valueClass="text-up" /></Card>
            <Card className="p-4"><Stat label="Degraded" value={counts?.degraded ?? 0} valueClass={counts?.degraded ? "text-degraded" : undefined} /></Card>
            <Card className="p-4"><Stat label="Down" value={down} valueClass={down ? "text-down" : undefined} /></Card>
            <Card className="p-4"><Stat label="Off-hours" value={offHours} valueClass={offHours ? "text-scheduled" : undefined} /></Card>
            <Card className="p-4"><Stat label="Open incidents" value={counts?.openIncidents ?? 0} valueClass={counts?.openIncidents ? "text-down" : undefined} /></Card>
          </div>

          {channels.some((ch) => !ch.healthy && ch.enabled) && (
            <Link
              to="/integrations"
              className="mt-4 flex items-center gap-2 rounded-lg border border-degraded/40 bg-degraded/10 px-3 py-2 text-sm text-degraded transition-colors hover:bg-degraded/15"
            >
              <AlertTriangle className="size-4 shrink-0" />
              One or more alert channels are failing.
              <span className="ml-auto inline-flex items-center gap-1 font-medium">
                Check integrations <ArrowRight className="size-3.5" />
              </span>
            </Link>
          )}

          {/* What needs a look, most urgent first */}
          {attention.length > 0 && (
            <section className="mt-8">
              <h2 className="mb-3 text-sm font-semibold text-ink">Needs attention</h2>
              <Card className="divide-y divide-line overflow-hidden">
                {attention.map((m) => (
                  <Link
                    key={m.id}
                    to={`/monitors/${m.id}`}
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
                          : m.lastStatusCode != null
                            ? `Last response ${m.lastStatusCode}`
                            : "Not responding"}
                        {m.stateSince != null && `, since ${formatRelativeTime(m.stateSince)}`}
                      </span>
                    </span>
                    <ArrowRight className="size-4 shrink-0 text-ink-faint" />
                  </Link>
                ))}
              </Card>
            </section>
          )}

          <section className="mt-8">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-ink">All monitors</h2>
              <Link to="/monitors" className="inline-flex items-center gap-1 text-sm text-ink-muted transition-colors hover:text-ink">
                Manage <ArrowRight className="size-3.5" />
              </Link>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {monitors.map((m) => (
                <Link key={m.id} to={`/monitors/${m.id}`} className="group">
                  <Card className="flex h-full flex-col p-4 transition-colors group-hover:border-ink-faint/40">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate font-medium">{m.name}</div>
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
                    {m.recentChecks.length > 0 && (
                      <div className="mt-4">
                        <UptimeBar segments={m.recentChecks.map((c) => ({ state: c.state }))} />
                      </div>
                    )}
                    <div className="mt-3 flex items-center justify-between text-xs text-ink-muted">
                      <span>{formatPct(m.uptime24h)} over 24h</span>
                      <span className="tabular-nums">
                        {m.lastDurationMs != null ? formatMs(m.lastDurationMs) : "-"}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-ink-faint">
                      {m.lastCheckedAt ? `Checked ${formatRelativeTime(m.lastCheckedAt)}` : "Not checked yet"}
                    </div>
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
