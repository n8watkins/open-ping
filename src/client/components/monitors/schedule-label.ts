/**
 * A short label for a monitor's check schedule, for the Monitors list:
 * "24/7", "Weekdays 8-5", "Mon-Sat 9-6:30", "Weekends 8 pm-2 am",
 * "Custom hours". PURE.
 */

import type { Schedule } from "../../../shared/schemas";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Weekday numbers (0 = Sunday) as compact text; runs of three or more collapse. */
export function weekdaysLabel(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const key = sorted.join(",");
  if (key === "0,1,2,3,4,5,6") return "Every day";
  if (key === "1,2,3,4,5") return "Weekdays";
  if (key === "0,6") return "Weekends";
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    if (j - i >= 2) parts.push(`${DAY_NAMES[sorted[i]!]}-${DAY_NAMES[sorted[j]!]}`);
    else for (let k = i; k <= j; k++) parts.push(DAY_NAMES[sorted[k]!]!);
    i = j + 1;
  }
  return parts.join(", ");
}

function clock(hhmm: string): { h12: number; minutes: string; pm: boolean } {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  return { h12: h % 12 === 0 ? 12 : h % 12, minutes: m ? `:${String(m).padStart(2, "0")}` : "", pm: h >= 12 };
}

/**
 * A time range in 12-hour form. The office-hours case (morning start, afternoon
 * end) drops am/pm, as people say it: "8-5". Anything else spells them out.
 */
export function hoursLabel(start: string, end: string): string {
  const a = clock(start);
  const b = clock(end);
  if (!a.pm && b.pm && end > start) {
    return `${a.h12}${a.minutes}-${b.h12}${b.minutes}`;
  }
  const fmt = (t: ReturnType<typeof clock>) => `${t.h12}${t.minutes} ${t.pm ? "pm" : "am"}`;
  return `${fmt(a)}-${fmt(b)}`;
}

export function scheduleLabel(schedule: Schedule | null | undefined): string {
  if (!schedule || schedule.mode === "always") return "24/7";
  if (schedule.mode === "business_hours") {
    if (schedule.start === schedule.end) return weekdaysLabel(schedule.weekdays);
    return `${weekdaysLabel(schedule.weekdays)} ${hoursLabel(schedule.start, schedule.end)}`;
  }
  return "Custom hours";
}

/** A full sentence for the label's tooltip, with the timezone. */
export function scheduleTitle(schedule: Schedule | null | undefined): string {
  if (!schedule || schedule.mode === "always") return "Checked around the clock";
  if (schedule.mode === "business_hours") {
    return `Checked ${scheduleLabel(schedule)} (${schedule.timezone}); off-hours never count as downtime`;
  }
  return `Checked on a custom weekly schedule (${schedule.timezone}); off-hours never count as downtime`;
}
