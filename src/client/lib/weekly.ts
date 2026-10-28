/**
 * When a weekly summary set for `day` and `hour` (UTC, as the scheduler reads
 * them, notifications/weekly.ts) lands in `timeZone`: "Monday 2:00 AM".
 */
export function weeklyLocalTime(day: number, hour: number, timeZone: string, locale?: string): string {
  // 2026-01-04 was a Sunday, so day d is the 4th plus d.
  const at = new Date(Date.UTC(2026, 0, 4 + day, hour));
  try {
    return new Intl.DateTimeFormat(locale, { weekday: "long", hour: "numeric", minute: "2-digit", timeZone }).format(at);
  } catch {
    return "";
  }
}
