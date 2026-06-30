import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import {
  allowedDowntime,
  uptimeFromDowntime,
  formatDowntimeDuration,
  parseCidr,
  parseCron,
  nextCronRuns,
  describeCron,
  rrTypeName,
  parseDohJson,
  parseMxData,
} from "./lib";

/* -------------------------------------------------------------- *
 * Uptime / downtime math
 * -------------------------------------------------------------- */
describe("allowedDowntime", () => {
  it("computes 99% allowances", () => {
    const rows = allowedDowntime(99);
    const day = rows.find((r) => r.key === "day")!;
    const month = rows.find((r) => r.key === "month")!;
    expect(day.downtimeSeconds).toBeCloseTo(864, 6); // 14m 24s
    expect(month.downtimeSeconds).toBeCloseTo(25920, 6); // 7h 12m
  });

  it("computes 99.9% per year", () => {
    const year = allowedDowntime(99.9).find((r) => r.key === "year")!;
    expect(year.downtimeSeconds).toBeCloseTo(31536, 3); // ~8h 45m 36s
  });
});

describe("uptimeFromDowntime", () => {
  it("inverts the day calculation", () => {
    expect(uptimeFromDowntime(864, 86400)).toBeCloseTo(99, 9);
  });
  it("inverts the month calculation", () => {
    expect(uptimeFromDowntime(2592, 30 * 86400)).toBeCloseTo(99.9, 9);
  });
  it("clamps downtime that exceeds the period", () => {
    expect(uptimeFromDowntime(99999, 86400)).toBe(0);
  });
});

describe("formatDowntimeDuration", () => {
  it("formats minutes and seconds", () => {
    expect(formatDowntimeDuration(864)).toBe("14 min 24 sec");
  });
  it("formats sub-second-ish small values in seconds", () => {
    expect(formatDowntimeDuration(0.864)).toBe("0.86 sec");
  });
  it("formats large values with days", () => {
    expect(formatDowntimeDuration(3 * 86400 + 6 * 3600)).toBe("3 days 6 hr");
  });
});

/* -------------------------------------------------------------- *
 * Subnet math
 * -------------------------------------------------------------- */
describe("parseCidr", () => {
  it("computes a /24", () => {
    const r = parseCidr("192.168.1.0/24");
    expect(r.networkAddress).toBe("192.168.1.0");
    expect(r.broadcastAddress).toBe("192.168.1.255");
    expect(r.netmask).toBe("255.255.255.0");
    expect(r.wildcardMask).toBe("0.0.0.255");
    expect(r.firstHost).toBe("192.168.1.1");
    expect(r.lastHost).toBe("192.168.1.254");
    expect(r.totalHosts).toBe(256);
    expect(r.usableHosts).toBe(254);
  });

  it("normalises a host address to its network", () => {
    const r = parseCidr("10.0.5.37/8");
    expect(r.networkAddress).toBe("10.0.0.0");
    expect(r.broadcastAddress).toBe("10.255.255.255");
    expect(r.netmask).toBe("255.0.0.0");
    expect(r.totalHosts).toBe(16_777_216);
    expect(r.usableHosts).toBe(16_777_214);
  });

  it("handles /32 (single host)", () => {
    const r = parseCidr("192.168.1.10/32");
    expect(r.totalHosts).toBe(1);
    expect(r.usableHosts).toBe(1);
    expect(r.hostRange).toBe("192.168.1.10");
  });

  it("handles /31 (point-to-point)", () => {
    const r = parseCidr("192.168.1.0/31");
    expect(r.totalHosts).toBe(2);
    expect(r.usableHosts).toBe(2);
    expect(r.firstHost).toBe("192.168.1.0");
    expect(r.lastHost).toBe("192.168.1.1");
  });

  it("handles /0", () => {
    const r = parseCidr("0.0.0.0/0");
    expect(r.broadcastAddress).toBe("255.255.255.255");
    expect(r.totalHosts).toBe(4_294_967_296);
  });

  it("rejects bad octets and prefixes", () => {
    expect(() => parseCidr("999.1.1.1/24")).toThrow();
    expect(() => parseCidr("192.168.1.0/33")).toThrow();
    expect(() => parseCidr("192.168.1.0")).toThrow();
  });
});

/* -------------------------------------------------------------- *
 * Cron parsing + next runs
 * -------------------------------------------------------------- */
