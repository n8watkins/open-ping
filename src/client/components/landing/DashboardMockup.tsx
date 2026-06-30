import { Activity, Bell, Clock } from "lucide-react";
import { Sparkline } from "../ui/Sparkline";
import { StatusPill } from "../ui/StatusPill";
import { UptimeBar } from "../ui/UptimeBar";
import type { MonitorState } from "../../../shared/states";

/*
 * Original, illustrative OpenPing dashboard mockup built entirely from the app's
 * own design tokens and UI primitives (StatusPill / UptimeBar / Sparkline). It
 * contains no real data and copies no third-party screenshot — it exists purely
 * to show what the product looks like. Deterministic sample arrays keep it from
 * shifting between renders.
 */

const SPARK_A = [42, 39, 41, 38, 44, 40, 37, 39, 41, 38, 40, 36];
const SPARK_B = [120, 118, 240, 410, 180, 130, 125, 122, 119, 121, 118, 120];
const SPARK_C = [88, 86, 90, 87, 89, 91, 88, 86, 90, 89, 87, 88];

/** Build a deterministic uptime strip with an optional fault window. */
function strip(
  base: MonitorState,
  faults: { at: number; state: MonitorState }[] = [],
): { state: MonitorState; title?: string }[] {
  const segs = Array.from({ length: 32 }, () => ({ state: base }));
  for (const f of faults) segs[f.at] = { state: f.state };
  return segs;
}

interface Row {
  name: string;
  type: string;
  state: MonitorState;
  uptime: string;
  latency: string;
  spark: number[];
  segments: { state: MonitorState; title?: string }[];
}

// The hero shows exactly three monitors — enough to convey the product without
// overwhelming the fold — and deliberately keeps one in "Scheduled off" to
// showcase OpenPing's schedule-aware differentiator.
const ROWS: Row[] = [
  {
    name: "api.acme.dev",
    type: "HTTP · API check",
    state: "up",
    uptime: "99.98%",
    latency: "118 ms",
    spark: SPARK_A,
    segments: strip("up"),
  },
  {
    name: "checkout-service",
    type: "HTTP · keyword assertion",
    state: "degraded",
    uptime: "99.4%",
    latency: "410 ms",
    spark: SPARK_B,
    segments: strip("up", [
      { at: 18, state: "degraded" },
      { at: 19, state: "degraded" },
    ]),
  },
  {
    name: "staging.acme.dev",
    type: "HTTP · business hours",
    state: "scheduled_off",
    uptime: "—",
    latency: "off-hours",
    spark: SPARK_C,
    segments: strip("up", [
      { at: 5, state: "scheduled_off" },
      { at: 6, state: "scheduled_off" },
      { at: 7, state: "scheduled_off" },
      { at: 8, state: "scheduled_off" },
      { at: 20, state: "scheduled_off" },
      { at: 21, state: "scheduled_off" },
      { at: 22, state: "scheduled_off" },
    ]),
  },
];

export function DashboardMockup() {
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface shadow-2xl shadow-black/40">
      {/* Faux window chrome */}
      <div className="flex items-center gap-2 border-b border-line bg-surface-2/60 px-4 py-2.5">
        <span className="size-2.5 rounded-full bg-down/70" />
        <span className="size-2.5 rounded-full bg-degraded/70" />
        <span className="size-2.5 rounded-full bg-up/70" />
        <span className="ml-3 truncate text-xs text-ink-faint">
          openping.your-account.workers.dev
        </span>
      </div>

      <div className="p-4 sm:p-5">
        {/* Heading row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="size-4 text-accent" />
            <span className="text-sm font-semibold tracking-tight text-ink">
              Overview
            </span>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-up/30 bg-up/10 px-2.5 py-1 text-xs font-medium text-up">
            <span className="size-1.5 rounded-full bg-up" />
            Operational
          </span>
        </div>

        {/* Stat tiles */}
        <div className="mt-4 grid grid-cols-4 gap-2.5">
          {[
            { label: "Up", value: "11", cls: "text-up" },
            { label: "Degraded", value: "1", cls: "text-degraded" },
            { label: "Off-hours", value: "2", cls: "text-scheduled" },
            { label: "Incidents", value: "0", cls: "text-ink" },
          ].map((s) => (
            <div
              key={s.label}
              className="rounded-lg border border-line bg-surface-2/50 px-2.5 py-2"
            >
              <div className="text-[10px] font-medium uppercase tracking-wide text-ink-faint">
                {s.label}
              </div>
              <div className={`mt-0.5 text-lg font-semibold ${s.cls}`}>
                {s.value}
              </div>
            </div>
          ))}
        </div>

        {/* Monitor rows */}
        <div className="mt-4 space-y-2.5">
          {ROWS.map((r) => (
            <div
              key={r.name}
              className="rounded-lg border border-line bg-surface-2/40 p-3"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-ink">
                    {r.name}
                  </div>
                  <div className="mt-0.5 text-[11px] text-ink-faint">{r.type}</div>
                </div>
                <StatusPill state={r.state} />
              </div>

              <div className="mt-3 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <UptimeBar segments={r.segments} />
                </div>
                <Sparkline
                  points={r.spark}
                  width={64}
                  height={26}
                  className="hidden shrink-0 text-accent/80 sm:block"
                />
              </div>

              <div className="mt-2 flex items-center justify-between text-[11px] text-ink-muted">
                <span>24h uptime {r.uptime}</span>
                <span className="text-ink-faint">{r.latency}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Footer status bar */}
      <div className="flex items-center justify-between border-t border-line bg-surface-2/60 px-4 py-2 text-[11px] text-ink-faint">
        <span className="inline-flex items-center gap-1.5">
          <Clock className="size-3.5" />
          Checked 38s ago
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Bell className="size-3.5" />
          Email · Discord · Web Push
        </span>
      </div>
    </div>
  );
}
