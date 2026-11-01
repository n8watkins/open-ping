import { ArrowUpRight, Lock } from "lucide-react";
import {
  CHECK_INTERVAL_CHOICES_MINUTES,
  everyLabel,
  intervalLabel,
  intervalReasonDetail,
  type IntervalReason,
} from "../../shared/check-interval";
import { STANDARD_CHECK_MINUTES, upgradeUrlFor } from "../../shared/hosted-contract";
import type { FastUsage, PlanState } from "../lib/plan-limits";
import { cn } from "../lib/cn";

/** How often the saved monitor is really checked, as the server reports it (effectiveIntervalSeconds, intervalReason). */
export interface StoredEffective {
  intervalSeconds: number;
  effectiveSeconds: number;
  reason: IntervalReason;
}

/**
 * How often a polled monitor is checked, on OpenPing Hosted (shared/
 * check-interval.ts). The choices the plan doesn't allow are shown but
 * locked, with the way to unlock them: those under the plan's shortest
 * interval, and the fast ones (under 12 minutes) once every fast monitor the
 * plan allows is in use. A self-hosted install never shows this (every polled
 * monitor is checked on each 12-minute run there).
 */
export function CheckIntervalPicker({
  plan,
  value,
  stored,
  storedEffective,
  fast,
  onChange,
}: {
  plan: PlanState;
  /** Minutes. */
  value: number;
  /** The saved interval, in minutes, when editing: always selectable again, as the server keeps it. */
  stored?: number;
  /**
   * How often the saved monitor is really checked (the server's word, from the
   * scheduler's own rule), shown while the saved interval is the one chosen.
   */
  storedEffective?: StoredEffective;
  /** Fast monitor usage around this monitor (lib/plan-limits.ts), on a plan with fast checks. */
  fast?: FastUsage | null;
  onChange: (minutes: number) => void;
}) {
  const min = plan.limits.minIntervalMinutes;
  // A value set some other way (the API, or a bigger plan) is shown as a choice too.
  const choices = [...new Set<number>([...CHECK_INTERVAL_CHOICES_MINUTES, value])].sort((a, b) => a - b);
  const isFast = (minutes: number) => minutes < STANDARD_CHECK_MINUTES;
  const fastFull = !!fast && fast.others >= fast.allowed;
  const lockedFor = (minutes: number): "plan" | "fast" | null => {
    if (minutes === value || minutes === stored) return null;
    if (minutes < min) return "plan";
    if (isFast(minutes) && fastFull) return "fast";
    return null;
  };
  const planLocked = choices.some((m) => lockedFor(m) === "plan");
  const fastLocked = choices.some((m) => lockedFor(m) === "fast");
  // Kept from a bigger plan: set fast, but over the allowance, so checked every 12 minutes.
  const slowed = !!fast && isFast(value) && value >= min && value === stored && !fast.kept;
  const effective = slowed ? STANDARD_CHECK_MINUTES : Math.max(value, min);
  const used = fast ? fast.others + (isFast(value) && value >= min ? 1 : 0) : 0;
  // The saved interval, still chosen: what the server says it runs at.
  const saved = storedEffective && value === stored && storedEffective.intervalSeconds === value * 60 ? storedEffective : null;
  const sentence = saved
    ? (intervalReasonDetail(saved.intervalSeconds, saved.effectiveSeconds, saved.reason) ?? `Checked ${everyLabel(value)}.`)
    : value < min
      ? `Set to ${everyLabel(value)}, so checked ${everyLabel(effective)} on your plan, and ${everyLabel(value)} again once your plan allows it.`
      : slowed
        ? (intervalReasonDetail(value * 60, effective * 60, "fast_monitor_limit") ?? "")
        : `Checked ${everyLabel(value)}.`;

  return (
    <fieldset>
      <legend className="mb-1.5 block text-xs font-medium text-ink-muted">Check every</legend>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {choices.map((minutes) => {
          const locked = lockedFor(minutes);
          const selected = minutes === value;
          return (
            <label
              key={minutes}
              className={cn(
                "relative flex min-h-11 items-center justify-center gap-1 rounded-lg border px-2 text-sm font-medium transition-colors",
                "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
                selected
                  ? "border-accent bg-accent-soft text-ink"
                  : locked
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
                disabled={locked !== null}
                onChange={() => onChange(minutes)}
              />
              {locked && <Lock className="size-3.5 shrink-0" aria-hidden />}
              <span>{shortLabel(minutes)}</span>
              {locked && (
                <span className="sr-only">
                  {locked === "plan" ? " (not in your plan)" : " (every fast monitor is in use)"}
                </span>
              )}
            </label>
          );
        })}
      </div>
      <p className="mt-1.5 text-xs text-ink-faint" aria-live="polite">
        {sentence}
      </p>
      {fast && (
        <p className="mt-2 text-xs text-ink-muted">
          <span className="font-medium text-ink tabular-nums">
            {used} of {fast.allowed} fast {fast.allowed === 1 ? "monitor" : "monitors"}
            {used > fast.allowed ? ", over your plan" : " used"}
          </span>
          <span className="text-ink-faint"> · checked more often than every {STANDARD_CHECK_MINUTES} minutes</span>
        </p>
      )}
      {planLocked && (
        <UpgradeHint
          text="Faster checks, down to every minute, come with the fast checks add-on."
          label="Add fast checks"
          href={upgradeUrlFor(plan.upgradeUrl, "interval")}
        />
      )}
      {fastLocked && !planLocked && (
        <UpgradeHint
          text={`${fast!.allowed === 1 ? "Your plan's fast monitor is" : `All ${fast!.allowed} fast monitors are`} in use. To make this one faster, set another to ${STANDARD_CHECK_MINUTES} minutes or more.`}
          label="Add fast monitors"
          href={upgradeUrlFor(plan.upgradeUrl, "fast_monitors")}
        />
      )}
    </fieldset>
  );
}

function UpgradeHint({ text, label, href }: { text: string; label: string; href: string }) {
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
      <span>{text}</span>
      <a
        href={href}
        className="inline-flex min-h-11 items-center gap-1 font-medium text-accent hover:text-accent-hover sm:min-h-0"
      >
        {label}
        <ArrowUpRight className="size-3.5" aria-hidden />
      </a>
    </p>
  );
}

/** "1 min", "12 min", "1 hour": short enough for six side by side. */
function shortLabel(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) return intervalLabel(minutes);
  return `${minutes} min`;
}
