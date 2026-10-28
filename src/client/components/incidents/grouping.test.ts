import { describe, expect, it } from "vitest";
import {
  causeLabel,
  eventTitle,
  groupIncidents,
  monitorNames,
  sectionByMonth,
  sortEvents,
  summarizeEvents,
  unionSeconds,
  type GroupableIncident,
} from "./grouping";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 14, 21, 0, 43); // Oct 14 2026

let seq = 0;
function inc(over: Partial<GroupableIncident> & { monitorName: string; startedAt: number }): GroupableIncident {
  seq += 1;
  const durationSeconds = over.durationSeconds ?? 600;
  const status = over.status ?? "resolved";
  return {
    id: `inc_${seq}`,
    monitorId: `mon_${over.monitorName}`,
    title: `${over.monitorName} is down`,
    status,
    resolvedAt: status === "open" ? null : over.startedAt + durationSeconds * 1000,
    durationSeconds: status === "open" ? null : durationSeconds,
    error: null,
    rootCause: null,
    httpStatus: null,
    ...over,
  };
}

describe("groupIncidents", () => {
  it("folds incidents that start in the same few minutes into one event", () => {
    const list = [
      inc({ monitorName: "Scout", startedAt: T0, durationSeconds: 1438 }),
      inc({ monitorName: "Echo", startedAt: T0, durationSeconds: 718 }),
      inc({ monitorName: "GeminiGPT", startedAt: T0 + 3 * MIN, durationSeconds: 60 }),
    ];
    const events = groupIncidents(list, { now: T0 + 60 * MIN });
    expect(events).toHaveLength(1);
    const [e] = events;
    expect(e!.incidents.map((i) => i.monitorName)).toEqual(["Echo", "GeminiGPT", "Scout"]);
    expect(e!.startedAt).toBe(T0);
    expect(e!.endedAt).toBe(T0 + 1438 * 1000);
    // Overlapping downtime counts once: the event lasted as long as Scout.
    expect(e!.downtimeSeconds).toBe(1438);
    expect(e!.open).toBe(false);
  });

  it("starts a new event outside the window, measured from the event's first incident", () => {
    const list = [
      inc({ monitorName: "A", startedAt: T0 }),
      inc({ monitorName: "B", startedAt: T0 + 4 * MIN }),
      // Within 5 min of B but 8 min after A: no chaining.
      inc({ monitorName: "C", startedAt: T0 + 8 * MIN }),
    ];
    const events = groupIncidents(list);
    expect(events.map((e) => e.incidents.map((i) => i.monitorName))).toEqual([["C"], ["A", "B"]]);
  });

  it("keeps two incidents of the same monitor apart", () => {
    const list = [
      inc({ monitorName: "Echo", startedAt: T0, durationSeconds: 30 }),
      inc({ monitorName: "Echo", startedAt: T0 + 2 * MIN }),
    ];
    expect(groupIncidents(list)).toHaveLength(2);
  });

  it("returns events newest first and honours a custom window", () => {
    const list = [
      inc({ monitorName: "A", startedAt: T0 }),
      inc({ monitorName: "B", startedAt: T0 + 20 * MIN }),
    ];
    expect(groupIncidents(list).map((e) => e.startedAt)).toEqual([T0 + 20 * MIN, T0]);
    expect(groupIncidents(list, { windowMs: 30 * MIN })).toHaveLength(1);
  });

  it("treats an event with an open member as ongoing, counting downtime to now", () => {
    const list = [
      inc({ monitorName: "A", startedAt: T0, durationSeconds: 120 }),
      inc({ monitorName: "B", startedAt: T0 + MIN, status: "open" }),
    ];
    const [e] = groupIncidents(list, { now: T0 + 30 * MIN });
    expect(e!.open).toBe(true);
    expect(e!.endedAt).toBeNull();
    expect(e!.downtimeSeconds).toBe(30 * 60);
  });

  it("reports the shared cause, or mixed causes", () => {
    const same = groupIncidents([
      inc({ monitorName: "A", startedAt: T0, error: "suspended", rootCause: "suspended", httpStatus: 503 }),
      inc({ monitorName: "B", startedAt: T0, error: "suspended", rootCause: "suspended", httpStatus: 503 }),
    ]);
    expect(same[0]!.cause).toBe("Render suspended the app");

    const mixed = groupIncidents([
      inc({ monitorName: "A", startedAt: T0, error: "timeout" }),
      inc({ monitorName: "B", startedAt: T0, error: "suspended" }),
    ]);
    expect(mixed[0]!.cause).toBe("Mixed causes");

    const none = groupIncidents([inc({ monitorName: "A", startedAt: T0 })]);
    expect(none[0]!.cause).toBeNull();
  });

  it("handles an empty list", () => {
    expect(groupIncidents([])).toEqual([]);
  });
});

