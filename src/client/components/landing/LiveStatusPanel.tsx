import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Activity, ArrowRight, Clock } from "lucide-react";
import { StatusPill } from "../ui/StatusPill";
import { UptimeBar } from "../ui/UptimeBar";
import type { MonitorState } from "../../../shared/states";
import { DashboardMockup } from "./DashboardMockup";

/*
 * The hero's product shot, live: this install's own public status feed
 * (GET /api/public/status, the same redacted payload the status page and the
 * embed widget read), so a visitor sees real monitors, real uptime bars and the
 * real "Scheduled off" state instead of a mockup. Every self-hosted install
 * shows its own public monitors. If the feed is off, empty or unreachable, it
 * falls back to the illustrative DashboardMockup, so the hero never breaks.
 */

type PublicState =
  | "operational"
  | "degraded"
  | "down"
  | "suspended"
  | "maintenance"
  | "scheduled_off"
  | "unknown";

interface FeedBar {
  date: string;
  uptimePct: number | null;
  state: "up" | "degraded" | "down" | "none";
}

interface FeedService {
  id: string;
  name: string;
  state: PublicState;
  showUptime: boolean;
  uptime90d: number | null;
  bars: FeedBar[];
}

interface Feed {
  enabled: boolean;
  overall: string;
  updatedAt: number;
  groups: { name: string | null; services: FeedService[] }[];
}

const PILL: Record<PublicState, { state: MonitorState; label: string }> = {
  operational: { state: "up", label: "Up" },
  degraded: { state: "degraded", label: "Degraded" },
  down: { state: "down", label: "Down" },
  suspended: { state: "suspended", label: "Suspended" },
  maintenance: { state: "maintenance", label: "Maintenance" },
  scheduled_off: { state: "scheduled_off", label: "Scheduled off" },
  unknown: { state: "unknown", label: "Unknown" },
};

// A day with no checks (the app was scheduled off all day) reads as grey, not red.
const BAR_STATE: Record<FeedBar["state"], MonitorState> = {
  up: "up",
  degraded: "degraded",
  down: "down",
  none: "scheduled_off",
};

const OVERALL: Record<string, { label: string; cls: string }> = {
  operational: { label: "All systems operational", cls: "border-up/30 bg-up/10 text-up" },
  degraded: { label: "Degraded", cls: "border-degraded/30 bg-degraded/10 text-degraded" },
  partial_outage: { label: "Partial outage", cls: "border-down/30 bg-down/10 text-down" },
  major_outage: { label: "Major outage", cls: "border-down/30 bg-down/10 text-down" },
  maintenance: { label: "Maintenance", cls: "border-maint/30 bg-maint/10 text-maint" },
  all_off: { label: "All scheduled off", cls: "border-scheduled/30 bg-scheduled/10 text-scheduled" },
};

const MAX_ROWS = 4;
const DAYS = 30;
// Checks run every 12 minutes; older than this, the feed is resting (off-hours).
const FRESH_MS = 30 * 60_000;

function minutesAgo(ts: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  if (mins < 1) return "Last check just now";
  if (mins === 1) return "Last check 1 minute ago";
  if (mins < 120) return `Last check ${mins} minutes ago`;
  return `Last check ${Math.round(mins / 60)} hours ago`;
}

export function LiveStatusPanel() {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/public/status", { signal: ctrl.signal, headers: { accept: "application/json" } })
      .then((r) => (r.ok ? (r.json() as Promise<Feed>) : Promise.reject(new Error(String(r.status)))))
      .then((data) => setFeed(data))
      .catch((err: unknown) => {
        if ((err as { name?: string })?.name !== "AbortError") setFailed(true);
      });
    return () => ctrl.abort();
  }, []);

  const services = (feed?.groups ?? []).flatMap((g) => g.services).slice(0, MAX_ROWS);
  if (failed || (feed && (!feed.enabled || services.length === 0))) return <DashboardMockup />;

  const overall = feed ? (OVERALL[feed.overall] ?? OVERALL.operational) : null;
  const fresh = !!feed && Date.now() - feed.updatedAt < FRESH_MS;

  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface shadow-2xl shadow-black/40">
      <div className="flex items-center gap-2 border-b border-line bg-surface-2/60 px-4 py-2.5">
        <span className="size-2.5 rounded-full bg-down/70" />
        <span className="size-2.5 rounded-full bg-degraded/70" />
        <span className="size-2.5 rounded-full bg-up/70" />
        <span className="ml-3 truncate text-xs text-ink-faint">
          {typeof window !== "undefined" ? window.location.host : ""}/status
        </span>
      </div>

      <div className="p-4 sm:p-5" aria-busy={!feed}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Activity className="size-4 text-accent" />
            <span className="text-sm font-semibold tracking-tight text-ink">{fresh ? "Watching right now" : "This OpenPing's monitors"}</span>
            {fresh && (
              <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-accent">
                <span className="op-live-dot size-1.5 rounded-full bg-accent" />
                Live
              </span>
            )}
          </div>
          {overall && (
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${overall.cls}`}>
              <span className="size-1.5 rounded-full bg-current" />
              {overall.label}
            </span>
          )}
        </div>

        <ul className="mt-4 space-y-2.5">
          {feed
            ? services.map((s) => {
                const pill = PILL[s.state] ?? PILL.unknown;
                const bars = s.bars.slice(-DAYS).map((b) => ({
                  state: BAR_STATE[b.state],
                  title: `${b.date}: ${b.uptimePct === null ? "no checks (scheduled off)" : `${b.uptimePct}% up`}`,
                }));
                return (
                  <li key={s.id} className="rounded-lg border border-line bg-surface-2/40 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-sm font-medium text-ink">{s.name}</span>
                      <StatusPill state={pill.state} label={pill.label} />
                    </div>
                    <div className="mt-3">
                      <UptimeBar segments={bars} />
                    </div>
                    <div className="mt-2 flex items-center justify-between text-[11px] text-ink-muted">
                      <span>Last {DAYS} days</span>
                      {s.showUptime && s.uptime90d !== null && (
                        <span className="tabular-nums">{s.uptime90d.toFixed(2)}% over 90 days</span>
                      )}
                    </div>
                  </li>
                );
              })
            : Array.from({ length: 3 }, (_, i) => (
                <li key={i} className="h-[92px] animate-pulse rounded-lg border border-line bg-surface-2/40 motion-reduce:animate-none" />
              ))}
        </ul>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-line bg-surface-2/60 px-4 py-2 text-[11px] text-ink-faint">
        <span className="inline-flex items-center gap-1.5">
          <Clock className="size-3.5" />
          {feed ? minutesAgo(feed.updatedAt) : "Loading the live feed"}
        </span>
        <Link to="/status" className="inline-flex items-center gap-1 font-medium text-accent hover:text-accent-hover">
          Open the status page
          <ArrowRight className="size-3.5" />
        </Link>
      </div>
    </div>
  );
}
