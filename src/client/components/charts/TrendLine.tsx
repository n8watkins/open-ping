import { useId } from "react";
import { cn } from "../../lib/cn";
import { outlierThreshold } from "./chart-math";

/**
 * A tiny response-time trend for cards: one value per bucket, null where there
 * was nothing to measure. Empty buckets (off-hours, say) are skipped, so the
 * line runs through the measured ones without breaking into fragments.
 * Outliers are capped so a single cold start does not flatten the line.
 * Decorative: the card states the numbers in text.
 */
export function TrendLine({
  values: raw,
  height = 32,
  className,
}: {
  values: (number | null)[];
  height?: number;
  className?: string;
}) {
  const gradientId = useId();
  const values = raw.filter((v): v is number => v != null);
  const present = values;
  if (present.length < 2) return <div className={cn("w-full", className)} style={{ height }} aria-hidden="true" />;

  const W = 100;
  const threshold = outlierThreshold(present);
  const inScale = present.filter((v) => v <= threshold);
  const max = Math.max(...inScale) * 1.08;
  const min = Math.min(...inScale) * 0.92;
  const span = Math.max(1, max - min);
  const n = values.length;
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * W : W / 2);
  const y = (v: number) => height - 2 - ((Math.min(v, max) - min) / span) * (height - 4);

  let line = "";
  let area = "";
  let run: [number, number][] = [];
  const flush = () => {
    if (run.length === 1) {
      line += `M${run[0]![0] - 0.4},${run[0]![1]}h0.8`;
    } else if (run.length > 1) {
      line += run.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(2)},${py.toFixed(2)}`).join("");
      area += `M${run[0]![0].toFixed(2)},${height}` + run.map(([px, py]) => `L${px.toFixed(2)},${py.toFixed(2)}`).join("") + `L${run.at(-1)![0].toFixed(2)},${height}Z`;
    }
    run = [];
  };
  values.forEach((v, i) => run.push([x(i), y(v)]));
  flush();

  return (
    <svg
      viewBox={`0 0 ${W} ${height}`}
      preserveAspectRatio="none"
      className={cn("block w-full overflow-visible text-accent", className)}
      style={{ height }}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
