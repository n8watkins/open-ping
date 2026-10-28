import { DateTime } from "luxon";
import type { Env } from "../types";
import { setSetting, settingsFromRows, settingsStatement } from "../db/settings";
import type { RetentionConfig } from "../history/rollups";
import { sendResendEmail } from "./channels/resend";
import { escapeHtml, renderEmailLayout, renderEmailText } from "./email-layout";
import {
  monthBounds,
  previousMonth,
  reportFromResults,
  reportStatements,
  safeZone,
  type MonthlyReport,
} from "../reports/monthly";

/**
 * Monthly uptime report email (opt-in, `monthly_report_enabled`). The
 * scheduler calls {@link sendMonthlyReport} once per run, like the weekly
 * summary. It sends on the 1st of the month, from 09:00 in the install's
 * timezone, the report for the month that just ended, at most once per month
 * (`monthly_report_last_sent` holds the month it last sent).
 *
 * A run where it isn't due costs no D1 queries (the gate settings come from
 * the scheduler's first round trip). A run that sends costs two: one batch for
 * the report and the sender settings, and one to record the send.
 */

/** The settings the gate reads; the scheduler loads them up front. */
export const MONTHLY_GATE_SETTINGS = [
  "monthly_report_enabled",
  "monthly_report_last_sent",
  "timezone",
  "admin_email",
] as const;

/** Local hour on the 1st from which the report goes out. */
const SEND_HOUR = 9;
const DEFAULT_FROM = "OpenPing <onboarding@resend.dev>";

/**
 * The month to report on if a report is due at `now`, else null: it is the
 * 1st in `zone`, at or after 09:00, and last month's report hasn't been sent.
 */
export function monthlyReportDue(now: number, zone: string, lastSent: string | null): string | null {
  const local = DateTime.fromMillis(now, { zone: safeZone(zone) });
  if (local.day !== 1 || local.hour < SEND_HOUR) return null;
  const month = previousMonth(now, zone);
  return lastSent === month ? null : month;
}

/** "October 2026" for "2026-10". */
export function monthLabel(month: string): string {
  return DateTime.fromFormat(month, "yyyy-MM", { zone: "utc" }).toFormat("LLLL yyyy");
}

/** "99.95%" (trailing zeros trimmed) or "No data". */
function pctText(pct: number | null): string {
  return pct == null ? "No data" : `${Number(pct.toFixed(2))}%`;
}

