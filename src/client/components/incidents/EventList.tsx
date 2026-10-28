import { useId, type ReactNode } from "react";
import { CheckCircle2, ChevronRight, CircleAlert } from "lucide-react";
import { cn } from "../../lib/cn";
import { formatDuration, formatRelativeTime, formatShortDateTime } from "../../lib/format";
import {
  causeLabel,
  eventTitle,
  monitorNames,
  type GroupableIncident,
  type IncidentEvent,
  type MonthSection,
} from "./grouping";

/** The cause, as a quiet tag on the title line. */
export function CauseTag({ cause }: { cause: string | null }) {
  if (!cause) return null;
  return (
    <span className="inline-flex max-w-full shrink-0 items-center truncate rounded-md border border-line bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-ink-muted">
      {cause}
    </span>
  );
}

function StatusIcon({ open, count }: { open: boolean; count: number }) {
  return (
    <span
      className={cn(
        "relative grid size-8 shrink-0 place-items-center rounded-full",
        open ? "bg-down/10 text-down" : "bg-up/10 text-up",
      )}
    >
      {open && (
        <span className="absolute inset-0 animate-ping rounded-full bg-down/20 [animation-duration:2s]" aria-hidden />
      )}
      {open ? <CircleAlert className="size-4" /> : <CheckCircle2 className="size-4" />}
      {count > 1 && (
        <span
          className="absolute -right-1.5 -bottom-1.5 grid h-[1.125rem] min-w-[1.125rem] place-items-center rounded-full border-2 border-surface bg-line px-1 text-[10px] leading-none font-semibold text-ink tabular-nums"
          aria-hidden
        >
          {count}
        </span>
      )}
    </span>
  );
}

/** The quiet line under a single incident's title (its title already names the monitor). */
function singleSubline(inc: GroupableIncident): string {
  const name = inc.monitorName ?? "Deleted monitor";
  const state = inc.status === "open" ? "Still open" : "Resolved";
  if (!inc.title || !inc.title.includes(name)) return `${name} · ${state}`;
  return state;
}

function durationText(e: { open: boolean; downtimeSeconds: number }): string {
  return e.open ? "ongoing" : formatDuration(e.downtimeSeconds);
}

/** Right-hand when/how-long columns, shared by event and member rows. */
function WhenColumns({ startedAt, duration, open }: { startedAt: number; duration: string; open: boolean }) {
  return (
    <div className="flex shrink-0 flex-col items-end gap-0.5 text-right text-xs sm:flex-row sm:items-center sm:gap-6">
      <span className="text-ink-muted sm:w-28" title={new Date(startedAt).toLocaleString()}>
        <span className="hidden sm:inline">{formatShortDateTime(startedAt)}</span>
        <span className="sm:hidden">{formatRelativeTime(startedAt)}</span>
      </span>
      <span className={cn("tabular-nums sm:w-16", open ? "font-medium text-down" : "text-ink")}>{duration}</span>
    </div>
  );
}

/** One incident inside an expanded event. */
function MemberRow<T extends GroupableIncident>({
  inc,
  showCause,
  selected,
  onSelect,
}: {
  inc: T;
  /** Only when the event's members failed for different reasons. */
  showCause: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const open = inc.status === "open";
  const detail = [
    showCause ? (causeLabel(inc) ?? "Cause not recorded") : null,
    inc.httpStatus != null && !showCause ? `HTTP ${inc.httpStatus}` : null,
    open ? "Still open" : inc.resolvedAt != null ? `Recovered ${formatShortDateTime(inc.resolvedAt)}` : "Resolved",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(inc.id)}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "group flex w-full items-center justify-between gap-3 rounded-lg py-2 pr-2 pl-3 text-left transition-colors duration-(--duration-fast) hover:bg-surface-2 focus-visible:bg-surface-2",
          selected && "bg-surface-2 ring-1 ring-accent/40",
        )}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <span className={cn("size-1.5 shrink-0 rounded-full", open ? "bg-down" : "bg-up")} aria-hidden />
          <span className="min-w-0">
            <span className="block truncate text-sm text-ink group-hover:text-accent-hover">
              {inc.monitorName ?? "Deleted monitor"}
            </span>
            <span className="block truncate text-[11px] text-ink-faint">{detail}</span>
          </span>
        </span>
        <span
          className={cn(
            "shrink-0 text-xs tabular-nums sm:w-16 sm:text-right",
            open ? "font-medium text-down" : "text-ink-muted",
          )}
        >
          {open ? "ongoing" : formatDuration(inc.durationSeconds ?? 0)}
        </span>
      </button>
    </li>
  );
}

/**
 * An event row. A single incident opens its detail panel; a group expands to
 * its incidents (each of which opens the panel), with a smooth height change.
 */
