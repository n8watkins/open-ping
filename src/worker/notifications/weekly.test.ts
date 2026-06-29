import { describe, it, expect } from "vitest";
import { buildWeeklyEmail, isWeeklyDue, type WeeklyStats } from "./weekly";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000; // fixed reference "now"

const baseStats: WeeklyStats = {
  overallUptimePct: 99.9,
  totalIncidents: 3,
  totalDowntimeSeconds: 7_320, // 2h 2m
  avgResponseMs: 142,
  slowestMonitor: { name: "API <prod>", ms: 980 },
  retryRecoveries: 5,
  openIncidents: 1,
  monitorsCount: 8,
};

describe("buildWeeklyEmail (pure)", () => {
  it("puts the uptime % in the subject", () => {
    const { subject } = buildWeeklyEmail(baseStats, "Jun 22, 2026 – Jun 29, 2026");
    expect(subject).toContain("99.9%");
    expect(subject.toLowerCase()).toContain("uptime");
  });

  it("renders 100% uptime cleanly (no trailing decimals)", () => {
    const { subject } = buildWeeklyEmail(
      { ...baseStats, overallUptimePct: 100 },
      "period",
    );
    expect(subject).toContain("100% uptime");
    expect(subject).not.toContain("100.0");
  });

  it("produces non-empty html and text bodies that include the incident count", () => {
    const { html, text } = buildWeeklyEmail(baseStats, "this week");
    expect(html.length).toBeGreaterThan(0);
    expect(text.length).toBeGreaterThan(0);
    // Incident count surfaces in both renderings.
    expect(text).toContain("Incidents: 3");
    expect(html).toContain("3");
    // Period label is carried through.
    expect(text).toContain("this week");
    expect(html).toContain("this week");
  });

  it("escapes HTML in the slowest-monitor name", () => {
    const { html } = buildWeeklyEmail(baseStats, "period");
    expect(html).toContain("API &lt;prod&gt;");
    expect(html).not.toContain("API <prod>");
  });

  it("shows an em dash for a null average response time", () => {
    const { text } = buildWeeklyEmail(
      { ...baseStats, avgResponseMs: null },
      "period",
    );
    expect(text).toContain("Avg response: —");
  });
});

describe("isWeeklyDue (pure)", () => {
  it("is due when never sent (lastSentAt is null)", () => {
    expect(isWeeklyDue(NOW, null)).toBe(true);
  });

  it("is not due when sent recently (within the default 6.5d window)", () => {
    expect(isWeeklyDue(NOW, NOW - 1 * DAY_MS)).toBe(false);
    expect(isWeeklyDue(NOW, NOW - 6 * DAY_MS)).toBe(false);
  });

  it("is due when the last send is old enough (>= 6.5d)", () => {
    expect(isWeeklyDue(NOW, NOW - 7 * DAY_MS)).toBe(true);
  });

  it("honors a custom minIntervalMs", () => {
    const oneHour = 60 * 60 * 1000;
    expect(isWeeklyDue(NOW, NOW - 30 * 60 * 1000, { minIntervalMs: oneHour })).toBe(
      false,
    );
    expect(isWeeklyDue(NOW, NOW - 2 * oneHour, { minIntervalMs: oneHour })).toBe(
      true,
    );
  });

  it("is due exactly at the interval boundary", () => {
    expect(isWeeklyDue(NOW, NOW - 6.5 * DAY_MS)).toBe(true);
  });
});
