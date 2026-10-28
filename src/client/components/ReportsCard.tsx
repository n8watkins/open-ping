import { useMemo, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { api } from "../lib/api";
import { useFetch } from "../lib/useFetch";
import { formatMs } from "../lib/format";
import { Card, CardHeader, CardTitle } from "./ui/Card";

/** One row of GET /api/reports/monthly (src/worker/reports/monthly.ts). */
interface ReportFigures {
  uptimePct: number | null;
  checks: number;
  failedChecks: number;
  downtimeMinutes: number;
  monitoredMinutes: number;
  incidents: number;
  avgResponseMs: number | null;
}
interface ReportMonitor extends ReportFigures {
  id: string;
  name: string;
  type: string;
}
interface MonthlyReportResponse {
  report: {
    month: string;
    timezone: string;
    partial: boolean;
    monitors: ReportMonitor[];
    totals: ReportFigures;
  };
}

/** The last 13 calendar months, newest first, as "YYYY-MM" (this one included). */
export function recentMonths(now: Date = new Date(), count = 13): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(y!, m! - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function pct(v: number | null): string {
  return v == null ? "No data" : `${Number(v.toFixed(3))}%`;
}

function minutes(v: number): string {
  if (v < 60) return `${Number(v.toFixed(1))} min`;
  const h = Math.floor(v / 60);
  const m = Math.round(v % 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

/**
 * Settings > Reports: the monthly uptime report for a chosen month, as a
 * table and a CSV download, and the opt-in monthly report email.
 */
export function ReportsCard({
  emailEnabled,
  csrf,
  onSaved,
}: {
  emailEnabled: boolean;
  csrf: string | undefined;
  onSaved: () => void;
}) {
  const months = useMemo(() => recentMonths(), []);
  // Default to last month, the one a report is usually for.
  const [month, setMonth] = useState(months[1]!);
  const { data, loading, error } = useFetch<MonthlyReportResponse>(
    `/api/reports/monthly?month=${month}`,
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function toggleEmail(next: boolean) {
    setSaving(true);
    setSaveError(null);
    try {
      await api("/api/settings", {
        method: "PUT",
        csrf,
        json: { settings: { monthly_report_enabled: next ? "true" : "false" } },
      });
      onSaved();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  const report = data?.report;
  const csvHref = `/api/reports/monthly?month=${month}&format=csv`;

  return (
    <section id="reports" className="scroll-mt-6">
      <Card className="p-5">
        <CardHeader>
          <CardTitle>Monthly uptime report</CardTitle>
        </CardHeader>
        <p className="-mt-1 mb-4 text-sm text-ink-muted">
          Uptime, downtime, incidents and response time per monitor for a calendar month in the
          install&apos;s timezone. Off-hours are never counted as downtime.
        </p>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <select
            className="input sm:w-56"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            name="report-month"
            aria-label="Report month"
          >
            {months.map((m, i) => (
              <option key={m} value={m}>
                {monthName(m)}
                {i === 0 ? " (so far)" : ""}
              </option>
            ))}
          </select>
          <a
            href={csvHref}
            download={`openping-uptime-${month}.csv`}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <Download className="size-4" />
            Download CSV
          </a>
          {loading && <Loader2 className="size-4 animate-spin text-ink-faint" />}
        </div>

        {error && (
          <p className="mt-4 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
            Could not load the report: {error}
          </p>
        )}

        {report && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">
                Uptime report for {monthName(report.month)} ({report.timezone})
              </caption>
              <thead>
                <tr className="border-b border-line text-left text-xs text-ink-faint">
                  <th scope="col" className="py-2 pr-3 font-medium">Monitor</th>
                  <th scope="col" className="py-2 px-2 sm:px-3 text-right font-medium">Uptime</th>
                  <th scope="col" className="py-2 px-2 sm:px-3 text-right font-medium">Downtime</th>
                  <th scope="col" className="py-2 pl-2 sm:px-3 text-right font-medium">Incidents</th>
                  <th scope="col" className="hidden py-2 pl-3 text-right font-medium sm:table-cell">Avg response</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {report.monitors.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-3 text-ink-faint">
                      No monitors in this month.
                    </td>
                  </tr>
                )}
                {report.monitors.map((m) => (
                  <tr key={m.id}>
                    <th scope="row" className="max-w-[9rem] truncate py-2 pr-3 text-left font-normal text-ink sm:max-w-[16rem]">
                      {m.name}
                    </th>
                    <td className="py-2 px-2 sm:px-3 text-right tabular-nums text-ink">{pct(m.uptimePct)}</td>
                    <td className="py-2 px-2 sm:px-3 text-right tabular-nums text-ink-muted">{minutes(m.downtimeMinutes)}</td>
                    <td className="py-2 pl-2 sm:px-3 text-right tabular-nums text-ink-muted">{m.incidents}</td>
                    <td className="hidden py-2 pl-3 text-right tabular-nums text-ink-muted sm:table-cell">{formatMs(m.avgResponseMs)}</td>
                  </tr>
                ))}
              </tbody>
              {report.monitors.length > 0 && (
                <tfoot>
                  <tr className="border-t border-line font-medium">
                    <th scope="row" className="py-2 pr-3 text-left text-ink">All monitors</th>
                    <td className="py-2 px-2 sm:px-3 text-right tabular-nums text-ink">{pct(report.totals.uptimePct)}</td>
                    <td className="py-2 px-2 sm:px-3 text-right tabular-nums text-ink-muted">{minutes(report.totals.downtimeMinutes)}</td>
                    <td className="py-2 pl-2 sm:px-3 text-right tabular-nums text-ink-muted">{report.totals.incidents}</td>
                    <td className="hidden py-2 pl-3 text-right tabular-nums text-ink-muted sm:table-cell">{formatMs(report.totals.avgResponseMs)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
            <p className="mt-2 text-xs text-ink-faint">
              {report.timezone}
              {report.partial ? " · this month so far" : ""}
            </p>
          </div>
        )}

        <label className="mt-5 flex items-start gap-2.5 border-t border-line pt-4 text-sm">
          <input
            type="checkbox"
            name="monthly-report-email"
            checked={emailEnabled}
            disabled={saving}
            onChange={(e) => void toggleEmail(e.target.checked)}
            className="mt-0.5 size-4 rounded border-line bg-surface-2 accent-accent"
          />
          <span>
            <span className="text-ink">Email me this report every month</span>
            <span className="block text-xs text-ink-faint">
              Sent on the 1st, from 09:00 in the install&apos;s timezone, to the admin email. A
              report that can&apos;t go out then is retried hourly. Needs RESEND_API_KEY.
            </span>
          </span>
          {saving && <Loader2 className="size-4 animate-spin text-ink-faint" />}
        </label>
        {saveError && <p className="mt-2 text-xs text-down">{saveError}</p>}
      </Card>
    </section>
  );
}
