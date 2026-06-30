import type { Env } from "../types";
import { getSetting, setSetting } from "../db/settings";
import { getAdminEmail } from "../lib/admin";
import { sendResendEmail } from "./channels/resend";
import { listMonitors } from "../db/monitors";
import { escapeHtml, renderEmailLayout, renderEmailText } from "./email-layout";

/**
 * Weekly summary email (PRD §24). Opt-in and scheduler-driven: the cron caller
 * invokes {@link sendWeeklySummary} once per scheduled run, and this module
 * self-guards on the enabled flag, a resolvable recipient and a de-duplication
 * window so it never sends twice. Stats are aggregated from the finest ('hour')
 * `summaries` buckets plus `incidents`; rendering is pure so it can be unit
 * tested without D1. All timestamps are epoch milliseconds.
 */

export interface WeeklyStats {
  overallUptimePct: number;
  totalIncidents: number;
  totalDowntimeSeconds: number;
  avgResponseMs: number | null;
  slowestMonitor: { name: string; ms: number } | null;
  retryRecoveries: number;
  openIncidents: number;
  monitorsCount: number;
}

/** Default minimum gap between sends: 6.5 days, so a weekly cron never doubles up. */
const DEFAULT_MIN_INTERVAL_MS = 6.5 * 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_FROM = "OpenPing <onboarding@resend.dev>";

// ---------------------------------------------------------------------------
// Due check (pure)
// ---------------------------------------------------------------------------

/**
 * True when a weekly summary may be sent now: either it has never been sent
 * (`lastSentAt == null`) or at least `minIntervalMs` (default 6.5 days) has
 * elapsed since the last send. Cadence / day-of-week gating is the caller's
 * job; this only prevents duplicate sends within a single window.
 */
export function isWeeklyDue(
  now: number,
  lastSentAt: number | null,
  opts?: { minIntervalMs?: number },
): boolean {
  if (lastSentAt == null) return true;
  const minIntervalMs = opts?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  return now - lastSentAt >= minIntervalMs;
}

// ---------------------------------------------------------------------------
// Rendering (pure)
// ---------------------------------------------------------------------------

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Format an uptime percentage for display: trim trailing zeros, max 2 dp. */
function formatPct(pct: number): string {
  const rounded = Math.round(pct * 100) / 100;
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(2).replace(/0+$/, "");
}

/** Human-friendly duration: "2h 5m", "45m", "30s", or "0s". */
function formatDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) return "0s";
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 && h === 0) parts.push(`${s}s`);
  return parts.length ? parts.join(" ") : "0s";
}

/** Format an epoch-ms instant as "Jun 22, 2026" in UTC (deterministic, no Intl). */
function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

// Single-quoted family name: interpolated into double-quoted style="" attrs.
const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * Render the weekly summary email. Pure: given the aggregated stats and a label
 * for the period it covers, returns subject + HTML + plain-text bodies. The
 * subject leads with the headline uptime, e.g. "OpenPing weekly summary —
 * 99.9% uptime". An optional `appUrl` adds an "Open OpenPing" CTA.
 */
