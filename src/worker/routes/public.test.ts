import { describe, it, expect } from "vitest";
import {
  computeOverall,
  computeUptimeAndBars,
  type PublicServiceState,
} from "./public";

/** Tiny factory for a service with only the state field computeOverall reads. */
function svc(state: PublicServiceState): { state: PublicServiceState } {
  return { state };
}

describe("computeOverall", () => {
  it("returns all_off when there are no public services", () => {
    expect(computeOverall([], false)).toBe("all_off");
    // No services beats even an active maintenance window.
    expect(computeOverall([], true)).toBe("all_off");
  });

  it("returns operational when all services are up", () => {
    expect(computeOverall([svc("operational"), svc("operational")], false)).toBe(
      "operational",
    );
  });

  it("treats maintenance/scheduled_off/unknown as non-outage states", () => {
    expect(
      computeOverall(
        [
          svc("operational"),
          svc("maintenance"),
          svc("scheduled_off"),
          svc("unknown"),
        ],
        false,
      ),
    ).toBe("operational");
  });

  it("returns degraded when some services are degraded and none are down", () => {
    expect(computeOverall([svc("operational"), svc("degraded")], false)).toBe(
      "degraded",
    );
  });

  it("returns partial_outage when some (but not all) services are down", () => {
    expect(computeOverall([svc("operational"), svc("down")], false)).toBe(
      "partial_outage",
    );
    expect(computeOverall([svc("degraded"), svc("down")], false)).toBe(
      "partial_outage",
    );
  });

  it("returns major_outage when every service is down", () => {
    expect(computeOverall([svc("down")], false)).toBe("major_outage");
    expect(computeOverall([svc("down"), svc("down")], false)).toBe(
      "major_outage",
    );
  });

  it("returns maintenance when a window is active and there are no outages", () => {
    expect(computeOverall([svc("operational")], true)).toBe("maintenance");
    // Maintenance takes precedence over a merely-degraded service.
    expect(computeOverall([svc("operational"), svc("degraded")], true)).toBe(
      "maintenance",
    );
  });

  it("lets outages take precedence over an active maintenance window", () => {
    expect(computeOverall([svc("down")], true)).toBe("major_outage");
    expect(computeOverall([svc("operational"), svc("down")], true)).toBe(
      "partial_outage",
    );
  });
});

describe("computeUptimeAndBars", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 5, 29, 12, 0, 0); // 2026-06-29T12:00:00Z

  it("reports 100% and 90 empty bars when there is no data", () => {
    const { uptime90d, bars } = computeUptimeAndBars([], now);
    expect(uptime90d).toBe(100);
    expect(bars).toHaveLength(90);
    expect(bars.every((b) => b.uptimePct === null && b.state === "none")).toBe(
      true,
    );
    // Oldest first, newest (today) last.
    expect(bars[89].date).toBe("2026-06-29");
    expect(bars[0].date).toBe("2026-04-01");
  });

  it("computes uptime % and maps per-day bar state", () => {
    const today = Date.UTC(2026, 5, 29, 0, 0, 0);
    const rows = [
      { bucket_start: today, checks: 10, ok_checks: 10 }, // up
      { bucket_start: today - DAY, checks: 10, ok_checks: 5 }, // degraded
      { bucket_start: today - 2 * DAY, checks: 10, ok_checks: 0 }, // down
    ];
    const { uptime90d, bars } = computeUptimeAndBars(rows, now);
    // 15 ok of 30 checks => 50%.
    expect(uptime90d).toBe(50);
    const byDate = new Map(bars.map((b) => [b.date, b]));
    expect(byDate.get("2026-06-29")?.state).toBe("up");
    expect(byDate.get("2026-06-29")?.uptimePct).toBe(100);
    expect(byDate.get("2026-06-28")?.state).toBe("degraded");
    expect(byDate.get("2026-06-28")?.uptimePct).toBe(50);
    expect(byDate.get("2026-06-27")?.state).toBe("down");
    expect(byDate.get("2026-06-27")?.uptimePct).toBe(0);
  });
});
