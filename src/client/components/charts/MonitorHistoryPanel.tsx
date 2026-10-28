import { Info } from "lucide-react";
import { Card, CardHeader, CardTitle } from "../ui/Card";
import { Skeleton } from "../ui/Skeleton";
import { cn } from "../../lib/cn";
import { formatDuration, formatMs, formatPct } from "../../lib/format";
import {
  DAY_MS,
  RANGE_SPEC,
  type MonitorHistoryResponse,
  type TimeRange,
} from "../../../shared/time-range";
import { ResponseChart } from "./ResponseChart";
import { StatusStrip, StripLegend } from "./StatusStrip";
import { offHourBands, outlierThreshold } from "./chart-math";

export type UptimeWindows = { d1: number; d7: number; d30: number; d90?: number; d365: number };
export interface WindowDowntime {
  downtimeSeconds: number;
  suspendedSeconds: number;
  suspensions: number;
}
export type DowntimeWindows = Partial<Record<keyof UptimeWindows, WindowDowntime>>;

const WINDOWS: { key: keyof UptimeWindows; label: string; adjective: string; range?: TimeRange }[] = [
  { key: "d1", label: "24 hours", adjective: "24-hour", range: "24h" },
  { key: "d7", label: "7 days", adjective: "7-day", range: "7d" },
  { key: "d30", label: "30 days", adjective: "30-day", range: "30d" },
  { key: "d90", label: "90 days", adjective: "90-day", range: "90d" },
  { key: "d365", label: "365 days", adjective: "365-day" },
];

/** True when suspensions are most of a window's downtime. */
function mostlySuspended(d: WindowDowntime | undefined): boolean {
  return !!d && d.downtimeSeconds > 0 && d.suspendedSeconds / d.downtimeSeconds >= 0.5;
}

/**
 * Tint an uptime percentage by health. When the host suspending the app is
 * most of the downtime, use the suspended colour instead of outage red: the
 * figure is low for a reason the note under it explains.
 */
function uptimeClass(pct: number | null | undefined, d?: WindowDowntime): string {
  if (pct == null) return "text-ink-faint";
  if (pct >= 99.9) return "text-up";
  if (pct >= 98) return "text-ink";
  if (mostlySuspended(d)) return "text-suspended";
  if (pct >= 95) return "text-degraded";
  return "text-down";
}

