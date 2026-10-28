import { describe, expect, it } from "vitest";
import type { MonitorSummary } from "../lib/types";
import { filterAndSortMonitors, groupMonitors } from "./monitors-list";

function monitor(overrides: Partial<MonitorSummary>): MonitorSummary {
  return {
    id: "mon_default",
    name: "Example",
    type: "http",
    target: "https://example.com/health",
    state: "up",
    paused: false,
    intervalSeconds: 720,
    scheduleMode: "always",
    lastCheckedAt: null,
    lastDurationMs: null,
    lastStatusCode: null,
    nextCheckAt: null,
    stateSince: null,
    uptime24h: 100,
    recentChecks: [],
    publicVisible: false,
    categoryId: null,
    categoryName: null,
    ...overrides,
  };
}

describe("filterAndSortMonitors", () => {
  const monitors = [
    monitor({
      id: "api",
      name: "Production API",
      target: "https://api.example.com/health",
      state: "down",
      categoryId: "services",
      categoryName: "Services",
      lastCheckedAt: 10,
    }),
    monitor({
      id: "dns",
      name: "Authoritative record",
      type: "dns",
      target: "status.example.net",
      lastCheckedAt: 20,
    }),
  ];

  it("searches names, targets, types, and category names", () => {
    expect(filterAndSortMonitors(monitors, "api.example", "all", "name")).toHaveLength(1);
    expect(filterAndSortMonitors(monitors, "dns", "all", "name")[0]?.id).toBe("dns");
    expect(filterAndSortMonitors(monitors, "services", "all", "name")[0]?.id).toBe("api");
  });

  it("combines status filtering with the requested sort", () => {
    expect(filterAndSortMonitors(monitors, "", "down", "status").map((m) => m.id)).toEqual(["api"]);
    expect(filterAndSortMonitors(monitors, "", "all", "recent").map((m) => m.id)).toEqual(["dns", "api"]);
  });
});

describe("groupMonitors", () => {
  it("groups by category and puts uncategorized monitors last", () => {
    const groups = groupMonitors([
      monitor({ id: "none" }),
      monitor({ id: "api", categoryId: "services", categoryName: "Services" }),
      monitor({ id: "web", categoryId: "services", categoryName: "Services" }),
    ]);

    expect(groups.map((group) => [group.label, group.monitors.length])).toEqual([
      ["Services", 2],
      ["Uncategorized", 1],
    ]);
  });
});

describe("sorting by the list figures", () => {
  const list = [
    monitor({ id: "a", name: "Alpha" }),
    monitor({ id: "b", name: "Beta" }),
    monitor({ id: "c", name: "Gamma" }),
  ];
  const stats = {
    a: { uptime7d: 99.5, typicalResponseMs: 120 },
    b: { uptime7d: 97, typicalResponseMs: null },
    c: { uptime7d: 100, typicalResponseMs: 480 },
  };

  it("puts the lowest 7-day uptime first", () => {
    expect(filterAndSortMonitors(list, "", "all", "uptime", stats).map((m) => m.id)).toEqual(["b", "a", "c"]);
  });

  it("puts the slowest typical response first, monitors without one last", () => {
    expect(filterAndSortMonitors(list, "", "all", "response", stats).map((m) => m.id)).toEqual(["c", "a", "b"]);
  });

  it("keeps monitors without figures in name order at the end", () => {
    expect(filterAndSortMonitors(list, "", "all", "uptime").map((m) => m.id)).toEqual(["a", "b", "c"]);
  });
});
