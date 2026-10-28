import { useRef, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { RANGE_SPEC, TIME_RANGES, type TimeRange } from "../../../shared/time-range";

/** A range button's accessible name: its visible text, then what it means. */
export function rangeLabel(r: TimeRange): string {
  const { short, long } = RANGE_SPEC[r];
  return `${short}, ${long.charAt(0).toLowerCase()}${long.slice(1)}`;
}

/**
 * The 24h / 7d / 30d / 90d switch. A radio group: Tab reaches the selected
 * option, the arrow keys move between them. The highlight slides to the
 * chosen option.
 */
export function RangeControl({
  value,
  onChange,
  label = "Time range",
  className,
}: {
  value: TimeRange;
  onChange: (next: TimeRange) => void;
  label?: string;
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = TIME_RANGES.indexOf(value);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (index + delta + TIME_RANGES.length) % TIME_RANGES.length;
    onChange(TIME_RANGES[next]!);
    refs.current[next]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn(
        "relative inline-grid grid-cols-4 rounded-lg border border-line bg-surface p-0.5 text-sm",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0.5 left-0.5 rounded-md bg-accent-soft ring-1 ring-accent/40 transition-transform duration-(--duration-base) ease-out-quart"
        style={{ width: "calc((100% - 4px) / 4)", transform: `translateX(${index * 100}%)` }}
      />
      {TIME_RANGES.map((r, i) => (
        <button
          key={r}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={r === value}
          // Starts with the visible text, so voice control ("tap 24h") and
          // screen readers agree on the name: "24h, last 24 hours".
          aria-label={rangeLabel(r)}
          tabIndex={r === value ? 0 : -1}
          onClick={() => onChange(r)}
          className={cn(
            "relative z-10 min-w-12 rounded-md px-3 py-1.5 font-medium tabular-nums transition-colors duration-(--duration-fast)",
            r === value ? "text-ink" : "text-ink-muted hover:text-ink",
          )}
        >
          {RANGE_SPEC[r].short}
        </button>
      ))}
    </div>
  );
}
