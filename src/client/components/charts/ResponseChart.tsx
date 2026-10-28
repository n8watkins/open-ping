import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "../../lib/cn";
import { formatMs, formatShortDateTime } from "../../lib/format";
import { DAY_MS, HOUR_MS } from "../../../shared/time-range";
import { ChartTooltip } from "./ChartTooltip";
import {
  axisLabel,
  bucketLabel,
  formatAxisMs,
  niceCeil,
  outlierThreshold,
  niceTicks,
} from "./chart-math";
import { useElementWidth } from "./useElementWidth";

export interface ChartPoint {
  t: number;
  ms: number;
}

const PAD = { top: 10, right: 8, bottom: 22, left: 46 };

/**
 * Response time over a range, drawn in real pixels so the text stays crisp.
 * Off-hours spans are shaded neutral gray, the line breaks across gaps, and
 * outliers (a cold start, say) are capped at the top edge with a marker so
 * one slow check cannot flatten the rest of the chart. Hover or focus it for
 * exact values; arrow keys step through the points.
 */
export function ResponseChart({
  points,
  from,
  to,
  bucketMs,
  kind,
  gapMs,
  bands = [],
  height = 168,
  label,
  median,
  className,
}: {
  points: ChartPoint[];
  from: number;
  to: number;
  bucketMs: number;
  /** "check": one point per check at its time; "bucket": one average per bucket (at its start). */
  kind: "check" | "bucket";
  /** Break the line where two points are further apart than this. */
  gapMs: number;
  bands?: { start: number; end: number }[];
  height?: number;
  label: string;
  /** Draws a dashed median line when given. */
  median?: number | null;
  className?: string;
}) {
  const gradientId = useId();
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);

  const model = useMemo(() => {
    const threshold = outlierThreshold(points.map((p) => p.ms));
    const inScale = points.filter((p) => p.ms <= threshold).map((p) => p.ms);
    const yMax = niceCeil(Math.max(1, ...inScale) * 1.1);
    const innerW = Math.max(0, width - PAD.left - PAD.right);
    const innerH = height - PAD.top - PAD.bottom;
    // A bucket average sits in the middle of its bucket.
    const at = (p: ChartPoint) => (kind === "bucket" ? p.t + bucketMs / 2 : p.t);
    const x = (t: number) => PAD.left + ((t - from) / Math.max(1, to - from)) * innerW;
    const y = (ms: number) => PAD.top + innerH - (Math.min(ms, yMax) / yMax) * innerH;

    const coords = points.map((p) => ({
      ...p,
      x: x(at(p)),
      y: y(p.ms),
      outlier: p.ms > threshold,
    }));

    // Split into runs wherever a gap (off-hours, an outage, missing data) is too wide.
    const runs: (typeof coords)[] = [];
    for (let i = 0; i < coords.length; i++) {
      const prev = points[i - 1];
      if (i === 0 || !prev || points[i]!.t - prev.t > gapMs) runs.push([]);
      runs.at(-1)!.push(coords[i]!);
    }
    const base = PAD.top + innerH;
    const line = runs
      .map((run) =>
        run.length === 1
          ? `M${run[0]!.x - 1.5},${run[0]!.y}h3`
          : run.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(""),
      )
      .join("");
    const area = runs
      .filter((run) => run.length > 1)
      .map(
        (run) =>
          `M${run[0]!.x.toFixed(1)},${base}` +
          run.map((c) => `L${c.x.toFixed(1)},${c.y.toFixed(1)}`).join("") +
          `L${run.at(-1)!.x.toFixed(1)},${base}Z`,
      )
      .join("");

    return {
      threshold,
      yMax,
      innerW,
      innerH,
      x,
      y,
      coords,
      line,
      area,
      base,
      outliers: coords.filter((c) => c.outlier).length,
      xTicks: fitTicks(from, to, bucketMs, innerW, x),
    };
  }, [points, width, height, from, to, bucketMs, kind, gapMs]);

  const active = hover ?? focusIndex;
  const focusPoint = focusIndex != null && hover == null;
  const activePoint = active != null ? model.coords[active] : undefined;

  function nearest(px: number): number | null {
    if (model.coords.length === 0) return null;
    let best = 0;
    let bestD = Infinity;
    model.coords.forEach((c, i) => {
      const d = Math.abs(c.x - px);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    setHover(nearest(e.clientX - rect.left));
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const last = model.coords.length - 1;
    if (last < 0) return;
    const cur = focusIndex ?? last;
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = Math.max(0, cur - 1);
    else if (e.key === "ArrowRight") next = Math.min(last, cur + 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else if (e.key === "Escape") return setFocusIndex(null);
    if (next != null) {
      e.preventDefault();
      // The keyboard takes over from wherever the pointer last rested.
      setHover(null);
      setFocusIndex(next);
    }
  }

  const when = (p: ChartPoint) =>
    kind === "bucket" ? bucketLabel(p.t, bucketMs) : formatShortDateTime(p.t);

  return (
    <div className={cn("relative", className)}>
      <div
        ref={ref}
        tabIndex={points.length > 0 ? 0 : -1}
        role="group"
        aria-roledescription="chart"
        aria-label={`${label}. ${points.length} values${
          model.outliers > 0 ? `, ${model.outliers} far above the rest and capped at the top` : ""
        }. Use the arrow keys to read each value.`}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(null)}
        onFocus={() => setFocusIndex((i) => i ?? model.coords.length - 1)}
        onBlur={() => setFocusIndex(null)}
        onKeyDown={onKeyDown}
        className="rounded-md focus-visible:outline-offset-4"
        style={{ height }}
      >
        {width > 0 && (
          <svg width={width} height={height} className="block overflow-visible" aria-hidden="true">
            <defs>
              <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.28" />
                <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
              </linearGradient>
            </defs>

            {/* Off-hours: neutral shading, never downtime. */}
            {bands.map((b) => {
              const x1 = Math.max(PAD.left, model.x(b.start));
              const x2 = Math.min(PAD.left + model.innerW, model.x(b.end));
              return x2 > x1 ? (
                <rect
                  key={b.start}
                  x={x1}
                  y={PAD.top}
                  width={x2 - x1}
                  height={model.innerH}
                  fill="var(--color-scheduled)"
                  opacity={0.07}
                />
              ) : null;
            })}

            {niceTicks(model.yMax).map((v) => (
              <g key={v}>
                <line
                  x1={PAD.left}
                  x2={PAD.left + model.innerW}
                  y1={model.y(v)}
                  y2={model.y(v)}
                  stroke="var(--color-line)"
                  strokeDasharray={v === 0 ? undefined : "2 4"}
                />
                <text
                  x={PAD.left - 8}
                  y={model.y(v)}
                  dy="0.32em"
                  textAnchor="end"
                  className="fill-ink-faint text-[10px] tabular-nums"
                >
                  {formatAxisMs(v)}
                </text>
              </g>
            ))}

            {model.xTicks.map((t) => (
              <text
                key={t}
                x={model.x(t)}
                y={height - 6}
                textAnchor="middle"
                className="fill-ink-faint text-[10px]"
              >
                {axisLabel(t, bucketMs, to - from)}
              </text>
            ))}

            <g key={`${from}-${points.length}`} className="animate-fade">
              <path d={model.area} fill={`url(#${gradientId})`} />
              <path
                d={model.line}
                fill="none"
                stroke="var(--color-accent)"
                strokeWidth={1.75}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {median != null && median <= model.yMax && (
                <line
                  x1={PAD.left}
                  x2={PAD.left + model.innerW}
                  y1={model.y(median)}
                  y2={model.y(median)}
                  stroke="var(--color-up)"
                  strokeOpacity={0.55}
                  strokeDasharray="4 4"
                />
              )}
              {/* Outliers: a marker on the top edge where the value went off the scale. */}
              {model.coords
                .filter((c) => c.outlier)
                .map((c) => (
                  <path
                    key={c.t}
                    d={`M${c.x - 4.5},${PAD.top - 1}L${c.x + 4.5},${PAD.top - 1}L${c.x},${PAD.top + 6}Z`}
                    fill="var(--color-degraded)"
                  />
                ))}
            </g>

            {activePoint && (
              <g>
                <line
                  x1={activePoint.x}
                  x2={activePoint.x}
                  y1={PAD.top}
                  y2={model.base}
                  stroke="var(--color-ink-faint)"
                  strokeOpacity={0.5}
                />
                <circle
                  cx={activePoint.x}
                  cy={activePoint.y}
                  r={4}
                  fill="var(--color-canvas)"
                  stroke={activePoint.outlier ? "var(--color-degraded)" : "var(--color-accent)"}
                  strokeWidth={2}
                />
              </g>
            )}
          </svg>
        )}
      </div>
      {activePoint && (
        <div className="pointer-events-none absolute inset-x-0" style={{ top: Math.max(0, activePoint.y - 4) }}>
          <ChartTooltip x={activePoint.x} width={width}>
            <div className="font-medium text-ink">{when(activePoint)}</div>
            <div className="mt-1 tabular-nums">
              <span className={cn("font-semibold", activePoint.outlier ? "text-degraded" : "text-ink")}>
                {formatMs(activePoint.ms)}
              </span>
              {kind === "bucket" ? " average" : " response"}
            </div>
            {activePoint.outlier && (
              <div className="mt-0.5 text-degraded">Far above the rest (a cold start?), capped on the chart</div>
            )}
          </ChartTooltip>
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {focusPoint && activePoint ? `${when(activePoint)}: ${formatMs(activePoint.ms)}` : ""}
      </span>
    </div>
  );
}

const STEPS = [HOUR_MS, 2 * HOUR_MS, 3 * HOUR_MS, 6 * HOUR_MS, 12 * HOUR_MS, DAY_MS, 2 * DAY_MS, 3 * DAY_MS, 7 * DAY_MS, 14 * DAY_MS, 30 * DAY_MS];

/**
 * Round tick times across [from, to]: whole hours or local midnights for hour
 * grids, UTC midnights for day grids (which are UTC days).
 */
function timeTicks(from: number, to: number, bucketMs: number, maxTicks: number): number[] {
  const span = to - from;
  // Beyond two days the labels name days, so ticks must be whole days apart.
  const allowed = span > 2 * DAY_MS ? STEPS.filter((s) => s >= DAY_MS) : STEPS;
  const step = allowed.find((s) => span / s <= maxTicks) ?? allowed.at(-1)!;
  const out: number[] = [];
  let t: number;
  if (bucketMs >= DAY_MS) {
    t = Math.ceil(from / step) * step;
  } else if (step < DAY_MS) {
    // Whole local hours: 12 AM, 6 AM, noon... in the viewer's time zone.
    const offset = -new Date(from).getTimezoneOffset() * 60_000;
    t = Math.ceil((from + offset) / step) * step - offset;
  } else {
    const d = new Date(from);
    d.setHours(24, 0, 0, 0);
    t = d.getTime();
  }
  for (; t <= to; t += step) out.push(t);
  return out;
}

/** Rough width of an axis label in px (10px tabular text), on the safe side. */
const LABEL_CHAR_PX = 6.2;
const LABEL_GAP_PX = 14;

/**
 * Axis ticks that fit the drawn width: the step is chosen from the widest
 * label, then any label that would overlap the one before it or run past the
 * plot's edges is dropped, so labels never collide at any width.
 */
function fitTicks(
  from: number,
  to: number,
  bucketMs: number,
  innerW: number,
  x: (t: number) => number,
): number[] {
  if (innerW <= 0) return [];
  const span = to - from;
  const sample = axisLabel(from, bucketMs, span);
  const labelW = Math.max(sample.length, 6) * LABEL_CHAR_PX;
  const spacing = labelW + LABEL_GAP_PX;
  const maxTicks = Math.max(2, Math.floor(innerW / spacing));
  const left = PAD.left + labelW / 2 - 4;
  const right = PAD.left + innerW - labelW / 2;
  const out: number[] = [];
  let lastX = -Infinity;
  for (const t of timeTicks(from, to, bucketMs, maxTicks)) {
    const px = x(t);
    const w = axisLabel(t, bucketMs, span).length * LABEL_CHAR_PX;
    if (px < left || px > right) continue;
    if (px - lastX < Math.max(spacing, w + LABEL_GAP_PX)) continue;
    out.push(t);
    lastX = px;
  }
  return out;
}
