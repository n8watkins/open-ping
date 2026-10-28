import type { BucketState } from "../../../shared/time-range";

/**
 * Fill and label for each bucket state. Explicit class strings (no
 * interpolation) so Tailwind keeps them. Off-hours is a quiet neutral gray and
 * "no data" an empty track: neither reads as an outage.
 */
export const BUCKET_FILL: Record<BucketState, string> = {
  up: "bg-up",
  degraded: "bg-degraded",
  down: "bg-down",
  suspended: "bg-suspended",
  scheduled_off: "bg-scheduled/30",
  maintenance: "bg-maint",
  paused: "bg-paused/50",
  nodata: "bg-line",
};

export const BUCKET_TEXT: Record<BucketState, string> = {
  up: "text-up",
  degraded: "text-degraded",
  down: "text-down",
  suspended: "text-suspended",
  scheduled_off: "text-scheduled",
  maintenance: "text-maint",
  paused: "text-paused",
  nodata: "text-ink-faint",
};

export const BUCKET_LABEL: Record<BucketState, string> = {
  up: "Up",
  degraded: "Degraded",
  down: "Down",
  suspended: "Suspended",
  scheduled_off: "Off-hours",
  maintenance: "Maintenance",
  paused: "Paused",
  nodata: "No data",
};
