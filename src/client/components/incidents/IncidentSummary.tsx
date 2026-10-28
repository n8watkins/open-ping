import { formatDuration } from "../../lib/format";
import type { EventSummary } from "./grouping";

function Tile({ label, value, tone }: { label: string; value: string; tone?: "down" | "up" }) {
  return (
    <div className="min-w-0 rounded-lg bg-surface-2/50 px-3 py-2.5">
      <div
        className={
          tone === "down"
            ? "text-lg font-semibold tabular-nums text-down"
            : tone === "up"
              ? "text-lg font-semibold tabular-nums text-up"
              : "text-lg font-semibold tabular-nums text-ink"
        }
      >
        {value}
      </div>
      <div className="mt-0.5 text-[11px] text-ink-muted">{label}</div>
    </div>
  );
}

/**
 * The headline for the current filter: "This month: 1 event, 23m downtime",
 * and tiles for events, downtime, the longest event and what is open now.
 */
export function IncidentSummary({
  rangeLabel,
  summary,
  partial,
}: {
  rangeLabel: string;
  summary: EventSummary;
  /** Shown when the page holds only the newest part of the matching incidents. */
  partial?: string | null;
}) {
  const { events, incidents, open, downtimeSeconds, longestSeconds } = summary;
  const headline =
    events === 0
      ? "no incidents"
      : `${events} event${events === 1 ? "" : "s"}, ${formatDuration(downtimeSeconds)} downtime`;
  return (
    <section
      aria-label="Incident summary"
      className="animate-enter rounded-card border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm text-ink">
          <span className="font-semibold">{rangeLabel}:</span> {headline}
        </p>
        {events > 0 && (
          <p className="text-xs text-ink-faint">
            {incidents} incident{incidents === 1 ? "" : "s"}, grouped when monitors went down together
          </p>
        )}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Events" value={String(events)} />
        <Tile label="Total downtime" value={events ? formatDuration(downtimeSeconds) : "0s"} />
        <Tile label="Longest event" value={events ? formatDuration(longestSeconds) : "-"} />
        <Tile label="Open now" value={String(open)} tone={open > 0 ? "down" : "up"} />
      </div>
      {partial && <p className="mt-2 text-xs text-ink-faint">{partial}</p>}
    </section>
  );
}
