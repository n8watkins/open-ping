import { Link } from "react-router-dom";
import { Activity, Plus, Loader2, AlertTriangle } from "lucide-react";
import { useFetch } from "../lib/useFetch";
import type { OverviewResponse } from "../lib/types";
import { StatusPill } from "../components/ui/StatusPill";
import { Card } from "../components/ui/Card";
import { Stat } from "../components/ui/Stat";
import { EmptyState } from "../components/ui/EmptyState";
import { formatMs, formatPct, formatRelativeTime } from "../lib/format";

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
        <h1 className="text-xl font-semibold tracking-tight">Overview</h1>
        <p className="mt-4 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
          Could not load overview: {error}
        </p>
      </div>
    );
  }

  const counts = data?.counts;
  const monitors = data?.monitors ?? [];
  const channels = data?.channels ?? [];

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Overview</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Status of everything OpenPing is watching.
          </p>
        </div>
        <Link
          to="/monitors/new"
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-canvas transition-colors hover:bg-accent-hover"
        >
          <Plus className="size-4" />
          Add monitor
        </Link>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
        <Card className="p-4"><Stat label="Monitors" value={counts?.total ?? 0} /></Card>
        <Card className="p-4"><Stat label="Up" value={counts?.up ?? 0} valueClass="text-up" /></Card>
        <Card className="p-4"><Stat label="Degraded" value={counts?.degraded ?? 0} valueClass="text-degraded" /></Card>
        <Card className="p-4"><Stat label="Down" value={counts?.down ?? 0} valueClass="text-down" /></Card>
        <Card className="p-4"><Stat label="Open incidents" value={counts?.openIncidents ?? 0} valueClass={counts?.openIncidents ? "text-down" : undefined} /></Card>
      </div>

      {channels.some((ch) => !ch.healthy && ch.enabled) && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-degraded/40 bg-degraded/10 px-3 py-2 text-sm text-degraded">
          <AlertTriangle className="size-4" />
          One or more notification channels are failing. Check Integrations.
        </div>
      )}

      <h2 className="mt-8 mb-3 text-sm font-medium text-ink-muted">Monitors</h2>
      {monitors.length === 0 ? (
        <EmptyState
          icon={<Activity className="size-6 text-accent" />}
          title="No monitors yet"
          description="Add your first HTTP or heartbeat monitor to start tracking uptime, response time, and incidents."
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {monitors.map((m) => (
            <Link key={m.id} to={`/monitors/${m.id}`}>
              <Card className="p-4 transition-colors hover:border-ink-faint/40">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{m.name}</div>
                    <div className="mt-0.5 text-xs text-ink-faint capitalize">{m.type}</div>
                  </div>
                  <StatusPill state={m.state} />
                </div>
                <div className="mt-4 flex items-center justify-between text-xs text-ink-muted">
                  <span>24h uptime {formatPct(m.uptime24h)}</span>
                  <span>{m.lastDurationMs != null ? formatMs(m.lastDurationMs) : "—"}</span>
                </div>
                <div className="mt-1 text-xs text-ink-faint">
                  {m.lastCheckedAt ? `Checked ${formatRelativeTime(m.lastCheckedAt)}` : "Not checked yet"}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