/** Availability over the chosen range, plus the fixed uptime windows. */
export function AvailabilityCard({
  history: h,
  range,
  uptime,
  downtime,
  monitorName,
}: {
  history: MonitorHistoryResponse | null;
  range: TimeRange;
  uptime: UptimeWindows;
  downtime: DowntimeWindows | undefined;
  monitorName: string;
}) {
  const stale = h != null && h.range !== range;
  // The longest window whose low figure suspensions explain, for the note.
  const explained = [...WINDOWS]
    .reverse()
    .find((w) => (uptime[w.key] ?? 100) < 99.5 && mostlySuspended(downtime?.[w.key]));
  const explainedDowntime = explained ? downtime?.[explained.key] : undefined;

  return (
    <Card className="animate-enter p-5">
      <CardHeader>
        <CardTitle>Availability</CardTitle>
        <span className="text-xs text-ink-faint">{RANGE_SPEC[range].long}</span>
      </CardHeader>

      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className={cn("transition-opacity duration-(--duration-base)", stale && "opacity-50")}>
          {h ? (
            <>
              <div className={cn("text-3xl font-semibold tabular-nums tracking-tight", uptimeClass(h.uptimePct, h))}>
                {h.uptimePct != null ? formatPct(h.uptimePct) : "No checks"}
              </div>
              <div className="mt-1 text-xs text-ink-muted">
                {h.checks.toLocaleString()} check{h.checks === 1 ? "" : "s"}
                {" · "}
                {h.downtimeSeconds > 0 ? `${formatDuration(h.downtimeSeconds)} down` : "no downtime"}
                {h.offSeconds > 0 && ` · ${formatDuration(h.offSeconds)} off-hours`}
              </div>
            </>
          ) : (
            <>
              <Skeleton className="h-9 w-36" />
              <Skeleton className="mt-2 h-3 w-48" />
            </>
          )}
        </div>

        <dl className="grid grid-cols-3 gap-x-5 gap-y-3 sm:grid-cols-5">
          {WINDOWS.map((w) => {
            const pct = uptime[w.key];
            const selected = w.range === range;
            return (
              <div key={w.key} className="min-w-0">
                <dt className={cn("text-xs", selected ? "font-medium text-accent" : "text-ink-muted")}>{w.label}</dt>
                <dd
                  className={cn(
                    "mt-0.5 text-sm font-semibold tabular-nums",
                    pct != null ? uptimeClass(pct, downtime?.[w.key]) : "text-ink-faint",
                  )}
                >
                  {pct != null ? formatPct(pct) : "-"}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>

      <div className="mt-5">
        {h ? (
          <div key={h.range} className={cn("animate-fade transition-opacity duration-(--duration-base)", stale && "opacity-50")}>
            <StatusStrip
              buckets={h.buckets}
              bucketMs={h.bucketMs}
              label={`${monitorName} availability, ${RANGE_SPEC[h.range].long.toLowerCase()}`}
              size="lg"
              minSegmentPx={h.range === "24h" ? 10 : 4}
            />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <StripLegend states={h.buckets.map((b) => b.state)} />
              <span className="text-xs text-ink-faint">
                {h.bucketMs >= DAY_MS ? "One bar per day (UTC)" : "One bar per hour"}
              </span>
            </div>
          </div>
        ) : (
          <>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="mt-2 h-3 w-40" />
          </>
        )}
      </div>

      {explained && explainedDowntime && (
        <p className="mt-4 flex gap-2 rounded-lg border border-suspended/30 bg-suspended/[0.07] px-3 py-2 text-xs leading-relaxed text-ink-muted">
          <Info className="mt-0.5 size-3.5 shrink-0 text-suspended" aria-hidden="true" />
          <span>
            The {explained.adjective} uptime is pulled down by the host suspending the app:{" "}
            {explainedDowntime.suspensions} suspension{explainedDowntime.suspensions === 1 ? "" : "s"} totalling{" "}
            {formatDuration(explainedDowntime.suspendedSeconds)}, which is{" "}
            {Math.round((explainedDowntime.suspendedSeconds / explainedDowntime.downtimeSeconds) * 100)}% of its
            downtime. Off-hours never count against uptime.
          </span>
        </p>
      )}
    </Card>
  );
}

/** Response time over the chosen range, with median and p95 and outliers marked. */
export function ResponseCard({
  history: h,
  range,
  intervalSeconds,
  monitorName,
}: {
  history: MonitorHistoryResponse | null;
  range: TimeRange;
  intervalSeconds: number;
  monitorName: string;
}) {
  const stale = h != null && h.range !== range;
  const threshold = h ? outlierThreshold(h.points.map((p) => p.ms)) : Infinity;
  const outliers = h ? h.points.filter((p) => p.ms > threshold).length : 0;
  const perCheck = h?.range === "24h";
  const basis =
    h?.latency.basis === "checks"
      ? "of every successful check"
      : h
        ? `of ${h.latency.basis} averages`
        : "";

  return (
    <Card className="animate-enter p-5">
      <CardHeader>
        <CardTitle>Response time</CardTitle>
        <span className="text-xs text-ink-faint">{RANGE_SPEC[range].long}</span>
      </CardHeader>

      {!h ? (
        <div aria-hidden="true">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i}>
                <Skeleton className="h-3 w-14" />
                <Skeleton className="mt-2 h-6 w-20" />
              </div>
            ))}
          </div>
          <Skeleton className="mt-5 h-[200px] w-full" />
        </div>
      ) : (
        <div className={cn("transition-opacity duration-(--duration-base)", stale && "opacity-50")}>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <ResponseStat label="Median" value={formatMs(h.latency.median)} />
            <ResponseStat label="p95" value={formatMs(h.latency.p95)} />
            <ResponseStat
              label="Average"
              value={formatMs(h.latency.avg)}
              hint={
                h.latency.avg != null && h.latency.median != null && h.latency.avg > h.latency.median * 1.5
                  ? "raised by outliers"
                  : undefined
              }
            />
            <ResponseStat
              label="Max"
              value={formatMs(h.latency.max)}
              valueClass={outliers > 0 ? "text-degraded" : undefined}
              hint={h.latency.min != null ? `min ${formatMs(h.latency.min)}` : undefined}
            />
          </dl>
          <p className="mt-2 text-xs text-ink-faint">
            {h.latency.count > 0
              ? `Median and p95 ${basis} (${h.latency.count.toLocaleString()}).`
              : "No successful checks in this range."}
          </p>

          <div key={h.range} className="mt-4 animate-fade border-t border-line pt-4">
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-xs font-medium text-ink-muted">
                {perCheck ? "Every successful check" : `Average per ${h.bucketMs >= DAY_MS ? "day" : "hour"}`}
              </span>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
                {h.latency.median != null && (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-3.5 border-t border-dashed border-up/70" aria-hidden="true" />
                    Median
                  </span>
                )}
                {outliers > 0 && (
                  <span className="inline-flex items-center gap-1.5">
                    <svg viewBox="0 0 10 7" className="h-[7px] w-2.5" aria-hidden="true">
                      <path d="M0 0H10L5 7Z" fill="var(--color-degraded)" />
                    </svg>
                    Outlier, capped
                  </span>
                )}
                {h.offSeconds > 0 && (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-[2px] bg-scheduled/30" aria-hidden="true" />
                    Off-hours
                  </span>
                )}
              </span>
            </div>
            {h.points.length > 0 ? (
              <ResponseChart
                points={h.points}
                from={h.from}
                to={h.to}
                bucketMs={h.bucketMs}
                kind={perCheck ? "check" : "bucket"}
                gapMs={perCheck ? Math.max(intervalSeconds * 1000 * 2.5, 30 * 60_000) : h.bucketMs * 1.5}
                bands={offHourBands(h.buckets, h.bucketMs)}
                median={h.latency.median}
                label={`${monitorName} response time, ${RANGE_SPEC[h.range].long.toLowerCase()}`}
                height={200}
              />
            ) : (
              <p className="py-10 text-center text-sm text-ink-muted">No response times in this range.</p>
            )}
            {outliers > 0 && (
              <p className="mt-3 text-xs text-ink-faint">
                {outliers} {perCheck ? "check" : h.bucketMs >= DAY_MS ? "day" : "hour"}
                {outliers === 1 ? " was" : "s were"} far slower than the rest (cold starts, typically). They are
                capped at the top of the chart and left out of its scale, so the rest stays readable; hover a
                marker for the exact time.
              </p>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function ResponseStat({
  label,
  value,
  hint,
  valueClass,
}: {
  label: string;
  value: string;
  hint?: string;
  valueClass?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-ink-muted">{label}</dt>
      <dd
        className={cn(
          "mt-1 truncate font-semibold tabular-nums tracking-tight text-ink",
          "text-xl",
          valueClass,
        )}
      >
        {value}
      </dd>
      {hint && <dd className="mt-0.5 truncate text-xs text-ink-faint">{hint}</dd>}
    </div>
  );
}
