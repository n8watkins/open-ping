import { useMemo, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { formatMs, formatPct } from "../../lib/format";
import { DAY_MS, type BucketState } from "../../../shared/time-range";
import { ChartTooltip } from "./ChartTooltip";
import { bucketLabel, mergeBuckets, type MergedBucket, type StripBucket } from "./chart-math";
import { BUCKET_FILL, BUCKET_LABEL } from "./state-style";
import { useElementWidth } from "./useElementWidth";

/**
 * A history strip: one segment per hour or day, coloured by what happened.
 * Hover or focus it (then use the arrow keys) for the exact time, state,
 * uptime and response time of each segment. When the strip is too narrow for
 * one segment per bucket, neighbouring buckets merge (worst state wins).
 */
export function StatusStrip({
  buckets,
  bucketMs,
  label,
  minSegmentPx = 4,
  size = "md",
  extra,
  className,
}: {
  buckets: StripBucket[];
  bucketMs: number;
  /** What the strip shows, for screen readers ("Echo, last 7 days"). */
  label: string;
  minSegmentPx?: number;
  size?: "sm" | "md" | "lg";
  /** Extra tooltip lines for a segment. */
  extra?: (b: MergedBucket) => ReactNode;
  className?: string;
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);

  const merged = useMemo(() => {
    const fit = width > 0 ? Math.max(1, Math.floor(width / minSegmentPx)) : buckets.length;
    return mergeBuckets(buckets, Math.ceil(buckets.length / fit));
  }, [buckets, width, minSegmentPx]);

  const active = hover ?? focusIndex;
  const focusPoint = focusIndex != null && hover == null;
  const activeBucket = active != null ? merged[active] : undefined;
  const segW = merged.length > 0 ? width / merged.length : 0;
  const gap = segW >= 5;

  const summary = useMemo(() => summarize(buckets, bucketMs), [buckets, bucketMs]);

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (merged.length === 0 || width === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - rect.left) / rect.width) * merged.length);
    setHover(Math.min(merged.length - 1, Math.max(0, i)));
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const last = merged.length - 1;
    const cur = focusIndex ?? last;
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = Math.max(0, cur - 1);
    else if (e.key === "ArrowRight") next = Math.min(last, cur + 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else if (e.key === "Escape") {
      setFocusIndex(null);
      return;
    }
    if (next != null) {
      e.preventDefault();
      // The keyboard takes over from wherever the pointer last rested.
      setHover(null);
      setFocusIndex(next);
    }
  }

  if (buckets.length === 0) return null;

  return (
    <div className={cn("relative", className)}>
      <div
        ref={ref}
        tabIndex={0}
        role="group"
        aria-roledescription="history strip"
        aria-label={`${label}: ${summary}. Use the arrow keys to read each segment.`}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(null)}
        onFocus={() => setFocusIndex((i) => i ?? merged.length - 1)}
        onBlur={() => setFocusIndex(null)}
        onKeyDown={onKeyDown}
        className={cn(
          "flex cursor-crosshair items-stretch rounded-md focus-visible:outline-offset-4",
          gap && "gap-px",
          size === "sm" ? "h-5" : size === "lg" ? "h-10" : "h-7",
        )}
      >
        {merged.map((b, i) => (
          <div
            key={b.t}
            aria-hidden="true"
            className={cn(
              "flex-1 transition-opacity duration-(--duration-fast) first:rounded-l-md last:rounded-r-md",
              gap && "rounded-[2px]",
              BUCKET_FILL[b.state],
              active != null && i !== active && "opacity-60",
              i === active && "relative ring-2 ring-ink/80",
            )}
          />
        ))}
      </div>
      {activeBucket && active != null && (
        <ChartTooltip x={(active + 0.5) * segW} width={width}>
          <BucketReadout bucket={activeBucket} bucketMs={bucketMs} extra={extra} />
        </ChartTooltip>
      )}
      <span className="sr-only" aria-live="polite">
        {focusPoint && activeBucket ? describe(activeBucket, bucketMs) : ""}
      </span>
    </div>
  );
}

function BucketReadout({
  bucket: b,
  bucketMs,
  extra,
}: {
  bucket: MergedBucket;
  bucketMs: number;
  extra?: (b: MergedBucket) => ReactNode;
}) {
  return (
    <>
      <div className="font-medium text-ink">{bucketLabel(b.t, bucketMs, b.span)}</div>
      <div className="mt-1 flex items-center gap-1.5">
        <span className={cn("size-2 rounded-full", BUCKET_FILL[b.state])} />
        <span className="text-ink">{BUCKET_LABEL[b.state]}</span>
        {b.uptime != null && <span className="tabular-nums">· {formatPct(b.uptime)} up</span>}
      </div>
      {(b.checks > 0 || b.avgMs != null) && (
        <div className="mt-0.5 tabular-nums">
          {b.checks} check{b.checks === 1 ? "" : "s"}
          {b.avgMs != null && ` · avg ${formatMs(b.avgMs)}`}
        </div>
      )}
      {b.monitors && b.span === 1 && <MonitorCounts counts={b.monitors} />}
      {extra?.(b)}
    </>
  );
}

function MonitorCounts({ counts }: { counts: Partial<Record<BucketState, number>> }) {
  const parts = (Object.keys(counts) as BucketState[])
    .filter((s) => (counts[s] ?? 0) > 0)
    .map((s) => `${counts[s]} ${BUCKET_LABEL[s].toLowerCase()}`);
  if (parts.length === 0) return null;
  return <div className="mt-0.5">Monitors: {parts.join(", ")}</div>;
}

function describe(b: MergedBucket, bucketMs: number): string {
  const parts = [bucketLabel(b.t, bucketMs, b.span), BUCKET_LABEL[b.state]];
  if (b.uptime != null) parts.push(`${formatPct(b.uptime)} up`);
  if (b.avgMs != null) parts.push(`average response ${formatMs(b.avgMs)}`);
  return parts.join(", ");
}

/** "50 hours up, 118 hours off-hours" over the source buckets. */
function summarize(buckets: StripBucket[], bucketMs: number): string {
  const unit = bucketMs >= DAY_MS ? "day" : "hour";
  const counts = new Map<BucketState, number>();
  for (const b of buckets) counts.set(b.state, (counts.get(b.state) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${n} ${unit}${n === 1 ? "" : "s"} ${BUCKET_LABEL[s].toLowerCase()}`)
    .join(", ");
}

/** A small key for the states present in a strip. */
export function StripLegend({ states, className }: { states: BucketState[]; className?: string }) {
  const order: BucketState[] = [
    "up",
    "degraded",
    "down",
    "suspended",
    "maintenance",
    "scheduled_off",
    "paused",
    "cant_check",
    "nodata",
  ];
  const present = order.filter((s) => states.includes(s));
  if (present.length === 0) return null;
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint", className)}>
      {present.map((s) => (
        <li key={s} className="inline-flex items-center gap-1.5">
          <span className={cn("size-2 rounded-[2px]", BUCKET_FILL[s])} aria-hidden="true" />
          {BUCKET_LABEL[s]}
        </li>
      ))}
    </ul>
  );
}