function EventRow<T extends GroupableIncident>({
  event,
  expanded,
  onToggle,
  selectedId,
  onSelect,
}: {
  event: IncidentEvent<T>;
  expanded: boolean;
  onToggle: (key: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const panelId = useId();
  const grouped = event.incidents.length > 1;
  const first = event.incidents[0]!;
  const selected = !grouped && selectedId === first.id;
  const containsSelected = grouped && event.incidents.some((i) => i.id === selectedId);

  const body: ReactNode = (
    <>
      <span className="flex min-w-0 items-center gap-3">
        <StatusIcon open={event.open} count={event.incidents.length} />
        <span className="min-w-0">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-medium text-ink">{eventTitle(event)}</span>
            <CauseTag cause={event.cause} />
          </span>
          <span className="mt-0.5 block truncate text-xs text-ink-faint">
            {grouped ? monitorNames(event) : singleSubline(first)}
          </span>
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <WhenColumns startedAt={event.startedAt} duration={durationText(event)} open={event.open} />
        {grouped ? (
          <ChevronRight
            className={cn(
              "size-4 text-ink-faint transition-transform duration-(--duration-base) ease-out-quart",
              expanded && "rotate-90",
            )}
            aria-hidden
          />
        ) : (
          <span className="size-4" aria-hidden />
        )}
      </span>
    </>
  );

  const rowClass =
    "flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors duration-(--duration-fast) hover:bg-surface-2/70 focus-visible:bg-surface-2/70";

  if (!grouped) {
    return (
      <li className="animate-enter">
        <button
          type="button"
          onClick={() => onSelect(first.id)}
          aria-current={selected ? "true" : undefined}
          className={cn(rowClass, selected && "bg-surface-2")}
        >
          {body}
        </button>
      </li>
    );
  }

  return (
    <li className="animate-enter">
      <button
        type="button"
        onClick={() => onToggle(event.key)}
        aria-expanded={expanded}
        aria-controls={panelId}
        className={cn(rowClass, (expanded || containsSelected) && "bg-surface-2/40")}
      >
        {body}
      </button>
      <div
        id={panelId}
        role="region"
        aria-label={`${eventTitle(event)}: individual incidents`}
        inert={!expanded}
        className={cn(
          "grid transition-[grid-template-rows] duration-(--duration-slow) ease-out-quart",
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <ul
            className={cn(
              "mb-3 mr-4 ml-[3.75rem] space-y-0.5 sm:mr-8 border-l border-line pl-2 transition-opacity duration-(--duration-base)",
              expanded ? "opacity-100" : "opacity-0",
            )}
          >
            {event.incidents.map((inc) => (
              <MemberRow
                key={inc.id}
                inc={inc}
                showCause={event.cause === "Mixed causes"}
                selected={selectedId === inc.id}
                onSelect={onSelect}
              />
            ))}
          </ul>
        </div>
      </div>
    </li>
  );
}

/** Events in month sections ("October 2026 · 1 event · 23m down"), or one flat list. */
export function EventList<T extends GroupableIncident>({
  sections,
  expanded,
  onToggle,
  selectedId,
  onSelect,
}: {
  /** Month sections; a single section with an empty label renders without a header. */
  sections: MonthSection<T>[];
  expanded: Set<string>;
  onToggle: (key: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="space-y-6">
      {sections.map((section) => (
        <section key={section.key} aria-label={section.label || "Incidents"} className="animate-fade">
          {section.label && (
            <div className="mb-2 flex items-baseline justify-between gap-3 px-1">
              <h2 className="text-sm font-semibold tracking-tight text-ink">{section.label}</h2>
              <p className="text-xs text-ink-faint">
                {section.events.length} event{section.events.length === 1 ? "" : "s"}
                {" · "}
                {formatDuration(section.downtimeSeconds)} down
              </p>
            </div>
          )}
          <ul className="stagger divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
            {section.events.map((event) => (
              <EventRow
                key={event.key}
                event={event}
                expanded={expanded.has(event.key)}
                onToggle={onToggle}
                selectedId={selectedId}
                onSelect={onSelect}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Placeholder rows while the first page loads. */
export function EventListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-hidden className="overflow-hidden rounded-card border border-line bg-surface">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center justify-between gap-4 border-b border-line px-4 py-3 last:border-b-0">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="skeleton size-8 shrink-0 rounded-full!" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="skeleton h-3.5 w-1/3 min-w-28" />
              <div className="skeleton h-3 w-1/2 min-w-36" />
            </div>
          </div>
          <div className="skeleton hidden h-3 w-40 sm:block" />
        </div>
      ))}
    </div>
  );
}
