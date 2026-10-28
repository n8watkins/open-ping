/**
 * Date-range presets for the Incidents filter. PURE. The page keeps the range
 * as two "YYYY-MM-DD" strings (the date inputs' value format, local time);
 * an empty string means "open-ended".
 */

export type RangePreset = "all" | "month" | "30d" | "90d";

export const RANGE_PRESETS: { value: RangePreset; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "month", label: "This month" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
];

function ymd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The from/to strings a preset stands for, relative to `now` (local time). */
export function presetRange(preset: RangePreset, now: number = Date.now()): { from: string; to: string } {
  const today = new Date(now);
  if (preset === "all") return { from: "", to: "" };
  if (preset === "month") {
    return { from: ymd(new Date(today.getFullYear(), today.getMonth(), 1)), to: "" };
  }
  const days = preset === "30d" ? 29 : 89; // inclusive of today
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - days);
  return { from: ymd(start), to: "" };
}

/** The preset a from/to pair matches, or null for a custom range. */
export function matchPreset(from: string, to: string, now: number = Date.now()): RangePreset | null {
  for (const { value } of RANGE_PRESETS) {
    const r = presetRange(value, now);
    if (r.from === from && r.to === to) return value;
  }
  return null;
}

function shortDate(value: string, locale?: string): string {
  const [y, m, d] = value.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", year: "numeric" }).format(
    new Date(y!, (m ?? 1) - 1, d ?? 1),
  );
}

/** "This month", "Last 30 days", "Since Oct 1, 2026", "Oct 1, 2026 to Oct 14, 2026"... */
export function rangeLabel(from: string, to: string, now: number = Date.now(), locale?: string): string {
  const preset = matchPreset(from, to, now);
  if (preset) return RANGE_PRESETS.find((p) => p.value === preset)!.label;
  if (from && to) return `${shortDate(from, locale)} to ${shortDate(to, locale)}`;
  if (from) return `Since ${shortDate(from, locale)}`;
  return `Until ${shortDate(to, locale)}`;
}
