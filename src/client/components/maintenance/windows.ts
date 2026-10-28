/**
 * Maintenance-window helpers for the Maintenance page. PURE. Activity uses the
 * same rules as the Worker (shared/maintenance-schedule), so a recurring
 * window shows as active exactly when the scheduler treats it as active.
 */

import {
  isWindowActiveAt,
  nextRecurringOccurrence,
  type Recurrence,
} from "../../../shared/maintenance-schedule";

export interface MaintenanceWindowItem {
  id: string;
  title: string | null;
  scope: "global" | "monitors" | string;
  monitorIds: string[] | null;
  startsAt: number;
  endsAt: number;
  recurrence: Recurrence | null;
  publicMessage: string | null;
  privateNotes: string | null;
}

export type WindowPhase = "active" | "upcoming" | "past";

/** Where a window stands at `now`, and the occurrence that matters. */
export interface WindowTiming {
  phase: WindowPhase;
  /** The current (active), next (upcoming) or last (past) occurrence. */
  startsAt: number;
  endsAt: number;
}

export function windowTiming(w: MaintenanceWindowItem, now: number): WindowTiming {
  const r = w.recurrence;
  const shaped = { startsAt: w.startsAt, endsAt: w.endsAt, recurrence: r };
  if (!r) {
    if (isWindowActiveAt(shaped, now)) return { phase: "active", startsAt: w.startsAt, endsAt: w.endsAt };
    if (now < w.startsAt) return { phase: "upcoming", startsAt: w.startsAt, endsAt: w.endsAt };
    return { phase: "past", startsAt: w.startsAt, endsAt: w.endsAt };
  }
  const durMs = r.durationMinutes * 60_000;
  if (isWindowActiveAt(shaped, now)) {
    // The occurrence in progress is the first one after (now - duration).
    const cur = nextRecurringOccurrence(shaped, now - durMs);
    if (cur) return { phase: "active", startsAt: cur.startsAt, endsAt: Math.min(cur.endsAt, w.endsAt) };
    return { phase: "active", startsAt: now, endsAt: w.endsAt };
  }
  const next = nextRecurringOccurrence(shaped, now);
  if (next) return { phase: "upcoming", startsAt: next.startsAt, endsAt: next.endsAt };
  return { phase: "past", startsAt: w.startsAt, endsAt: w.endsAt };
}

/** "1:05:09" or "4:09": a live countdown (rounded up to the next second). */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** "30 min", "1 h", "1 h 30 min", "2 days". */
export function formatSpan(minutes: number): string {
  const mins = Math.round(minutes);
  if (mins < 60) return `${mins} min`;
  if (mins % 1440 === 0) return `${mins / 1440} day${mins === 1440 ? "" : "s"}`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

const DAY_NAMES = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

/** "Every week" description of a weekly rule, in UTC as stored. */
export function recurrenceLabel(r: Recurrence): string {
  return `${DAY_NAMES[r.weekday] ?? "Weekly"} at ${r.start} UTC for ${formatSpan(r.durationMinutes)}`;
}

/** The body for POST /api/maintenance that pauses alerts from `now` for `minutes`. */
export function quickPausePayload(
  monitorIds: string[] | "all",
  minutes: number,
  now: number,
  publicMessage?: string,
) {
  const all = monitorIds === "all";
  return {
    // No duration in the title: the window can be extended or ended early.
    title: "Alerts paused",
    scope: all ? ("global" as const) : ("monitors" as const),
    ...(all ? {} : { monitorIds }),
    startsAt: now,
    endsAt: now + minutes * 60_000,
    ...(publicMessage ? { publicMessage } : {}),
  };
}

/** Sort for each section: active ends soonest first, upcoming starts soonest first, past newest first. */
export function partitionWindows(
  windows: MaintenanceWindowItem[],
  now: number,
): Record<WindowPhase, { win: MaintenanceWindowItem; timing: WindowTiming }[]> {
  const out: Record<WindowPhase, { win: MaintenanceWindowItem; timing: WindowTiming }[]> = {
    active: [],
    upcoming: [],
    past: [],
  };
  for (const win of windows) {
    const timing = windowTiming(win, now);
    out[timing.phase].push({ win, timing });
  }
  out.active.sort((a, b) => a.timing.endsAt - b.timing.endsAt);
  out.upcoming.sort((a, b) => a.timing.startsAt - b.timing.startsAt);
  out.past.sort((a, b) => b.timing.endsAt - a.timing.endsAt);
  return out;
}

/**
 * A window's time range: "Sat, Nov 1, 2:00 PM-4:00 PM" on one day, otherwise
 * "Sat, Nov 1, 2:00 PM to Sun, Nov 2, 4:00 AM". Viewer's locale and timezone
 * unless `opts` pins them (tests do).
 */
export function formatWindowRange(
  startsAt: number,
  endsAt: number,
  opts: { locale?: string; timeZone?: string } = {},
): string {
  const { locale, timeZone } = opts;
  const day = new Intl.DateTimeFormat(locale, { timeZone, weekday: "short", month: "short", day: "numeric" });
  const time = new Intl.DateTimeFormat(locale, { timeZone, hour: "numeric", minute: "2-digit" });
  const sameDay = day.format(startsAt) === day.format(endsAt);
  if (sameDay) return `${day.format(startsAt)}, ${time.format(startsAt)}-${time.format(endsAt)}`;
  return `${day.format(startsAt)}, ${time.format(startsAt)} to ${day.format(endsAt)}, ${time.format(endsAt)}`;
}

/** "in 5 min", "in 3 h", "in 2 days", for when an upcoming window starts. */
export function formatStartsIn(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `in ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `in ${h} h`;
  return `in ${Math.round(h / 24)} days`;
}
