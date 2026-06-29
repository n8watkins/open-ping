import { describe, it, expect } from "vitest";
import { isWindowActiveAt } from "./maintenance";
import type { MaintenanceWindow, Recurrence } from "./maintenance";

/** Build a maintenance window with sane defaults for unit tests. */
function makeWindow(overrides: Partial<MaintenanceWindow> = {}): MaintenanceWindow {
  return {
    id: "mw_test",
    title: null,
    scope: "global",
    monitorIds: null,
    startsAt: 0,
    endsAt: 0,
    recurrence: null,
    publicMessage: null,
    privateNotes: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("isWindowActiveAt — one-time windows", () => {
  const start = Date.UTC(2024, 0, 1, 10, 0); // Mon 2024-01-01 10:00 UTC
  const end = Date.UTC(2024, 0, 1, 12, 0); // Mon 2024-01-01 12:00 UTC
  const w = makeWindow({ startsAt: start, endsAt: end });

  it("is inactive before startsAt", () => {
    expect(isWindowActiveAt(w, start - 1)).toBe(false);
    expect(isWindowActiveAt(w, Date.UTC(2024, 0, 1, 9, 30))).toBe(false);
  });

  it("is active within [startsAt, endsAt)", () => {
    expect(isWindowActiveAt(w, start)).toBe(true);
    expect(isWindowActiveAt(w, Date.UTC(2024, 0, 1, 11, 0))).toBe(true);
  });

  it("is inactive at/after endsAt", () => {
    expect(isWindowActiveAt(w, end)).toBe(false);
    expect(isWindowActiveAt(w, end + 1)).toBe(false);
  });
});

describe("isWindowActiveAt — weekly recurrence", () => {
  // Mondays (weekday 1) 09:00 UTC for 60 minutes.
  const rec: Recurrence = {
    type: "weekly",
    weekday: 1,
    start: "09:00",
    durationMinutes: 60,
  };
  const w = makeWindow({ recurrence: rec });

  it("is active on the matching weekday within the window", () => {
    // Mon 2024-01-01 09:30 UTC
    expect(isWindowActiveAt(w, Date.UTC(2024, 0, 1, 9, 30))).toBe(true);
    // boundary start is inclusive
    expect(isWindowActiveAt(w, Date.UTC(2024, 0, 1, 9, 0))).toBe(true);
  });

  it("is inactive before/after the window on the matching weekday", () => {
    expect(isWindowActiveAt(w, Date.UTC(2024, 0, 1, 8, 59))).toBe(false);
    // end (start + 60min) is exclusive
    expect(isWindowActiveAt(w, Date.UTC(2024, 0, 1, 10, 0))).toBe(false);
    expect(isWindowActiveAt(w, Date.UTC(2024, 0, 1, 10, 30))).toBe(false);
  });

  it("is inactive on a non-matching weekday", () => {
    // Tue 2024-01-02 09:30 UTC
    expect(isWindowActiveAt(w, Date.UTC(2024, 0, 2, 9, 30))).toBe(false);
  });
});

describe("isWindowActiveAt — weekly recurrence crossing midnight", () => {
  // Saturdays (weekday 6) 23:00 UTC for 120 minutes -> runs into Sunday 01:00.
  const rec: Recurrence = {
    type: "weekly",
    weekday: 6,
    start: "23:00",
    durationMinutes: 120,
  };
  const w = makeWindow({ recurrence: rec });

  it("is active late Saturday before midnight", () => {
    // Sat 2024-01-06 23:30 UTC
    expect(isWindowActiveAt(w, Date.UTC(2024, 0, 6, 23, 30))).toBe(true);
    expect(isWindowActiveAt(w, Date.UTC(2024, 0, 6, 23, 0))).toBe(true);
  });

  it("is active early Sunday after the midnight crossing", () => {
    // Sun 2024-01-07 00:30 UTC
    expect(isWindowActiveAt(w, Date.UTC(2024, 0, 7, 0, 30))).toBe(true);
  });

  it("is inactive once the crossed window has ended", () => {
    // Sun 2024-01-07 01:00 UTC is the exclusive end
    expect(isWindowActiveAt(w, Date.UTC(2024, 0, 7, 1, 0))).toBe(false);
    expect(isWindowActiveAt(w, Date.UTC(2024, 0, 7, 1, 30))).toBe(false);
  });

  it("is inactive before the window starts on Saturday", () => {
    expect(isWindowActiveAt(w, Date.UTC(2024, 0, 6, 22, 30))).toBe(false);
  });
});
