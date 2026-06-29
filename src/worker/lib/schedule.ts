import { DateTime } from "luxon";
import type { Schedule } from "../../shared/schemas";

/**
 * Timezone- and DST-aware monitoring schedule engine (PRD §7).
 *
 * All wall-clock reasoning is done in the schedule's IANA `timezone` via luxon,
 * so the active windows track DST transitions automatically: "08:00 local" is
 * always 08:00 in the configured zone regardless of whether that day is 23, 24
 * or 25 hours long. Returned values are absolute `Date` instants (UTC under the
 * hood), so callers never deal with offsets directly.
 *
 * Weekday convention: the schemas use 0=Sun … 6=Sat, while luxon's
 * `DateTime.weekday` is 1=Mon … 7=Sun. The two line up via `weekday % 7`
 * (Mon=1…Sat=6 are unchanged; Sun=7 → 0). See {@link luxonToSchemaWeekday}.
 *
 * Overnight windows: a period whose `end <= start` (e.g. 22:00–06:00) spills
 * into the following calendar day. Such a window is active during the evening
 * portion [start, 24:00) on its opening weekday AND the morning portion
 * [00:00, end) on the next day.
 */

/** A single recurring window, expressed in minutes-from-local-midnight. */
interface Window {
  /** Schema weekday (0=Sun … 6=Sat) the window OPENS on. */
  weekday: number;
  /** Inclusive start, minutes from local midnight. */
  startMin: number;
  /** Exclusive end, minutes from local midnight. `<= startMin` means overnight. */
  endMin: number;
}

const MINUTES_PER_DAY = 1440;
/** Bounded forward search horizon for the next active window. */
const SEARCH_DAYS = 372; // a little over a year so a 370-day gap is still found.

/** Convert luxon's 1=Mon…7=Sun weekday to the schema's 0=Sun…6=Sat. */
function luxonToSchemaWeekday(luxonWeekday: number): number {
  return luxonWeekday % 7;
}

/** Parse "HH:MM" into minutes from midnight. */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

/** Duration of a window in hours, accounting for overnight wrap. */
function windowHours(startMin: number, endMin: number): number {
  const end = endMin <= startMin ? endMin + MINUTES_PER_DAY : endMin;
  return (end - startMin) / 60;
}

/** Build the recurring windows for a (non-"always") schedule. */
function scheduleWindows(schedule: Schedule): Window[] {
  switch (schedule.mode) {
    case "business_hours":
      return schedule.weekdays.map((weekday) => ({
        weekday,
        startMin: toMinutes(schedule.start),
        endMin: toMinutes(schedule.end),
      }));
    case "custom":
      return schedule.days.flatMap((day) =>
        day.periods.map((period) => ({
          weekday: day.weekday,
          startMin: toMinutes(period.start),
          endMin: toMinutes(period.end),
        })),
      );
    default:
      return [];
  }
}

/** The IANA timezone for a schedule, or undefined for "always". */
function scheduleZone(schedule: Schedule): string | undefined {
  return schedule.mode === "always" ? undefined : schedule.timezone;
}

/**
 * True when `at`'s local calendar date (in the schedule's zone) is listed in a
 * custom schedule's `excludedDates`. Always false for non-custom schedules.
 *
 * Note: exclusion is evaluated against the instant's own local date, so an
 * overnight window opening on an allowed day but spilling into an excluded day
 * is considered inactive during that excluded-morning portion.
 */
export function isExcludedDate(schedule: Schedule, at: Date): boolean {
  if (schedule.mode !== "custom") return false;
  if (schedule.excludedDates.length === 0) return false;
  const key = DateTime.fromJSDate(at, { zone: schedule.timezone }).toFormat(
    "yyyy-MM-dd",
  );
  return schedule.excludedDates.includes(key);
}

/**
 * Whether any of `windows` contains the instant `at` (interpreted in `zone`).
 *
 * `excludedDates` are applied per the window's OPENING day, not the instant's
 * own date: an overnight window opened on a non-excluded day stays active
 * through its morning spillover even if that spillover lands on an excluded
 * date, and an overnight window opened on an excluded day is inactive for its
 * whole span. This anchors a window to its opening day exactly as
 * {@link nextActivePeriod} does, so the two functions never disagree (which
 * would otherwise let setScheduledOff write a past next_check_at).
 */