describe("causeLabel", () => {
  const base = { monitorName: "A", startedAt: T0 };
  it("maps known error codes", () => {
    expect(causeLabel(inc({ ...base, error: "timeout" }))).toBe("Timeout");
    expect(causeLabel(inc({ ...base, error: "suspended", httpStatus: 503 }))).toBe("Render suspended the app");
  });
  it("names a status-code failure by its code", () => {
    expect(causeLabel(inc({ ...base, error: "status_out_of_range", httpStatus: 503 }))).toBe("HTTP 503");
    expect(causeLabel(inc({ ...base, httpStatus: 500 }))).toBe("HTTP 500");
  });
  it("prefers an owner-written root cause and shortens long text", () => {
    expect(causeLabel(inc({ ...base, rootCause: "Expired API key", error: "timeout" }))).toBe("Expired API key");
    const long = "x ".repeat(50);
    expect(causeLabel(inc({ ...base, rootCause: long }))!.length).toBeLessThanOrEqual(60);
  });
  it("ignores an unknown machine code and falls back", () => {
    expect(causeLabel(inc({ ...base, error: "weird_code" }))).toBeNull();
    expect(causeLabel(inc({ ...base, error: "weird_code", httpStatus: 502 }))).toBe("HTTP 502");
  });
});

describe("unionSeconds", () => {
  it("counts overlaps once and skips gaps", () => {
    expect(unionSeconds([[0, 10_000], [5_000, 20_000], [30_000, 40_000]])).toBe(30);
    expect(unionSeconds([])).toBe(0);
    expect(unionSeconds([[5_000, 5_000]])).toBe(0);
  });
});

describe("sortEvents, summarizeEvents, sectionByMonth", () => {
  const events = groupIncidents([
    inc({ monitorName: "A", startedAt: Date.UTC(2026, 6, 31, 15), durationSeconds: 32400 }),
    inc({ monitorName: "B", startedAt: Date.UTC(2026, 6, 31, 15), durationSeconds: 32400 }),
    inc({ monitorName: "A", startedAt: Date.UTC(2026, 6, 24, 16), durationSeconds: 25919 }),
    inc({ monitorName: "A", startedAt: Date.UTC(2026, 9, 14, 21), durationSeconds: 1438 }),
  ]);

  it("sorts by start or by downtime", () => {
    expect(sortEvents(events, "newest").map((e) => e.downtimeSeconds)).toEqual([1438, 32400, 25919]);
    expect(sortEvents(events, "oldest").map((e) => e.downtimeSeconds)).toEqual([25919, 32400, 1438]);
    expect(sortEvents(events, "longest").map((e) => e.downtimeSeconds)).toEqual([32400, 25919, 1438]);
  });

  it("summarizes counts, total and longest downtime", () => {
    expect(summarizeEvents(events)).toEqual({
      events: 3,
      incidents: 4,
      open: 0,
      downtimeSeconds: 1438 + 32400 + 25919,
      longestSeconds: 32400,
    });
  });

  it("splits sorted events into month sections", () => {
    const sections = sectionByMonth(sortEvents(events, "newest"), { locale: "en-US", timeZone: "UTC" });
    expect(sections.map((s) => [s.label, s.events.length, s.downtimeSeconds])).toEqual([
      ["October 2026", 1, 1438],
      ["July 2026", 2, 32400 + 25919],
    ]);
  });
});

describe("eventTitle and monitorNames", () => {
  it("titles a group by its size and a single incident by its own title", () => {
    const [group] = groupIncidents([
      inc({ monitorName: "Scout", startedAt: T0 }),
      inc({ monitorName: "Echo", startedAt: T0 }),
      inc({ monitorName: "GeminiGPT", startedAt: T0 }),
    ]);
    expect(eventTitle(group!)).toBe("3 monitors down");
    expect(monitorNames(group!)).toBe("Echo, GeminiGPT and Scout");
    expect(monitorNames(group!, 2)).toBe("Echo, GeminiGPT +1 more");

    const [single] = groupIncidents([inc({ monitorName: "Echo", startedAt: T0 })]);
    expect(eventTitle(single!)).toBe("Echo is down");
    expect(monitorNames(single!)).toBe("Echo");
  });
});
