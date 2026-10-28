import { useId, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { BellOff, CalendarClock, ChevronDown, Megaphone, Wrench } from "lucide-react";
import { cn } from "../../lib/cn";

const STORAGE_KEY = "op.maintenance.explainer-collapsed";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean) {
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
  } catch {
    /* private mode or blocked storage: the panel just opens next time */
  }
}

function Point({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-md bg-maint/15 text-maint">{icon}</span>
      <span>{children}</span>
    </li>
  );
}

/**
 * What maintenance windows are for, in plain words, with a worked example,
 * and how they differ from a monitor's business-hours schedule. Collapsible;
 * the choice is remembered in this browser.
 */
export function MaintenanceExplainer({ exampleMonitor }: { exampleMonitor: string }) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const bodyId = useId();

  function toggle() {
    setCollapsed((c) => {
      writeCollapsed(!c);
      return !c;
    });
  }

  return (
    <section aria-label="How maintenance works" className="animate-enter rounded-card border border-line bg-surface">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        className="flex w-full items-center justify-between gap-3 rounded-card px-4 py-3 text-left transition-colors duration-(--duration-fast) hover:bg-surface-2/50"
      >
        <span className="flex items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-lg bg-maint/15 text-maint">
            <Wrench className="size-4" />
          </span>
          <span className="text-sm font-semibold text-ink">What maintenance is for</span>
        </span>
        <ChevronDown
          className={cn(
            "size-4 text-ink-faint transition-transform duration-(--duration-base) ease-out-quart",
            !collapsed && "rotate-180",
          )}
          aria-hidden
        />
      </button>
      <div
        id={bodyId}
        inert={collapsed}
        className={cn(
          "grid transition-[grid-template-rows] duration-(--duration-slow) ease-out-quart",
          collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div
            className={cn(
              "border-t border-line px-4 pt-3 pb-4 transition-opacity duration-(--duration-base)",
              collapsed ? "opacity-0" : "opacity-100",
            )}
          >
            <p className="text-sm text-ink-muted">
              A maintenance window tells OpenPing that downtime is planned.{" "}
              <span className="text-ink">
                Taking {exampleMonitor} down Saturday 2-4 pm for a database upgrade? Schedule a window for it:
              </span>
            </p>
            <ul className="mt-3 space-y-2 text-sm text-ink-muted">
              <Point icon={<BellOff className="size-3" />}>
                <span className="text-ink">Alerts are paused</span> and no incident opens; the time doesn't count
                against uptime.
              </Point>
              <Point icon={<Megaphone className="size-3" />}>
                <span className="text-ink">The status page says it's planned,</span> when you add a public notice.
                Visitors see it up to 14 days ahead.
              </Point>
            </ul>

            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <div className="rounded-lg border border-maint/30 bg-maint/5 p-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-maint">
                  <Wrench className="size-3.5" /> Maintenance window
                </div>
                <p className="mt-1 text-xs text-ink-muted">
                  One-off work at a time you choose: an upgrade, a migration, a deploy that needs a restart.
                </p>
              </div>
              <div className="rounded-lg border border-line bg-surface-2/40 p-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-ink">
                  <CalendarClock className="size-3.5 text-ink-faint" /> Business-hours schedule
                </div>
                <p className="mt-1 text-xs text-ink-muted">
                  The same hours every week, set on the monitor (for example{" "}
                  <span className="whitespace-nowrap">Weekdays 8-5</span>). Off-hours are never checked, so there
                  is nothing to schedule here.{" "}
                  <Link to="/monitors" className="text-accent hover:text-accent-hover hover:underline">
                    See schedules
                  </Link>
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