function windowsActiveAt(
  windows: Window[],
  zone: string,
  at: Date,
  excludedDates: readonly string[] = [],
): boolean {
  const dt = DateTime.fromJSDate(at, { zone });
  const weekday = luxonToSchemaWeekday(dt.weekday);
  const prevWeekday = (weekday + 6) % 7;
  // Fractional minutes from midnight so [start, end) boundaries are exact.
  const minute =
    dt.hour * 60 + dt.minute + dt.second / 60 + dt.millisecond / 60000;
  const todayKey = dt.toFormat("yyyy-MM-dd");
  const prevKey = dt.minus({ days: 1 }).toFormat("yyyy-MM-dd");
  const excluded = (key: string) =>
    excludedDates.length > 0 && excludedDates.includes(key);

  for (const w of windows) {
    const overnight = w.endMin <= w.startMin;
    if (!overnight) {
      // Opens and closes on `weekday`; exclusion keys off that (today's) date.
      if (weekday === w.weekday && minute >= w.startMin && minute < w.endMin) {
        if (!excluded(todayKey)) return true;
      }
    } else {
      // Evening portion [start, 24:00) opens today → key exclusion off today.
      if (weekday === w.weekday && minute >= w.startMin && !excluded(todayKey)) {
        return true;
      }
      // Morning portion [00:00, end) belongs to the window that OPENED
      // yesterday → key exclusion off yesterday (the opening day).
      if (prevWeekday === w.weekday && minute < w.endMin && !excluded(prevKey)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Is the monitor scheduled to be checked at instant `at`?
 *
 * - `always`         → always true.
 * - `business_hours` → local weekday is in `weekdays` and local time is within
 *                      the single daily window [start, end) (overnight aware).
 * - `custom`         → some period contains the local time (overnight aware)
 *                      and that period's OPENING day is not excluded. Exclusion
 *                      is anchored to the opening day (see {@link windowsActiveAt})
 *                      so it agrees with {@link nextActivePeriod} for overnight
 *                      windows.
 */
export function isActiveAt(schedule: Schedule, at: Date): boolean {
  if (schedule.mode === "always") return true;
  const excluded = schedule.mode === "custom" ? schedule.excludedDates : [];
  return windowsActiveAt(scheduleWindows(schedule), schedule.timezone, at, excluded);
}

/** Resolve a recurring window into concrete instants on a given local day. */
function windowInstants(
  openDay: DateTime,
  w: Window,
): { start: Date; end: Date } {
  const start = openDay.set({
    hour: Math.floor(w.startMin / 60),
    minute: w.startMin % 60,
    second: 0,
    millisecond: 0,
  });
  const overnight = w.endMin <= w.startMin;
  const endDay = overnight ? openDay.plus({ days: 1 }) : openDay;
  const end = endDay.set({
    hour: Math.floor(w.endMin / 60),
    minute: w.endMin % 60,
    second: 0,
    millisecond: 0,
  });
  return { start: start.toJSDate(), end: end.toJSDate() };
}

/**
 * The next upcoming active window as absolute instants.
 *
 * If currently active, the window currently containing `at` (start <= at < end)
 * is returned. Otherwise the next window starting after `at` is returned.
 *
 * Returns `null` for `always` (it is always active, so there is no discrete
 * "next" window) and when no active window exists within {@link SEARCH_DAYS}.
 */
export function nextActivePeriod(
  schedule: Schedule,
  at: Date,
): { start: Date; end: Date } | null {
  const zone = scheduleZone(schedule);
  if (!zone) return null; // "always"

  const windows = scheduleWindows(schedule);
  if (windows.length === 0) return null;

  const atMs = at.getTime();
  // Start one day before `at` so an overnight window opened "yesterday" that
  // still contains `at` (or starts earliest) is considered.
  let cursor = DateTime.fromJSDate(at, { zone }).startOf("day").minus({
    days: 1,
  });

  let best: { start: Date; end: Date } | null = null;
  const excluded = schedule.mode === "custom" ? schedule.excludedDates : [];

  for (let i = 0; i <= SEARCH_DAYS; i++) {
    const weekday = luxonToSchemaWeekday(cursor.weekday);
    const dayExcluded =
      excluded.length > 0 && excluded.includes(cursor.toFormat("yyyy-MM-dd"));

    let foundOnDay = false;
    if (!dayExcluded) {
      for (const w of windows) {
        if (w.weekday !== weekday) continue;
        const inst = windowInstants(cursor, w);
        if (inst.end.getTime() <= atMs) continue; // already finished
        foundOnDay = true;
        if (best === null || inst.start.getTime() < best.start.getTime()) {
          best = inst;
        }
      }
    }

    // Days are scanned in increasing order, so the earliest day carrying a
    // qualifying window holds the globally-earliest start: stop once found.
    if (best !== null && foundOnDay) break;
    cursor = cursor.plus({ days: 1 });
  }

  return best;
}

/**
 * When should the next check fire, given the polling `intervalSeconds`?
 *
 * - Active now (or `always`) → `at + interval`.
 * - Inactive               → the start of the next active window, so the worker
 *                            wakes exactly when monitoring resumes.
 * - Inactive with no window within the horizon → falls back to `at + interval`.
 */
export function nextCheckAt(
  schedule: Schedule,
  at: Date,
  intervalSeconds: number,
): Date {
  const afterInterval = new Date(at.getTime() + intervalSeconds * 1000);
  if (schedule.mode === "always") return afterInterval;
  if (isActiveAt(schedule, at)) return afterInterval;

  const next = nextActivePeriod(schedule, at);
  return next ? next.start : afterInterval;
}

/**
 * Approximate active hours in a nominal 30-day month.
 *
 * - `always`         → 720 (30 * 24).
 * - `business_hours` → each scheduled weekday occurs 30/7 times; multiply by the
 *                      single window's duration.
 * - `custom`         → sum every period's duration across the week, then scale
 *                      by 30/7 weeks.
 *
 * This is a planning/estimate figure: `excludedDates` are ignored (they are
 * sparse, calendar-anchored, and not tied to a specific 30-day span), and
 * partial DST-affected days are not adjusted.
 */
export function activeHoursPerMonth(schedule: Schedule): number {
  const WEEKS_PER_MONTH = 30 / 7;
  switch (schedule.mode) {
    case "always":
      return 720;
    case "business_hours": {
      const perWindow = windowHours(
        toMinutes(schedule.start),
        toMinutes(schedule.end),
      );
      return schedule.weekdays.length * perWindow * WEEKS_PER_MONTH;
    }
    case "custom": {
      const weeklyHours = schedule.days.reduce(
        (total, day) =>
          total +
          day.periods.reduce(
            (sum, p) => sum + windowHours(toMinutes(p.start), toMinutes(p.end)),
            0,
          ),
        0,
      );
      return weeklyHours * WEEKS_PER_MONTH;
    }
  }
}
