import { describe, expect, it } from "vitest";
import { checkLogEntry, loggedChecks, mergeChecks, parseCheckLog, type LoggedCheck } from "./check-log";
import { compactionWindow, resolveRetention } from "./rollups";

const HOUR = Date.UTC(2026, 9, 26, 14);

describe("check log entries", () => {
  it("round-trip every field, a missing duration or status code included", () => {
    const checks: LoggedCheck[] = [
      { at: HOUR, state: "up", durationMs: 120, statusCode: 200 },
      { at: HOUR + 59_999, state: "degraded", durationMs: 2_400.5, statusCode: 204 },
      { at: HOUR + 3_599_999, state: "up", durationMs: null, statusCode: null },
    ];
    const log = checks.map((c) => checkLogEntry(HOUR, c)).join(";");
    expect(parseCheckLog(HOUR, log)).toEqual(checks);
  });

  it("read as nothing when empty or NULL, and skip a malformed entry", () => {
    expect(parseCheckLog(HOUR, null)).toEqual([]);
    expect(parseCheckLog(HOUR, "")).toEqual([]);
    expect(parseCheckLog(HOUR, "x,1,2,up;;5,7,,up;9")).toEqual([
      { at: HOUR + 5, state: "up", durationMs: 7, statusCode: null },
    ]);
  });

  it("list only the checks inside the window, as passing checks", () => {
    const log = [10, 20, 30].map((ms) => checkLogEntry(HOUR, { at: HOUR + ms, state: "up", durationMs: ms, statusCode: 200 }));
    const listed = loggedChecks([{ bucket_start: HOUR, check_log: log.join(";") }], HOUR + 15, HOUR + 30);
    expect(listed).toEqual([
      { at: HOUR + 20, state: "up", durationMs: 20, statusCode: 200, ok: 1, error: null, logged: true },
      { at: HOUR + 30, state: "up", durationMs: 30, statusCode: 200, ok: 1, error: null, logged: true },
    ]);
  });

  it("merge with sample rows in time order", () => {
    expect(mergeChecks([{ at: 1 }, { at: 5 }], [{ at: 3 }, { at: 0 }]).map((c) => c.at)).toEqual([0, 1, 3, 5]);
  });
});

describe("the upkeep's check log window", () => {
  const retention = resolveRetention(null);
  const now = Date.UTC(2026, 9, 26, 14, 24);

  it("starts just before the hours the previous pass cleared", () => {
    const since = now - 12 * 60_000;
    // The previous pass (14:12) cleared every hour that ended by 14:12 the day
    // before, so the first left is 14:00; the window starts two hours earlier.
    expect(compactionWindow(now, retention, since).logs).toBe(Date.UTC(2026, 9, 25, 12));
  });

  it("goes back to the last pass that landed, however long ago", () => {
    const since = now - 3 * 86_400_000;
    expect(compactionWindow(now, retention, since).logs).toBe(Date.UTC(2026, 9, 22, 12));
  });

  it("looks back a day past the sample horizon when no pass is known", () => {
    expect(compactionWindow(now, retention, null).logs).toBe(Date.UTC(2026, 9, 24, 14));
  });
});
