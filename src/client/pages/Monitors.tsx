import { Link } from "react-router-dom";
import { Activity, Plus, Loader2 } from "lucide-react";
import { useFetch } from "../lib/useFetch";
import type { OverviewResponse } from "../lib/types";
import { StatusPill } from "../components/ui/StatusPill";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { formatMs, formatPct, formatRelativeTime } from "../lib/format";

export default function Monitors() {
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
      <div className="mx-auto max-w-5xl">
        <h1 className="text-xl font-semibold tracking-tight">Monitors</h1>
        <p className="mt-6 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
          Could not load monitors: {error}
        </p>
      </div>
    );
  }

  const monitors = data?.monitors ?? [];

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Monitors</h1>
        <Link
          to="/monitors/new"
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-canvas transition-colors hover:bg-accent-hover"
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
            description="Create your first monitor to begin tracking uptime."
          />
        </div>
      ) : (
        <Card className="mt-6 divide-y divide-line p-0">
          {monitors.map((m) => (
            <Link
              key={m.id}
              to={`/monitors/${m.id}`}
              className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-surface-2"
            >
              <div className="flex min-w-0 items-center gap-3">
                <StatusPill state={m.state} />
                <div className="min-w-0">
                  <div className="truncate font-medium">{m.name}</div>
                  <div className="text-xs text-ink-faint capitalize">
                    {m.type} · {m.scheduleMode.replace("_", " ")}
                  </div>
                </div>
              </div>
              <div className="hidden shrink-0 items-center gap-6 text-xs text-ink-muted sm:flex">
                <span>{formatPct(m.uptime24h)} 24h</span>
                <span>{m.lastDurationMs != null ? formatMs(m.lastDurationMs) : "—"}</span>
                <span className="w-20 text-right text-ink-faint">
                  {m.lastCheckedAt ? formatRelativeTime(m.lastCheckedAt) : "—"}
                </span>
              </div>
            </Link>
          ))}
        </Card>
      )}
    </div>
  );
}
