/**
 * Maintenance-window activity rules, shared by the Worker (incident
 * suppression, the public status page) and the dashboard (active, upcoming and
 * past lists). PURE: no I/O. Timestamps are epoch milliseconds.
 *
 * TIME ZONE: all recurrence math is performed in UTC. A weekly rule's `weekday`
 * (0=Sun..6=Sat) and `start` ("HH:MM") are interpreted as UTC wall-clock values.
 */

/** A weekly recurrence rule (the only recurrence type supported in v1). */
export type Recurrence = {
  type: "weekly";
  /** 0 = Sunday .. 6 = Saturday (UTC). */
  weekday: number;
  /** Start time in UTC, "HH:MM" 24h. */
  start: string;
  /** Window length in minutes (may cross midnight / the week boundary). */
  durationMinutes: number;
};

/** The fields the activity rules read from a window. */
export interface ScheduledWindow {
  startsAt: number;
  endsAt: number;
  recurrence: Recurrence | null;
}

const MINUTES_PER_WEEK = 7 * 24 * 60;

/**
 * Whether a maintenance window is active at instant `now` (epoch ms).
 *
 * One-time (recurrence === null): `startsAt <= now < endsAt`.
 *
 * Weekly recurrence: first gated on the window's [startsAt, endsAt) validity
 * range - a bounded recurring window does not recur before it starts or after it
 * ends. Within range it is evaluated entirely in UTC: we map both `now` and the
 * rule's start to a "minute of the week" (0..10079, Sunday 00:00 = 0) and test
 * whether `now` falls within [start, start + durationMinutes). The membership
 * test wraps modulo the week length, so windows that cross midnight - or even the
 * Saturday→Sunday week boundary - are handled correctly.
 */
export function isWindowActiveAt(w: ScheduledWindow, now: number): boolean {
  const r = w.recurrence;
  if (r == null) {
    return w.startsAt <= now && now < w.endsAt;
  }

  // A recurring window only recurs within its [startsAt, endsAt) validity range;
  // outside that range the weekly rule does not fire (a bounded recurrence must
  // not recur forever).
  if (now < w.startsAt || now >= w.endsAt) return false;

  if (r.type !== "weekly") return false;
  if (r.durationMinutes <= 0) return false;

  const d = new Date(now);
  const nowMinuteOfWeek =
    d.getUTCDay() * 1440 +
    d.getUTCHours() * 60 +
    d.getUTCMinutes() +
    d.getUTCSeconds() / 60 +
    d.getUTCMilliseconds() / 60000;

  const [hStr, mStr] = r.start.split(":");
  const startHour = Number(hStr);
  const startMinute = Number(mStr);
  if (!Number.isFinite(startHour) || !Number.isFinite(startMinute)) return false;

  const startMinuteOfWeek = r.weekday * 1440 + startHour * 60 + startMinute;

  // Offset from window start, normalized to [0, MINUTES_PER_WEEK).
  const offset =
    (((nowMinuteOfWeek - startMinuteOfWeek) % MINUTES_PER_WEEK) +
      MINUTES_PER_WEEK) %
    MINUTES_PER_WEEK;

  return offset < r.durationMinutes;
}

/**
 * For a weekly recurring window, the next occurrence STRICTLY AFTER `now` that
 * still falls within the window's [startsAt, endsAt) validity range - or null if
 * there is none (not weekly, zero duration, malformed start, or no future
 * occurrence before the range ends). Returns the occurrence's absolute start/end
 * in epoch ms, used to surface recurring windows in the public "upcoming" list.
 */
export function nextRecurringOccurrence(
  w: ScheduledWindow,
  now: number,
): { startsAt: number; endsAt: number } | null {
  const r = w.recurrence;
  if (r == null || r.type !== "weekly" || r.durationMinutes <= 0) return null;

  const [hStr, mStr] = r.start.split(":");
  const startHour = Number(hStr);
  const startMinute = Number(mStr);
  if (!Number.isFinite(startHour) || !Number.isFinite(startMinute)) return null;

  const startMinuteOfWeek = r.weekday * 1440 + startHour * 60 + startMinute;

  // Reference point: if the validity range opens in the future, the first valid
  // occurrence is the first rule-match at/after startsAt; otherwise it's the
  // first match strictly after now.
  const ref = Math.max(now, w.startsAt - 1);
  const d = new Date(ref);
  const refMinuteOfWeek =
    d.getUTCDay() * 1440 +
    d.getUTCHours() * 60 +
    d.getUTCMinutes() +
    d.getUTCSeconds() / 60 +
    d.getUTCMilliseconds() / 60000;

  let delta =
    (((startMinuteOfWeek - refMinuteOfWeek) % MINUTES_PER_WEEK) +
      MINUTES_PER_WEEK) %
    MINUTES_PER_WEEK;
  if (delta === 0) delta = MINUTES_PER_WEEK; // ref sits exactly on a slot → next week

  const startsAt = ref + delta * 60_000;
  if (startsAt >= w.endsAt) return null; // beyond the validity range
  return { startsAt, endsAt: startsAt + r.durationMinutes * 60_000 };
}
