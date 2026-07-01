import { describe, it, expect } from "vitest";
import { selectPageMonitors } from "./status-pages";
import type { IncludeMode } from "./status-pages";

/** A minimal monitor shape as consumed by selectPageMonitors. */
interface TestMonitor {
  id: string;
  categoryId: string | null;
  name: string;
}

const monitors: TestMonitor[] = [
  { id: "mon_a", categoryId: "cat_api", name: "API" },
  { id: "mon_b", categoryId: "cat_api", name: "API v2" },
  { id: "mon_c", categoryId: "cat_web", name: "Web" },
  { id: "mon_d", categoryId: null, name: "Uncategorized" },
];

/** Build the Pick<> page selector shape used by selectPageMonitors. */
function page(
  includeMode: IncludeMode,
  categoryIds: string[] = [],
  monitorIds: string[] = [],
): { includeMode: IncludeMode; categoryIds: string[]; monitorIds: string[] } {
  return { includeMode, categoryIds, monitorIds };
}

describe("selectPageMonitors — 'all' mode", () => {
  it("returns every visible monitor", () => {
    expect(selectPageMonitors(page("all"), monitors)).toEqual(monitors);
  });

  it("ignores categoryIds/monitorIds selectors entirely", () => {
    const result = selectPageMonitors(
      page("all", ["cat_api"], ["mon_a"]),
      monitors,
    );
    expect(result).toEqual(monitors);
  });

  it("returns [] for an empty monitor list", () => {
    expect(selectPageMonitors(page("all"), [])).toEqual([]);
  });
});

describe("selectPageMonitors — 'categories' mode", () => {
  it("returns monitors whose categoryId is in categoryIds", () => {
    const result = selectPageMonitors(page("categories", ["cat_api"]), monitors);
    expect(result.map((m) => m.id)).toEqual(["mon_a", "mon_b"]);
  });

  it("matches across multiple selected categories, preserving input order", () => {
    const result = selectPageMonitors(
      page("categories", ["cat_web", "cat_api"]),
      monitors,
    );
    expect(result.map((m) => m.id)).toEqual(["mon_a", "mon_b", "mon_c"]);
  });

  it("excludes monitors with a null categoryId", () => {
    const result = selectPageMonitors(
      page("categories", ["cat_api", "cat_web"]),
      monitors,
    );
    expect(result.some((m) => m.id === "mon_d")).toBe(false);
  });

  it("returns [] when categoryIds is empty", () => {
    expect(selectPageMonitors(page("categories", []), monitors)).toEqual([]);
  });

  it("ignores unknown category ids (no false matches)", () => {
    expect(
      selectPageMonitors(page("categories", ["cat_nope"]), monitors),
    ).toEqual([]);
  });

  it("does not duplicate output for duplicate selector ids", () => {
    const result = selectPageMonitors(
      page("categories", ["cat_api", "cat_api"]),
      monitors,
    );
    expect(result.map((m) => m.id)).toEqual(["mon_a", "mon_b"]);
  });
});

describe("selectPageMonitors — 'monitors' mode", () => {
  it("returns monitors whose id is in monitorIds", () => {
    const result = selectPageMonitors(
      page("monitors", [], ["mon_a", "mon_c"]),
      monitors,
    );
    expect(result.map((m) => m.id)).toEqual(["mon_a", "mon_c"]);
  });

  it("preserves the visibleMonitors order, not the selector order", () => {
    const result = selectPageMonitors(
      page("monitors", [], ["mon_c", "mon_a"]),
      monitors,
    );
    expect(result.map((m) => m.id)).toEqual(["mon_a", "mon_c"]);
  });

  it("can select an uncategorized (null categoryId) monitor by id", () => {
    const result = selectPageMonitors(page("monitors", [], ["mon_d"]), monitors);
    expect(result.map((m) => m.id)).toEqual(["mon_d"]);
  });

  it("returns [] when monitorIds is empty", () => {
    expect(selectPageMonitors(page("monitors", [], []), monitors)).toEqual([]);
  });

  it("ignores unknown monitor ids (no false matches)", () => {
    expect(
      selectPageMonitors(page("monitors", [], ["mon_ghost"]), monitors),
    ).toEqual([]);
  });

  it("does not duplicate output for duplicate selector ids", () => {
    const result = selectPageMonitors(
      page("monitors", [], ["mon_a", "mon_a"]),
      monitors,
    );
    expect(result.map((m) => m.id)).toEqual(["mon_a"]);
  });
});

describe("selectPageMonitors — purity", () => {
  it("does not mutate the input array", () => {
    const input = [...monitors];
    selectPageMonitors(page("categories", ["cat_api"]), input);
    selectPageMonitors(page("monitors", [], ["mon_a"]), input);
    expect(input).toEqual(monitors);
  });

  it("returns the same element references (filter, not clone)", () => {
    const result = selectPageMonitors(page("monitors", [], ["mon_b"]), monitors);
    expect(result[0]).toBe(monitors[1]);
  });
});
