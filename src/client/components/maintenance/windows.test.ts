import { describe, expect, it } from "vitest";
import {
  formatCountdown,
  formatSpan,
  formatStartsIn,
  formatWindowRange,
  partitionWindows,
  quickPausePayload,
  recurrenceLabel,
  windowTiming,
  type MaintenanceWindowItem,
} from "./windows";

const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 28, 18, 0); // Wednesday

function win(over: Partial<MaintenanceWindowItem>): MaintenanceWindowItem {
  return {
    id: "mw_1",
    title: "Database upgrade",
    scope: "global",
    monitorIds: null,
    startsAt: NOW - H,
    endsAt: NOW + H,
    recurrence: null,
    publicMessage: null,
    privateNotes: null,
    ...over,
  };
}

describe("windowTiming", () => {
  it("places one-time windows", () => {
    expect(windowTiming(win({}), NOW).phase).toBe("active");
    expect(windowTiming(win({ startsAt: NOW + H, endsAt: NOW + 2 * H }), NOW).phase).toBe("upcoming");
    expect(windowTiming(win({ startsAt: NOW - 2 * H, endsAt: NOW - H }), NOW).phase).toBe("past");
    // The end is exclusive, as on the server.
    expect(windowTiming(win({ endsAt: NOW }), NOW).phase).toBe("past");
  });

  it("follows a weekly rule: the current occurrence while active, the next one otherwise", () => {
    const range = { startsAt: NOW - 30 * 24 * H, endsAt: NOW + 30 * 24 * H };
    // Wednesdays 17:00 UTC for 2 hours: active at 18:00.
    const active = windowTiming(
      win({ ...range, recurrence: { type: "weekly", weekday: 3, start: "17:00", durationMinutes: 120 } }),
      NOW,
    );
    expect(active).toEqual({ phase: "active", startsAt: NOW - H, endsAt: NOW + H });

    // Thursdays 02:00 UTC: upcoming tomorrow.
    const upcoming = windowTiming(
      win({ ...range, recurrence: { type: "weekly", weekday: 4, start: "02:00", durationMinutes: 60 } }),
      NOW,
    );
    expect(upcoming).toEqual({ phase: "upcoming", startsAt: NOW + 8 * H, endsAt: NOW + 9 * H });

    // Validity range over: past.
    const over = windowTiming(
      win({
        startsAt: NOW - 30 * 24 * H,
        endsAt: NOW - 24 * H,
        recurrence: { type: "weekly", weekday: 3, start: "17:00", durationMinutes: 120 },
      }),
      NOW,
    );
    expect(over.phase).toBe("past");
  });
});

describe("partitionWindows", () => {
  it("sorts each phase by what matters there", () => {
    const parts = partitionWindows(
      [
        win({ id: "late", startsAt: NOW + 5 * H, endsAt: NOW + 6 * H }),
        win({ id: "soon", startsAt: NOW + H, endsAt: NOW + 2 * H }),
        win({ id: "old", startsAt: NOW - 10 * H, endsAt: NOW - 9 * H }),
        win({ id: "recent", startsAt: NOW - 3 * H, endsAt: NOW - 2 * H }),
        win({ id: "now" }),
      ],
      NOW,
    );
    expect(parts.active.map((p) => p.win.id)).toEqual(["now"]);
    expect(parts.upcoming.map((p) => p.win.id)).toEqual(["soon", "late"]);
    expect(parts.past.map((p) => p.win.id)).toEqual(["recent", "old"]);
  });
});

describe("quickPausePayload", () => {
  it("pauses every monitor or a chosen few, starting now", () => {
    expect(quickPausePayload("all", 30, NOW)).toEqual({
      title: "Alerts paused",
      scope: "global",
      startsAt: NOW,
      endsAt: NOW + 30 * 60_000,
    });
    expect(quickPausePayload(["mon_a"], 120, NOW, "Planned work")).toEqual({
      title: "Alerts paused",
      scope: "monitors",
      monitorIds: ["mon_a"],
      startsAt: NOW,
      endsAt: NOW + 2 * H,
      publicMessage: "Planned work",
    });
  });
});

describe("formatting", () => {
  it("formats countdowns, spans and recurrences", () => {
    expect(formatCountdown(65_000)).toBe("1:05");
    expect(formatCountdown(H + 5 * 60_000 + 9_000)).toBe("1:05:09");
    expect(formatCountdown(-5)).toBe("0:00");
    expect(formatCountdown(500)).toBe("0:01");
    expect(formatSpan(30)).toBe("30 min");
    expect(formatSpan(60)).toBe("1 h");
    expect(formatSpan(90)).toBe("1 h 30 min");
    expect(formatSpan(2880)).toBe("2 days");
    expect(recurrenceLabel({ type: "weekly", weekday: 6, start: "02:00", durationMinutes: 120 })).toBe(
      "Saturdays at 02:00 UTC for 2 h",
    );
  });
});

describe("window ranges", () => {
  const opts = { locale: "en-US", timeZone: "America/Los_Angeles" };
  it("writes one-day and multi-day ranges", () => {
    // Sat Oct 31 2026, 2-4 pm in Los Angeles (UTC-7).
    const start = Date.UTC(2026, 9, 31, 21, 0);
    expect(formatWindowRange(start, start + 2 * H, opts)).toBe("Sat, Oct 31, 2:00 PM-4:00 PM");
    expect(formatWindowRange(start, start + 12 * H, opts)).toBe("Sat, Oct 31, 2:00 PM to Sun, Nov 1, 1:00 AM");
  });

  it("says when an upcoming window starts", () => {
    expect(formatStartsIn(20_000)).toBe("in 1 min");
    expect(formatStartsIn(45 * 60_000)).toBe("in 45 min");
    expect(formatStartsIn(5 * H)).toBe("in 5 h");
    expect(formatStartsIn(72 * H)).toBe("in 3 days");
  });
});
