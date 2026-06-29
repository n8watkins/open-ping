import { cn } from "../../lib/cn";

/**
 * Tiny inline SVG line chart. Scales the polyline to the min/max of `points`
 * and strokes it with `currentColor` (text-accent). 0 points render nothing;
 * a single point renders a flat baseline.
 */
export function Sparkline({
  points,
  width = 100,
  height = 28,
  className,
}: {
  points: number[];
  width?: number;
  height?: number;
  className?: string;
}) {
  if (points.length === 0) return null;

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min;
  const n = points.length;

  const coords = points.map((value, i) => {
    const x = n > 1 ? (i / (n - 1)) * width : width / 2;
    const y = span === 0 ? height / 2 : height - ((value - min) / span) * height;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  // A single coordinate won't draw, so stretch a flat baseline across instead.
  const polyPoints =
    coords.length === 1
      ? `0,${(height / 2).toFixed(2)} ${width.toFixed(2)},${(height / 2).toFixed(2)}`
      : coords.join(" ");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      fill="none"
      preserveAspectRatio="none"
      aria-hidden="true"
      className={cn("text-accent", className)}
    >
      <polyline
        points={polyPoints}
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
