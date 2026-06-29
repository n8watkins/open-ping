import { Activity, Plus } from "lucide-react";

// Explicit class strings (not interpolated) so Tailwind's static extraction
// keeps these utilities in the build.
const STAT_CARDS = [
  { label: "Monitors", value: "0", valueClass: "text-ink" },
  { label: "Up", value: "0", valueClass: "text-up" },
  { label: "Degraded", value: "0", valueClass: "text-degraded" },
  { label: "Down", value: "0", valueClass: "text-down" },
];

export default function Dashboard() {
  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Overview</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Status of everything OpenPing is watching.
          </p>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-canvas transition-colors hover:bg-accent-hover"
        >
          <Plus className="size-4" />
          Add monitor
        </button>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {STAT_CARDS.map((stat) => (
          <div
            key={stat.label}
            className="rounded-card border border-line bg-surface p-4"
          >
            <div className="text-xs font-medium text-ink-muted">{stat.label}</div>
            <div className={`mt-2 text-2xl font-semibold ${stat.valueClass}`}>
              {stat.value}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 flex flex-col items-center justify-center gap-3 rounded-card border border-dashed border-line bg-surface/40 px-6 py-20 text-center">
        <span className="grid size-12 place-items-center rounded-full bg-accent-soft">
          <Activity className="size-6 text-accent" />
        </span>
        <h2 className="text-base font-medium">No monitors yet</h2>
        <p className="max-w-sm text-sm text-ink-muted">
          Add your first HTTP or heartbeat monitor to start tracking uptime,
          response time, and incidents.
        </p>
      </div>
    </div>
  );
}
