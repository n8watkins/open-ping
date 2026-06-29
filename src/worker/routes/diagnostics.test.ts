import { describe, it, expect } from "vitest";
import { estimateUsage } from "./diagnostics";

const base = {
  monitors: 0,
  intervalSeconds: 720,
  sampleRows: 0,
  summaryRows: 0,
  incidentRows: 0,
};

describe("estimateUsage", () => {
  it("always reports 120 scheduled executions/day (cron every 12 min)", () => {
    expect(estimateUsage(base).scheduledExecutionsPerDay).toBe(120);
    expect(
      estimateUsage({ ...base, monitors: 50, intervalSeconds: 60 })
        .scheduledExecutionsPerDay,
    ).toBe(120);
  });

  it("computes httpChecksPerDay as monitors * (86400/intervalSeconds)", () => {
    // 10 monitors at the 720s default => 10 * 120 = 1200.
    expect(
      estimateUsage({ ...base, monitors: 10, intervalSeconds: 720 })
        .httpChecksPerDay,
    ).toBe(1200);
    // 5 monitors every 300s => 5 * 288 = 1440.
    expect(
      estimateUsage({ ...base, monitors: 5, intervalSeconds: 300 })
        .httpChecksPerDay,
    ).toBe(1440);
    // 1 monitor once a day => 1.
    expect(
      estimateUsage({ ...base, monitors: 1, intervalSeconds: 86400 })
        .httpChecksPerDay,
    ).toBe(1);
  });

  it("falls back to the default interval when intervalSeconds is non-positive", () => {
    expect(
      estimateUsage({ ...base, monitors: 2, intervalSeconds: 0 })
        .httpChecksPerDay,
    ).toBe(2 * (86400 / 720));
    expect(
      estimateUsage({ ...base, monitors: 2, intervalSeconds: -5 })
        .httpChecksPerDay,
    ).toBe(240);
  });

  it("estimates DB bytes as (samples + summaries + incidents) * ~256 and scales with rows", () => {
    const small = estimateUsage({
      ...base,
      sampleRows: 1,
      summaryRows: 1,
      incidentRows: 1,
    });
    expect(small.estimatedDbBytes).toBe(3 * 256);

    const large = estimateUsage({
      ...base,
      sampleRows: 10,
      summaryRows: 10,
      incidentRows: 10,
    });
    expect(large.estimatedDbBytes).toBe(30 * 256);
    expect(large.estimatedDbBytes).toBeGreaterThan(small.estimatedDbBytes);
  });

  it("scales rough read/write estimates with check volume", () => {
    const idle = estimateUsage(base);
    const busy = estimateUsage({ ...base, monitors: 100, intervalSeconds: 60 });
    expect(busy.httpChecksPerDay).toBeGreaterThan(idle.httpChecksPerDay);
    expect(busy.dbReadsPerDayEstimate).toBeGreaterThan(
      idle.dbReadsPerDayEstimate,
    );
    expect(busy.dbWritesPerDayEstimate).toBeGreaterThan(
      idle.dbWritesPerDayEstimate,
    );
  });

  it("includes a note clarifying these are estimates only", () => {
    const out = estimateUsage(base);
    expect(typeof out.note).toBe("string");
    expect(out.note.length).toBeGreaterThan(0);
    expect(out.note).toContain("estimates only");
    expect(out.note).toContain("Cloudflare");
  });
});
