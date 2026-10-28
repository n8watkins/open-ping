import { useState } from "react";
import { BellOff, Loader2 } from "lucide-react";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { MonitorPicker, type MonitorChoice, type MonitorOption } from "./MonitorPicker";
import { formatSpan, quickPausePayload } from "./windows";

const DURATIONS = [30, 60, 120] as const;

/**
 * "Pause alerts for 30 min / 1 h / 2 h, starting now" for the chosen
 * monitors: one click creates a maintenance window from now.
 */
export function QuickPause({
  monitors,
  csrf,
  onCreated,
  errorMessage,
}: {
  monitors: MonitorOption[];
  csrf: string | undefined;
  onCreated: () => void | Promise<void>;
  errorMessage: (e: unknown, fallback: string) => string;
}) {
  const [choice, setChoice] = useState<MonitorChoice>("all");
  const [announce, setAnnounce] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function pause(minutes: number) {
    setBusy(minutes);
    setError(null);
    try {
      await api("/api/maintenance", {
        method: "POST",
        csrf,
        json: quickPausePayload(
          choice,
          minutes,
          Date.now(),
          announce ? "We're doing some quick maintenance. Things may be briefly unavailable." : undefined,
        ),
      });
      await onCreated();
    } catch (e) {
      setError(errorMessage(e, "Could not pause alerts."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="quick-pause-title" className="animate-enter rounded-card border border-line bg-surface p-4">
      <div className="flex items-center gap-2.5">
        <span className="grid size-7 place-items-center rounded-lg bg-accent-soft text-accent">
          <BellOff className="size-4" />
        </span>
        <div>
          <h2 id="quick-pause-title" className="text-sm font-semibold text-ink">
            Pause alerts now
          </h2>
          <p className="text-xs text-ink-muted">For unplanned work: a restart, a quick fix, a deploy.</p>
        </div>
      </div>

      <div className="mt-4">
        <MonitorPicker monitors={monitors} value={choice} onChange={setChoice} label="Monitors to pause" />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {DURATIONS.map((minutes) => (
          <button
            key={minutes}
            type="button"
            disabled={busy !== null}
            onClick={() => void pause(minutes)}
            className={cn(
              "inline-flex min-w-[5.5rem] items-center justify-center gap-2 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2 text-sm font-medium text-ink transition-[background-color,border-color,transform] duration-(--duration-fast) ease-out-quart hover:border-accent hover:bg-accent/20 active:scale-[0.97] disabled:opacity-60",
            )}
          >
            {busy === minutes && <Loader2 className="size-3.5 animate-spin" />}
            {formatSpan(minutes)}
          </button>
        ))}
      </div>

      <label className="mt-3 flex items-center gap-2 text-xs text-ink-muted">
        <input
          type="checkbox"
          checked={announce}
          onChange={(e) => setAnnounce(e.target.checked)}
          className="size-3.5 accent-accent"
        />
        Also show a maintenance notice on the status page
      </label>

      <p className="mt-4 border-t border-line pt-3 text-xs text-ink-faint">
        Starts now and ends on its own; checks and alerts resume after. To stop early, use End now below.
      </p>

      {error && (
        <p role="alert" className="mt-3 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-xs text-down">
          {error}
        </p>
      )}
    </section>
  );
}
