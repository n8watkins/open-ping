import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { STATE_META, type MonitorState } from "../../../shared/states";

// Explicit token -> class maps so Tailwind's static extractor keeps every
// utility (no dynamic `bg-${token}` interpolation).
const DOT: Record<MonitorState, string> = {
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

const TEXT: Record<MonitorState, string> = {
  up: "text-up",
  down: "text-down",
  suspended: "text-suspended",
  degraded: "text-degraded",
  scheduled_off: "text-scheduled",
  maintenance: "text-maint",
  paused: "text-paused",
  warming_up: "text-warming",
  unknown: "text-paused",
};

/**
 * Small rounded pill: colored status dot + label, tinted by the state token.
 * An optional `detail` follows the label in a quieter weight (for example
 * "since Fri 4:48 PM" after "Scheduled off").
 */
export function StatusPill({
  state,
  label,
  detail,
}: {
  state: MonitorState;
  label?: string;
  detail?: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 py-1 text-xs font-medium",
        TEXT[state],
      )}
    >
      <span className={cn("size-1.5 rounded-full", DOT[state])} />
      <span>
        {label ?? STATE_META[state].label}
        {detail != null && (
          <span className="font-normal text-ink-muted"> {detail}</span>
        )}
      </span>
    </span>
  );
}
