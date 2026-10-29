import { ArrowUpRight, Lock } from "lucide-react";
import { CHECK_INTERVAL_CHOICES_MINUTES, everyLabel, intervalLabel } from "../../shared/check-interval";
import type { PlanState } from "../lib/plan-limits";
import { cn } from "../lib/cn";

/**
 * How often a polled monitor is checked, on OpenPing Hosted (shared/
 * check-interval.ts). The choices under the plan's shortest interval are shown
 * but locked, with the way to unlock them; a self-hosted install never shows
 * this (every polled monitor is checked on each 12-minute run there).
 */
export function CheckIntervalPicker({
  plan,
  value,
  onChange,
}: {
  plan: PlanState;
  /** Minutes. */
  value: number;
  onChange: (minutes: number) => void;
}) {
  const min = plan.limits.minIntervalMinutes;
  // A value set some other way (the API, or a bigger plan) is shown as a choice too.
  const choices = [...new Set<number>([...CHECK_INTERVAL_CHOICES_MINUTES, value])].sort((a, b) => a - b);
  const locked = choices.some((m) => m < min);
  const effective = Math.max(value, min);

  return (
    <fieldset>
      <legend className="mb-1.5 block text-xs font-medium text-ink-muted">Check every</legend>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {choices.map((minutes) => {
          const disabled = minutes < min && minutes !== value;
          const selected = minutes === value;
          return (
            <label
              key={minutes}
              className={cn(
                "relative flex min-h-11 items-center justify-center gap-1 rounded-lg border px-2 text-sm font-medium transition-colors",
                "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
                selected
                  ? "border-accent bg-accent-soft text-ink"
                  : disabled
                    ? "cursor-not-allowed border-line border-dashed text-ink-faint"
                    : "cursor-pointer border-line text-ink-muted hover:bg-surface-2",
              )}
            >
              <input
                type="radio"
                name="check-interval"
                className="sr-only"
                value={minutes}
                checked={selected}
                disabled={disabled}
                onChange={() => onChange(minutes)}
              />
              {disabled && <Lock className="size-3.5 shrink-0" aria-hidden />}
              <span>{shortLabel(minutes)}</span>
              {disabled && <span className="sr-only"> (not in your plan)</span>}
            </label>
          );
        })}
      </div>
      <p className="mt-1.5 text-xs text-ink-faint" aria-live="polite">
        {value < min
          ? `Set to ${everyLabel(value)}, so checked ${everyLabel(effective)} on your plan, and ${everyLabel(value)} again once your plan allows it.`
          : `Checked ${everyLabel(value)}.`}
      </p>
      {locked && (
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
          <span>Faster checks, down to every minute, come with the fast checks add-on.</span>
          <a
            href={plan.upgradeUrl}
            className="inline-flex min-h-11 items-center gap-1 font-medium text-accent hover:text-accent-hover sm:min-h-0"
          >
            Add fast checks
            <ArrowUpRight className="size-3.5" aria-hidden />
          </a>
        </p>
      )}
    </fieldset>
  );
}

/** "1 min", "12 min", "1 hour": short enough for six side by side. */
function shortLabel(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) return intervalLabel(minutes);
  return `${minutes} min`;
}
