import { describe, expect, it } from "vitest";
import { buildMonthlyEmail, monthLabel, monthlyReportDue } from "./monthly";
import type { MonthlyReport } from "../reports/monthly";

const LA = "America/Los_Angeles";

describe("monthlyReportDue", () => {
  it("is due from 09:00 on the 1st in the install's timezone, for last month", () => {
    // 1 Dec 2026 09:00 PST is 17:00 UTC.
    expect(monthlyReportDue(Date.UTC(2026, 11, 1, 17), LA, null)).toBe("2026-11");
    expect(monthlyReportDue(Date.UTC(2026, 11, 1, 23), LA, "2026-10")).toBe("2026-11");
  });

  it("waits until 09:00, skips other days and never sends a month twice", () => {
    expect(monthlyReportDue(Date.UTC(2026, 11, 1, 16, 59), LA, null)).toBeNull();
    // 1 Dec 09:00 UTC is still 30 Nov in Los Angeles.
    expect(monthlyReportDue(Date.UTC(2026, 11, 1, 9), LA, null)).toBeNull();
    expect(monthlyReportDue(Date.UTC(2026, 11, 2, 17), LA, null)).toBeNull();
    expect(monthlyReportDue(Date.UTC(2026, 11, 1, 18), LA, "2026-11")).toBeNull();
    expect(monthlyReportDue(Date.UTC(2026, 11, 1, 9), "UTC", null)).toBe("2026-11");
  });
});

describe("buildMonthlyEmail", () => {
  const figures = { checks: 10, failedChecks: 1, downtimeMinutes: 12, monitoredMinutes: 120, incidents: 1, avgResponseMs: 210 };
  const report: MonthlyReport = {
    month: "2026-10",
    timezone: LA,
    from: 0,
    to: 1,
    partial: false,
    generatedAt: 2,
    monitors: [
      { id: "mon_1", name: "<b>API</b> & co", type: "http", uptimePct: 90, ...figures },
      { id: "mon_2", name: "Quiet", type: "dns", uptimePct: null, ...figures, avgResponseMs: null },
    ],
    totals: { uptimePct: 99.95, ...figures },
  };

  it("leads with the overall uptime and lists every monitor, escaped", () => {
    const email = buildMonthlyEmail(report, "https://status.example.com");
    expect(monthLabel("2026-10")).toBe("October 2026");
    expect(email.subject).toBe("OpenPing uptime report for October 2026: 99.95%");
    expect(email.html).toContain("&lt;b&gt;API&lt;/b&gt; &amp; co");
    expect(email.html).not.toContain("<b>API</b>");
    expect(email.html).toContain("No data");
    expect(email.html).toContain("https://status.example.com/api/reports/monthly?month=2026-10&amp;format=csv");
    expect(email.text).toContain("<b>API</b> & co: 90%, 12 min down, 1 incident(s), avg 210 ms");
    expect(email.text).toContain("Quiet: No data");
  });
});