/** "0 min", "36 min", "2 h 5 min". */
function minutesText(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
/** Most monitors listed in the email body; the CSV always has them all. */
const MAX_EMAIL_ROWS = 50;

/**
 * Render the report email. Pure. `appUrl` adds a button to download the CSV
 * (it opens in the admin's signed-in browser).
 */
export function buildMonthlyEmail(
  report: MonthlyReport,
  appUrl?: string,
): { subject: string; html: string; text: string } {
  const label = monthLabel(report.month);
  const overall = pctText(report.totals.uptimePct);
  const subject = `OpenPing uptime report for ${label}: ${overall}`;
  const period = `${label} (${report.timezone})`;
  const shown = report.monitors.slice(0, MAX_EMAIL_ROWS);
  const more = report.monitors.length - shown.length;

  const cell = (v: string, align: "left" | "right", bold = false) =>
    `<td style="border-top:1px solid #eef2f7;padding:8px 0 8px 8px;font-family:${FONT};font-size:13px;` +
    `color:${bold ? "#16233a" : "#5f6f87"};${bold ? "font-weight:600;" : ""}text-align:${align};">${escapeHtml(v)}</td>`;
  const head = (v: string, align: "left" | "right") =>
    `<th style="padding:0 0 6px 8px;font-family:${FONT};font-size:11px;font-weight:600;color:#5f6f87;` +
    `text-transform:uppercase;letter-spacing:0.05em;text-align:${align};">${v}</th>`;
  const rowsHtml = shown
    .map(
      (m) =>
        `<tr>${cell(m.name, "left", true)}${cell(pctText(m.uptimePct), "right", true)}` +
        `${cell(minutesText(m.downtimeMinutes), "right")}${cell(String(m.incidents), "right")}` +
        `${cell(m.avgResponseMs == null ? "-" : `${m.avgResponseMs} ms`, "right")}</tr>`,
    )
    .join("");

  const bodyHtml =
    `<p style="margin:0 0 16px;font-family:${FONT};font-size:13px;color:#5f6f87;">${escapeHtml(period)}</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#f7f9fc;border:1px solid #e3e9f2;border-radius:12px;padding:6px 18px;margin:0 0 18px;"><tr>` +
    `<td style="padding:14px 0 12px;font-family:${FONT};font-size:13px;color:#5f6f87;text-transform:uppercase;letter-spacing:0.06em;">Overall uptime</td>` +
    `<td style="padding:14px 0 12px;font-family:${FONT};font-size:30px;font-weight:700;color:#4f6bf0;text-align:right;line-height:1;">${escapeHtml(overall)}</td>` +
    `</tr></table>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;">` +
    `<tr>${head("Monitor", "left")}${head("Uptime", "right")}${head("Down", "right")}${head("Incidents", "right")}${head("Avg", "right")}</tr>` +
    rowsHtml +
    `</table>` +
    (more > 0
      ? `<p style="margin:12px 0 0;font-family:${FONT};font-size:13px;color:#5f6f87;">And ${more} more in the CSV.</p>`
      : "") +
    `<p style="margin:16px 0 0;font-family:${FONT};font-size:12px;color:#5f6f87;">Off-hours are never counted as downtime. ` +
    `${report.totals.incidents} incident(s), ${escapeHtml(minutesText(report.totals.downtimeMinutes))} of downtime in total.</p>`;

  const button = appUrl
    ? {
        label: "Download the CSV",
        url: `${appUrl}/api/reports/monthly?month=${report.month}&format=csv`,
      }
    : undefined;

  const html = renderEmailLayout({
    heading: "Monthly uptime report",
    accent: "neutral",
    bodyHtml,
    button,
    preheader: `${overall} uptime in ${label}`,
  });
  const text = renderEmailText({
    heading: `OpenPing uptime report for ${label}`,
    lines: [
      period,
      `Overall uptime: ${overall}`,
      "",
      ...shown.map(
        (m) =>
          `${m.name}: ${pctText(m.uptimePct)}, ${minutesText(m.downtimeMinutes)} down, ${m.incidents} incident(s), ` +
          `avg ${m.avgResponseMs == null ? "-" : `${m.avgResponseMs} ms`}`,
      ),
      ...(more > 0 ? [`And ${more} more in the CSV.`] : []),
      "",
      "Off-hours are never counted as downtime.",
    ],
    button,
  });
  return { subject, html, text };
}

/**
 * Send last month's report if it is enabled, has a recipient and is due.
 * Returns `{ sent: true }`, or `{ sent: false, reason }` with "disabled",
 * "no_recipient", "not_due" or a delivery error.
 */
export async function sendMonthlyReport(
  env: Env,
  now: number,
  settings: ReadonlyMap<string, string | null>,
  retention: RetentionConfig,
): Promise<{ sent: boolean; reason?: string }> {
  if (settings.get("monthly_report_enabled") !== "true") return { sent: false, reason: "disabled" };
  const recipient = env.ADMIN_EMAIL ?? settings.get("admin_email") ?? null;
  if (!recipient) return { sent: false, reason: "no_recipient" };
  const zone = safeZone(settings.get("timezone"));
  const month = monthlyReportDue(now, zone, settings.get("monthly_report_last_sent") ?? null);
  if (!month) return { sent: false, reason: "not_due" };

  // One round trip: the report's three queries and the sender settings.
  const bounds = monthBounds(month, zone);
  const senderKeys = ["app_url", "email_from"] as const;
  const results = await env.DB.batch([
    ...reportStatements(env, bounds, now, retention),
    settingsStatement(env, senderKeys),
  ]);
  const report = reportFromResults(bounds, now, results);
  const sender = await settingsFromRows(
    env,
    senderKeys,
    (results[3]?.results ?? []) as Parameters<typeof settingsFromRows>[2],
  );

  const configuredUrl = env.APP_URL ?? sender.get("app_url");
  const appUrl = configuredUrl ? configuredUrl.replace(/\/$/, "") : undefined;
  const email = buildMonthlyEmail(report, appUrl);
  const result = await sendResendEmail(env, {
    from: sender.get("email_from") ?? DEFAULT_FROM,
    to: recipient,
    subject: email.subject,
    html: email.html,
    text: email.text,
  });
  if (!result.ok) return { sent: false, reason: result.error ?? "send_failed" };
  await setSetting(env, "monthly_report_last_sent", month);
  return { sent: true };
}