const UTC = "UTC";
function runs(expr: string, count: number, fromIso: string): string[] {
  const from = DateTime.fromISO(fromIso, { zone: UTC });
  return nextCronRuns(expr, count, UTC, from).map((d) => d.toFormat("yyyy-MM-dd HH:mm"));
}

describe("parseCron", () => {
  it("expands steps, ranges, and lists", () => {
    const f = parseCron("*/15 1-3 * * mon-fri");
    expect(f.minute).toEqual([0, 15, 30, 45]);
    expect(f.hour).toEqual([1, 2, 3]);
    expect(f.dow).toEqual([1, 2, 3, 4, 5]);
  });

  it("normalises day-of-week 7 to 0 (Sunday)", () => {
    expect(parseCron("0 0 * * 7").dow).toEqual([0]);
  });

  it("rejects malformed expressions", () => {
    expect(() => parseCron("* * * *")).toThrow(); // 4 fields
    expect(() => parseCron("60 * * * *")).toThrow(); // minute out of range
    expect(() => parseCron("* 24 * * *")).toThrow(); // hour out of range
  });
});

describe("nextCronRuns", () => {
  it("every 15 minutes", () => {
    expect(runs("*/15 * * * *", 4, "2024-01-01T00:00:00")).toEqual([
      "2024-01-01 00:15",
      "2024-01-01 00:30",
      "2024-01-01 00:45",
      "2024-01-01 01:00",
    ]);
  });

  it("9am on weekdays", () => {
    // 2024-01-01 is a Monday.
    expect(runs("0 9 * * 1-5", 6, "2024-01-01T00:00:00")).toEqual([
      "2024-01-01 09:00",
      "2024-01-02 09:00",
      "2024-01-03 09:00",
      "2024-01-04 09:00",
      "2024-01-05 09:00",
      "2024-01-08 09:00", // skips Sat/Sun
    ]);
  });

  it("yearly schedule (month/day jumping)", () => {
    expect(runs("0 0 1 1 *", 2, "2024-06-01T00:00:00")).toEqual([
      "2025-01-01 00:00",
      "2026-01-01 00:00",
    ]);
  });

  it("OR semantics when both day-of-month and day-of-week are set", () => {
    // Midnight on the 13th OR on any Monday. Feb 2025: Mondays = 3,10,17,24;
    // the 13th is a Thursday and is included only via day-of-month.
    expect(runs("0 0 13 * 1", 4, "2025-02-01T00:00:00")).toEqual([
      "2025-02-03 00:00",
      "2025-02-10 00:00",
      "2025-02-13 00:00",
      "2025-02-17 00:00",
    ]);
  });
});

describe("describeCron", () => {
  it("describes a step", () => {
    expect(describeCron("*/5 * * * *")).toBe("Every 5 minutes.");
  });
  it("describes a daily time", () => {
    expect(describeCron("0 0 * * *")).toBe("At 00:00.");
  });
  it("describes weekday mornings", () => {
    expect(describeCron("0 9 * * 1-5")).toBe(
      "At 09:00 on Monday, Tuesday, Wednesday, Thursday, and Friday.",
    );
  });
});

/* -------------------------------------------------------------- *
 * DNS-over-HTTPS parsing
 * -------------------------------------------------------------- */
describe("rrTypeName", () => {
  it("maps known codes", () => {
    expect(rrTypeName(1)).toBe("A");
    expect(rrTypeName(28)).toBe("AAAA");
    expect(rrTypeName(15)).toBe("MX");
  });
  it("falls back to the numeric code", () => {
    expect(rrTypeName(99)).toBe("99");
  });
});

describe("parseDohJson", () => {
  it("normalises an answer set", () => {
    const r = parseDohJson({
      Status: 0,
      Answer: [{ name: "example.com.", type: 1, TTL: 300, data: "93.184.216.34" }],
    });
    expect(r.status).toBe(0);
    expect(r.statusText).toBe("NOERROR");
    expect(r.answers).toEqual([
      { name: "example.com.", type: "A", ttl: 300, data: "93.184.216.34" },
    ]);
  });

  it("handles NXDOMAIN with no answers", () => {
    const r = parseDohJson({ Status: 3 });
    expect(r.answers).toEqual([]);
    expect(r.statusText).toContain("NXDOMAIN");
  });
});

describe("parseMxData", () => {
  it("splits priority and exchange and strips the trailing dot", () => {
    expect(parseMxData("10 mail.example.com.")).toEqual({
      priority: 10,
      exchange: "mail.example.com",
    });
  });
});
