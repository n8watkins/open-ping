import { cn } from "../../lib/cn";
import type { MonitorState } from "../../../shared/states";

// Explicit token -> class map (no dynamic interpolation) so Tailwind keeps them.
const SEGMENT: Record<MonitorState, string> = {
  up: "bg-up",
  down: "bg-down",
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

  return (
    <div className="flex h-7 items-stretch gap-px">
      {segments.map((segment, i) => (
        <div
          key={i}
          title={segment.title}
          className={cn(
            "flex-1 rounded-[2px] first:rounded-l-md last:rounded-r-md",
            SEGMENT[segment.state],
          )}
        />
      ))}
    </div>
  );
}
