import { Hono } from "hono";
import type { AppEnv, Env } from "../types";
import { requireAuth } from "../middleware/auth";
import { getSetting, parseJSONSetting } from "../db/settings";
import { resolveRetention, type RetentionConfig } from "../history/rollups";
import {
  buildMonthlyReport,
  currentMonth,
  isMonth,
  previousMonth,
  reportToCsv,
  safeZone,
  type MonthlyReport,
} from "../reports/monthly";

/**
 * Reports API mounted at /api/reports (admin session or the API token).
 *
 *   GET /api/reports/monthly?month=YYYY-MM&format=json|csv
 *
 * `month` defaults to the previous calendar month in the install's timezone;
 * a month that hasn't started yet is rejected, and the current month is
 * allowed (reported so far, `partial: true`). See reports/monthly.ts.
 */
export const reports = new Hono<AppEnv>();
reports.use("*", requireAuth);

/**
 * Validate `month` and build its report with the install's timezone and
 * retention. Shared by the REST route, the MCP tool and the monthly email.
 */
export async function monthlyReportFor(
  env: Env,
  month: string | undefined,
  now: number = Date.now(),
): Promise<{ ok: true; report: MonthlyReport } | { ok: false; message: string }> {
  const [tz, retentionRaw] = await Promise.all([getSetting(env, "timezone"), getSetting(env, "retention")]);
  const zone = safeZone(tz);
  const target = month ?? previousMonth(now, zone);
  if (!isMonth(target)) return { ok: false, message: "month must be YYYY-MM, from 2000-01 on." };
  if (target > currentMonth(now, zone)) {
    return { ok: false, message: `${target} hasn't started yet in ${zone}.` };
  }
  const retention: RetentionConfig = resolveRetention(parseJSONSetting<Partial<RetentionConfig>>(retentionRaw));
  return { ok: true, report: await buildMonthlyReport(env, target, zone, retention, now) };
}

reports.get("/monthly", async (c) => {
  const format = c.req.query("format") ?? "json";
  if (format !== "json" && format !== "csv") {
    return c.json({ error: "validation", message: "format must be json or csv." }, 400);
  }
  const r = await monthlyReportFor(c.env, c.req.query("month") || undefined);
  if (!r.ok) return c.json({ error: "validation", message: r.message }, 400);
  c.header("Cache-Control", "no-store");
  if (format === "csv") {
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="openping-uptime-${r.report.month}.csv"`);
    return c.body(reportToCsv(r.report));
  }
  return c.json({ report: r.report });
});
