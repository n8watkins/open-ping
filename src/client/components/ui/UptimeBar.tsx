import { cn } from "../../lib/cn";
import { STATE_META, type MonitorState } from "../../../shared/states";

// Explicit token -> class map (no dynamic interpolation) so Tailwind keeps them.
const SEGMENT: Record<MonitorState, string> = {
  up: "bg-up",
  down: "bg-down",
  suspended: "bg-suspended",
  degraded: "bg-degraded",
  scheduled_off: "bg-scheduled",
  maintenance: "bg-maint",
  paused: "bg-paused",
  warming_up: "bg-warming",
  unknown: "bg-paused",
};

/**
 * Horizontal uptime strip: thin rounded segments, one per check, colored by
 * state and evenly distributed across the available width.
 */
export function UptimeBar({
  segments,
}: {
  segments: { state: MonitorState; title?: string }[];
}) {
  if (segments.length === 0) return null;

  // State conveyed by color alone fails WCAG 1.4.1, so expose a text summary:
  // the strip is one image with an aria-label counting each state.
  const counts = segments.reduce<Partial<Record<MonitorState, number>>>(
    (acc, s) => {
      acc[s.state] = (acc[s.state] ?? 0) + 1;
      return acc;
    },
    {},
  );
  const summary = (Object.keys(counts) as MonitorState[])
    .map((state) => `${counts[state]} ${STATE_META[state].label}`)
    .join(", ");

  return (
    <div
      role="img"
      aria-label={`Recent check history (${segments.length} checks): ${summary}`}
      className="flex h-7 items-stretch gap-px"
    >
      {segments.map((segment, i) => (
        <div
          key={i}
          title={segment.title}
          aria-hidden="true"
          className={cn(
            "flex-1 rounded-[2px] first:rounded-l-md last:rounded-r-md",
            SEGMENT[segment.state],
          )}
        />
      ))}
    </div>
  );
}