export function buildWeeklyEmail(
  stats: WeeklyStats,
  periodLabel: string,
  appUrl?: string,
): { subject: string; html: string; text: string } {
  const uptime = formatPct(stats.overallUptimePct);
  const subject = `OpenPing weekly summary — ${uptime}% uptime`;

  const rows: Array<[label: string, value: string]> = [
    ["Overall uptime", `${uptime}%`],
    ["Monitors", String(stats.monitorsCount)],
    ["Incidents", String(stats.totalIncidents)],
    ["Open incidents", String(stats.openIncidents)],
    ["Total downtime", formatDuration(stats.totalDowntimeSeconds)],
    [
      "Avg response",
      stats.avgResponseMs != null ? `${stats.avgResponseMs} ms` : "—",
    ],
    ["Retry recoveries", String(stats.retryRecoveries)],
  ];
  if (stats.slowestMonitor) {
    rows.push([
      "Slowest monitor",
      `${stats.slowestMonitor.name} (${stats.slowestMonitor.ms} ms)`,
    ]);
  }

  const htmlRows = rows
    .map(
      ([label, value], i) => {
        const border = i === 0 ? "" : "border-top:1px solid #eef2f7;";
        return (
          `<tr><td style="${border}padding:9px 0;font-family:${FONT};font-size:14px;color:#5f6f87;">${escapeHtml(label)}</td>` +
          `<td style="${border}padding:9px 0;font-family:${FONT};font-size:14px;font-weight:600;color:#16233a;text-align:right;">${escapeHtml(value)}</td></tr>`
        );
      },
    )
    .join("");

  const bodyHtml =
    `<p style="margin:0 0 16px;font-family:${FONT};font-size:13px;color:#5f6f87;">${escapeHtml(periodLabel)}</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#f7f9fc;border:1px solid #e3e9f2;border-radius:12px;padding:6px 18px;margin:0 0 18px;"><tr>` +
    `<td style="padding:14px 0 12px;font-family:${FONT};font-size:13px;color:#5f6f87;text-transform:uppercase;letter-spacing:0.06em;">Overall uptime</td>` +
    `<td style="padding:14px 0 12px;font-family:${FONT};font-size:30px;font-weight:700;color:#4f6bf0;text-align:right;line-height:1;">${uptime}%</td>` +
    `</tr></table>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;">${htmlRows}</table>`;

  const html = renderEmailLayout({
    heading: "Weekly summary",
    accent: "neutral",
    bodyHtml,
    button: appUrl ? { label: "Open OpenPing", url: appUrl } : undefined,
    preheader: `${uptime}% uptime · ${periodLabel}`,
  });

  const text = renderEmailText({
    heading: "OpenPing weekly summary",
    lines: [periodLabel, "", ...rows.map(([label, value]) => `${label}: ${value}`)],
    button: appUrl ? { label: "Open OpenPing", url: appUrl } : undefined,
  });

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Summary aggregate across all monitors over the window (finest 'hour' buckets). */
interface SummaryAggRow {
  checks: number | null;
  ok_checks: number | null;
  sum_latency: number | null;
  retry_recoveries: number | null;
}

/** Peak-latency-per-monitor row, used to find the slowest monitor. */
interface SlowestRow {
  monitor_id: string;
  max_ms: number | null;
}

/** Minimal incident shape needed for downtime accounting. */
interface IncidentAggRow {
  status: string;
  started_at: number;
  resolved_at: number | null;
  duration_seconds: number | null;
}

/**
 * Aggregate the past-week stats from D1 over the window [sinceMs, now].
 *
 * - Uptime / latency / retry recoveries come from `summaries` (period='hour',
 *   bucket_start >= sinceMs): uptime = sum(ok_checks)/sum(checks)*100 (100 when
 *   there were no checks); avgResponseMs = sum(sum_latency)/sum(ok_checks)
 *   rounded (null when nothing succeeded); slowestMonitor = the monitor with
 *   the highest max_latency_ms in the window, named via {@link listMonitors}.
 * - Incident counts / downtime come from `incidents` started in the window:
 *   resolved incidents contribute their duration_seconds, open incidents
 *   contribute (now - started_at) so far.
 */
export async function gatherWeeklyStats(
  env: Env,
  sinceMs: number,
  now: number,
): Promise<WeeklyStats> {
  const monitors = await listMonitors(env);
  const nameById = new Map(monitors.map((m) => [m.id, m.name]));

  const agg = await env.DB.prepare(
    `SELECT
        SUM(checks) AS checks,
        SUM(ok_checks) AS ok_checks,
        SUM(sum_latency_ms) AS sum_latency,
        SUM(retry_recoveries) AS retry_recoveries
       FROM summaries
      WHERE period = 'hour' AND bucket_start >= ?`,
  )
    .bind(sinceMs)
    .first<SummaryAggRow>();

  const checks = agg?.checks ?? 0;
  const okChecks = agg?.ok_checks ?? 0;
  const sumLatency = agg?.sum_latency ?? 0;
  const retryRecoveries = agg?.retry_recoveries ?? 0;

  const overallUptimePct = checks > 0 ? (okChecks / checks) * 100 : 100;
  // sum_latency_ms is accumulated for OK checks only (see rollups.okLatencyMs),
  // so dividing by ok_checks keeps the numerator and denominator consistent.
  const avgResponseMs = okChecks > 0 ? Math.round(sumLatency / okChecks) : null;

  const slow = await env.DB.prepare(
    `SELECT monitor_id, MAX(max_latency_ms) AS max_ms
       FROM summaries
      WHERE period = 'hour' AND bucket_start >= ? AND max_latency_ms IS NOT NULL
      GROUP BY monitor_id
      ORDER BY max_ms DESC
      LIMIT 1`,
  )
    .bind(sinceMs)
    .first<SlowestRow>();

  let slowestMonitor: { name: string; ms: number } | null = null;
  if (slow && slow.max_ms != null) {
    slowestMonitor = {
      name: nameById.get(slow.monitor_id) ?? slow.monitor_id,
      ms: slow.max_ms,
    };
  }

  const incRes = await env.DB.prepare(
    `SELECT status, started_at, resolved_at, duration_seconds
       FROM incidents
      WHERE started_at >= ?`,
  )
    .bind(sinceMs)
    .all<IncidentAggRow>();

  const incidents = incRes.results ?? [];
  let totalDowntimeSeconds = 0;
  let openIncidents = 0;
  for (const inc of incidents) {
    if (inc.status === "open") {
      openIncidents += 1;
      totalDowntimeSeconds += Math.max(0, Math.floor((now - inc.started_at) / 1000));
    } else {
      totalDowntimeSeconds +=
        inc.duration_seconds ??
        Math.max(0, Math.floor(((inc.resolved_at ?? now) - inc.started_at) / 1000));
    }
  }

  return {
    overallUptimePct,
    totalIncidents: incidents.length,
    totalDowntimeSeconds,
    avgResponseMs,
    slowestMonitor,
    retryRecoveries,
    openIncidents,
    monitorsCount: monitors.length,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Send the weekly summary if it is enabled, has a recipient and is due. Safe to
 * call once per scheduled run: it self-guards and records the send timestamp so
 * a weekly cron never sends more than one summary per window.
 *
 * Returns `{ sent: true }` on success, otherwise `{ sent: false, reason }` with
 * one of: "disabled", "no_recipient", "not_due", or a delivery error string.
 */
export async function sendWeeklySummary(
  env: Env,
  now: number,
): Promise<{ sent: boolean; reason?: string }> {
  const enabled = await getSetting(env, "weekly_summary_enabled");
  if (enabled !== "true") return { sent: false, reason: "disabled" };

  const recipient = await getAdminEmail(env);
  if (!recipient) return { sent: false, reason: "no_recipient" };

  // Anchor to a target weekday + hour (UTC) so the summary actually lands once a
  // week at a predictable time, instead of firing immediately on first enable
  // and then drifting ~12h earlier each week. Defaults to Monday 09:00 UTC.
  // Read the raw string first: Number(null) === 0 would make an UNSET setting
  // look like a valid in-range value (Sunday / midnight) and silently defeat the
  // documented Monday-09:00 defaults. Only coerce when a value is actually set.
  const rawDayStr = await getSetting(env, "weekly_summary_day");
  const rawDay = rawDayStr == null || rawDayStr === "" ? NaN : Number(rawDayStr);
  const targetDay =
    Number.isInteger(rawDay) && rawDay >= 0 && rawDay <= 6 ? rawDay : 1;
  const rawHourStr = await getSetting(env, "weekly_summary_hour");
  const rawHour = rawHourStr == null || rawHourStr === "" ? NaN : Number(rawHourStr);
  const targetHour =
    Number.isInteger(rawHour) && rawHour >= 0 && rawHour <= 23 ? rawHour : 9;
  const d = new Date(now);
  if (d.getUTCDay() !== targetDay || d.getUTCHours() < targetHour) {
    return { sent: false, reason: "not_due" };
  }

  // De-dup within the open day/hour window so it sends at most once per week.
  const lastSentAt = Number(await getSetting(env, "weekly_summary_last_sent")) || null;
  if (!isWeeklyDue(now, lastSentAt)) return { sent: false, reason: "not_due" };

  const sinceMs = now - WEEK_MS;
  const stats = await gatherWeeklyStats(env, sinceMs, now);
  const periodLabel = `${formatDate(sinceMs)} – ${formatDate(now)}`;
  // CTA base URL: env > settings (same precedence as the rest of the app).
  const configuredUrl = env.APP_URL ?? (await getSetting(env, "app_url"));
  const appUrl = configuredUrl ? configuredUrl.replace(/\/$/, "") : undefined;
  const email = buildWeeklyEmail(stats, periodLabel, appUrl);

  const from = (await getSetting(env, "email_from")) ?? DEFAULT_FROM;

  const result = await sendResendEmail(env, {
    from,
    to: recipient,
    subject: email.subject,
    html: email.html,
    text: email.text,
  });

  if (!result.ok) {
    return { sent: false, reason: result.error ?? "send_failed" };
  }

  await setSetting(env, "weekly_summary_last_sent", String(now));
  return { sent: true };
}
