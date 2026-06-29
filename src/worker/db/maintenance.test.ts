import { describe, it, expect } from "vitest";
import { isWindowActiveAt, nextRecurringOccurrence } from "./maintenance";
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
  // Wide validity range so these cases exercise the weekly rule itself, not the
  // [startsAt, endsAt) bounds (those are covered separately below).
  const w = makeWindow({
    recurrence: rec,
    startsAt: Date.UTC(2024, 0, 1),
    endsAt: Date.UTC(2025, 0, 1),
  });

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
  // Wide validity range so the midnight / week-boundary cases aren't masked by
  // the [startsAt, endsAt) bounds.
  const w = makeWindow({
    recurrence: rec,
    startsAt: Date.UTC(2024, 0, 1),
    endsAt: Date.UTC(2025, 0, 1),
  });

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

describe("isWindowActiveAt — weekly recurrence bounded by validity range", () => {
  // Mondays (weekday 1) 09:00 UTC for 60 minutes, but valid only for two weeks:
  // [Mon 2024-02-05 00:00, Mon 2024-02-19 00:00). A bounded recurring window must
  // not recur before it starts or after it ends.
  const rec: Recurrence = {
    type: "weekly",
    weekday: 1,
    start: "09:00",
    durationMinutes: 60,
  };
  const w = makeWindow({
    recurrence: rec,
    startsAt: Date.UTC(2024, 1, 5, 0, 0),
    endsAt: Date.UTC(2024, 1, 19, 0, 0),
  });

  it("is active on a matching weekday inside the validity range", () => {
    // Mon 2024-02-12 09:30 UTC — within [startsAt, endsAt) and the weekly rule.
    expect(isWindowActiveAt(w, Date.UTC(2024, 1, 12, 9, 30))).toBe(true);
  });

  it("does not recur before startsAt even on a matching weekday/time", () => {
    // Mon 2024-01-29 09:30 UTC — the weekly rule matches, but this precedes the
    // window's validity range, so it must be inactive.
    expect(isWindowActiveAt(w, Date.UTC(2024, 0, 29, 9, 30))).toBe(false);
  });

  it("does not recur at/after endsAt even on a matching weekday/time", () => {
    // endsAt is exclusive: the Monday that is endsAt's day, and later Mondays,
    // are out of range despite matching the weekly rule.
    expect(isWindowActiveAt(w, Date.UTC(2024, 1, 19, 9, 30))).toBe(false);
    expect(isWindowActiveAt(w, Date.UTC(2024, 1, 26, 9, 30))).toBe(false);
  });
});

describe("nextRecurringOccurrence", () => {
  const rec: Recurrence = {
    type: "weekly",
    weekday: 1, // Monday
    start: "09:00",
    durationMinutes: 60,
  };

  it("returns null for a one-time window", () => {
    const w = makeWindow({ startsAt: 0, endsAt: 1 });
    expect(nextRecurringOccurrence(w, 0)).toBeNull();
  });

  it("finds the next Monday 09:00 from mid-week", () => {
    const w = makeWindow({
      recurrence: rec,
      startsAt: Date.UTC(2024, 0, 1),
      endsAt: Date.UTC(2025, 0, 1),
    });
    // Tue 2024-01-02 12:00 → next is Mon 2024-01-08 09:00..10:00
    const occ = nextRecurringOccurrence(w, Date.UTC(2024, 0, 2, 12, 0));
    expect(occ).toEqual({
      startsAt: Date.UTC(2024, 0, 8, 9, 0),
      endsAt: Date.UTC(2024, 0, 8, 10, 0),
    });
  });

  it("returns the NEXT occurrence (not the current one) while active", () => {
    const w = makeWindow({
      recurrence: rec,
      startsAt: Date.UTC(2024, 0, 1),
      endsAt: Date.UTC(2025, 0, 1),
    });
    // Mon 2024-01-01 09:30 is inside the slot; next future start is a week later.
    const occ = nextRecurringOccurrence(w, Date.UTC(2024, 0, 1, 9, 30));
    expect(occ?.startsAt).toBe(Date.UTC(2024, 0, 8, 9, 0));
  });

  it("clamps the first occurrence to the validity start", () => {
    const w = makeWindow({
      recurrence: rec,
      startsAt: Date.UTC(2024, 1, 5, 0, 0), // Mon 2024-02-05
      endsAt: Date.UTC(2024, 1, 19, 0, 0), // Mon 2024-02-19 (exclusive)
    });
    // Well before the range opens → first valid occurrence is Mon 2024-02-05 09:00.
    const occ = nextRecurringOccurrence(w, Date.UTC(2024, 0, 15, 0, 0));
    expect(occ?.startsAt).toBe(Date.UTC(2024, 1, 5, 9, 0));
  });

  it("returns null when the next occurrence would fall outside the validity range", () => {
    const w = makeWindow({
      recurrence: rec,
      startsAt: Date.UTC(2024, 1, 5, 0, 0),
      endsAt: Date.UTC(2024, 1, 19, 0, 0), // last valid Monday slot is 02-12
    });
    // Sun 2024-02-18 → next Monday 09:00 is 02-19, which is >= endsAt → null.
    expect(nextRecurringOccurrence(w, Date.UTC(2024, 1, 18, 12, 0))).toBeNull();
  });
});
