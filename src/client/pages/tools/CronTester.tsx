import { useMemo, useState } from "react";
import { DateTime } from "luxon";
import { Clock } from "lucide-react";
import { ToolLayout, Panel, Notice } from "./ToolLayout";
import { describeCron, nextCronRuns } from "./lib";

const EXAMPLES: { expr: string; note: string }[] = [
  { expr: "*/5 * * * *", note: "Every 5 minutes" },
  { expr: "0 9 * * 1-5", note: "9am on weekdays" },
  { expr: "0 0 * * 0", note: "Midnight on Sundays" },
  { expr: "30 2 1 * *", note: "2:30am on the 1st" },
  { expr: "0 */6 * * *", note: "Every 6 hours" },
];

const RUN_COUNT = 8;

/** All IANA zones if the runtime supports it, otherwise a curated fallback. */
function listTimeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  try {
    const zones = intl.supportedValuesOf?.("timeZone");
    if (zones && zones.length) return zones;
  } catch {
    /* fall through to the curated list */
  }
  return [
    "UTC",
    "America/Los_Angeles",
    "America/Denver",
    "America/Chicago",
    "America/New_York",
    "America/Sao_Paulo",
    "Europe/London",
    "Europe/Paris",
    "Europe/Berlin",
    "Africa/Johannesburg",
    "Asia/Dubai",
    "Asia/Kolkata",
    "Asia/Singapore",
    "Asia/Tokyo",
    "Australia/Sydney",
  ];
}

export default function CronTester() {
  const zones = useMemo(listTimeZones, []);
  const [expr, setExpr] = useState("*/5 * * * *");
  const [zone, setZone] = useState(() => DateTime.local().zoneName ?? "UTC");

  const { description, runs, error } = useMemo(() => {
    try {
      return {
        description: describeCron(expr),
        runs: nextCronRuns(expr, RUN_COUNT, zone),
        error: null as string | null,
      };
    } catch (e) {
      return { description: "", runs: [] as DateTime[], error: (e as Error).message };
    }
  }, [expr, zone]);

  return (
    <ToolLayout
      icon={Clock}
      title="Cron expression tester"
      intro="Paste a standard 5-field cron expression to validate it, read it in plain English, and preview when it will next run in any timezone."
    >
      <Panel>
        <label htmlFor="cron" className="block text-sm font-medium text-ink">
          Cron expression
        </label>
        <input
          id="cron"
          type="text"
          value={expr}
          onChange={(e) => setExpr(e.target.value)}
          placeholder="*/5 * * * *"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-describedby="cron-help"
          className="input mt-2 font-mono"
        />
        <p id="cron-help" className="mt-2 text-xs text-ink-faint">
          Five fields: minute · hour · day-of-month · month · day-of-week.
          Supports <code>*</code>, ranges (<code>1-5</code>), lists
          (<code>1,15,30</code>), and steps (<code>*/10</code>).
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex.expr}
              type="button"
              onClick={() => setExpr(ex.expr)}
              title={ex.note}
              className="rounded-full border border-line bg-surface-2 px-3 py-1 font-mono text-xs text-ink-muted transition-colors hover:text-ink"
            >
              {ex.expr}
            </button>
          ))}
        </div>

        <label htmlFor="cron-tz" className="mt-5 block text-sm font-medium text-ink">
          Timezone
        </label>
        <select
          id="cron-tz"
          value={zone}
          onChange={(e) => setZone(e.target.value)}
          className="input mt-2"
        >
          {zones.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
      </Panel>

      <div className="mt-6 space-y-4" aria-live="polite">
        {error ? (
          <Notice>{error}</Notice>
        ) : (
          <>
            <Panel>
              <div className="text-xs uppercase tracking-wide text-ink-faint">
                In plain English
              </div>
              <p className="mt-1.5 text-base font-medium text-ink">{description}</p>
            </Panel>

            <Panel>
              <h2 className="mb-3 text-sm font-semibold text-ink">
                Next {runs.length} run{runs.length === 1 ? "" : "s"}{" "}
                <span className="font-normal text-ink-faint">({zone})</span>
              </h2>
              {runs.length === 0 ? (
                <Notice tone="info">
                  No upcoming runs were found within the search window.
                </Notice>
              ) : (
                <ol className="space-y-1.5">
                  {runs.map((r, i) => (
                    <li
                      key={i}
                      className="flex items-center justify-between gap-4 border-b border-line/60 pb-1.5 text-sm last:border-0 last:pb-0"
                    >
                      <span className="font-mono text-ink">
                        {r.toFormat("ccc, dd LLL yyyy · HH:mm")}
                      </span>
                      <span className="shrink-0 text-xs text-ink-faint">
                        {r.toRelative()}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </Panel>
          </>
        )}
      </div>
    </ToolLayout>
  );
}
