import { describe, expect, it, vi } from "vitest";
import { batchEach, MAX_BATCH_STATEMENTS, runWritePlan, type WriteGroup } from "./batch";
import type { Env } from "../types";

/** A statement whose own `all()` resolves, or rejects when `fails`. */
function stmt(name: string, fails = false): D1PreparedStatement {
  return {
    all: vi.fn(async () => {
      if (fails) throw new Error(`${name} broke`);
      return { results: [{ name }], success: true, meta: {} };
    }),
  } as unknown as D1PreparedStatement;
}

function envWith(batch: (s: D1PreparedStatement[]) => Promise<D1Result[]>): Env {
  return { DB: { batch: vi.fn(batch) } } as unknown as Env;
}

describe("batchEach", () => {
  it("sends every statement in one batch when it succeeds", async () => {
    const a = stmt("a");
    const b = stmt("b");
    const env = envWith(async (s) => s.map((_, i) => ({ results: [i] }) as unknown as D1Result));
    const out = await batchEach(env, "test", [
      { label: "a", stmt: a },
      { label: "b", stmt: b },
    ]);
    expect(env.DB.batch).toHaveBeenCalledTimes(1);
    expect(out.map((r) => r?.results)).toEqual([[0], [1]]);
    expect(a.all).not.toHaveBeenCalled();
  });

  it("retries each statement alone when the batch fails, skipping only the bad one", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = envWith(async () => {
      throw new Error("batch rolled back");
    });
    const out = await batchEach(env, "test", [
      { label: "a", stmt: stmt("a") },
      { label: "bad", stmt: stmt("bad", true) },
      { label: "c", stmt: stmt("c") },
    ]);
    expect(out[0]?.results).toEqual([{ name: "a" }]);
    expect(out[1]).toBeNull();
    expect(out[2]?.results).toEqual([{ name: "c" }]);
    expect(errors.mock.calls.some((c) => String(c[0]).includes("bad failed"))).toBe(true);
    errors.mockRestore();
  });

  it("makes no round trip for no statements", async () => {
    const env = envWith(async () => []);
    expect(await batchEach(env, "test", [])).toEqual([]);
    expect(env.DB.batch).not.toHaveBeenCalled();
  });
});

/**
 * A fake D1 with the one property these helpers rely on: a batch is a
 * transaction, so one failing statement means nothing in it was written.
 * Each statement is a named write; a name in `bad` always fails.
 */
function fakeDb(bad: Set<string> = new Set()) {
  const written: string[] = [];
  let roundTrips = 0;
  const stmt = (name: string) =>
    ({
      name,
      all: async () => {
        roundTrips++;
        if (bad.has(name)) throw new Error(`${name} failed`);
        written.push(name);
        return { results: [{ name }], success: true, meta: {} };
      },
    }) as unknown as D1PreparedStatement & { name: string };
  const db = {
    batch: async (stmts: (D1PreparedStatement & { name: string })[]) => {
      roundTrips++;
      const failing = stmts.find((s) => bad.has(s.name));
      if (failing) throw new Error(`${failing.name} failed`);
      written.push(...stmts.map((s) => s.name));
      return stmts.map((s) => ({ results: [{ name: s.name }], success: true, meta: {} }));
    },
  };
  return {
    env: { DB: db } as unknown as Env,
    stmt,
    written,
    get roundTrips() {
      return roundTrips;
    },
  };
}

type Fake = ReturnType<typeof fakeDb>;

/** A monitor's group shaped like checks/state.ts builds them. */
function group(f: Fake, id: string, opts: { incident?: boolean; alert?: boolean } = {}): WriteGroup {
  const s = (n: string) => f.stmt(`${id}.${n}`);
  return {
    label: id,
    core: {
      label: `${id} core`,
      statements: [...(opts.incident ? [s("incident")] : []), s("state"), s("sample")],
    },
    afterCore: opts.alert ? [{ label: `${id} alert`, statements: [s("alert")] }] : [],
    fallbacks: [
      ...(opts.incident ? [{ label: `${id} without incident`, statements: [s("bare"), s("sample")] }] : []),
      { label: `${id} state alone`, statements: [s("bare")] },
    ],
    extras: [
      { label: `${id} rollup`, statements: [s("rollup")] },
      { label: `${id} interval`, statements: [s("extend"), s("close"), s("open")] },
    ],
  };
}

describe("runWritePlan", () => {
  it("sends every group and the tail in one round trip, in order, and returns the tail's results", async () => {
    const f = fakeDb();
    const groups = [group(f, "a"), group(f, "b", { incident: true, alert: true })];
    const res = await runWritePlan(f.env, "test", groups, [
      { label: "claim", stmt: f.stmt("claim") },
      { label: "prune", stmt: f.stmt("prune") },
    ]);
    expect(f.roundTrips).toBe(1);
    expect(res.groups).toEqual(["all", "all"]);
    expect(res.tail.map((r) => (r?.results?.[0] as { name: string }).name)).toEqual(["claim", "prune"]);
    // The tail runs after the groups, so a claim sees the alerts they queued.
    expect(f.written.at(-2)).toBe("claim");
    expect(f.written.indexOf("b.alert")).toBeLessThan(f.written.indexOf("claim"));
  });

  it("costs nothing when there is nothing to write", async () => {
    const f = fakeDb();
    expect(await runWritePlan(f.env, "test", [])).toEqual({ groups: [], tail: [] });
    expect(f.roundTrips).toBe(0);
  });

  it("keeps a bad statement in the tail from taking the monitors' writes down", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fakeDb(new Set(["prune"]));
    const res = await runWritePlan(f.env, "test", [group(f, "a")], [
      { label: "claim", stmt: f.stmt("claim") },
      { label: "prune", stmt: f.stmt("prune") },
    ]);
    expect(res.groups).toEqual(["all"]);
    expect(res.tail[0]).not.toBeNull();
    expect(res.tail[1]).toBeNull();
    expect(f.written).toContain("a.state");
    // Whole batch, the groups alone, then the tail's batch and its two statements.
    expect(f.roundTrips).toBe(5);
  });

  it("lands every other monitor whole when one monitor's sample can't be written, and that one's state alone", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fakeDb(new Set(["b.sample"]));
    const res = await runWritePlan(f.env, "test", [group(f, "a"), group(f, "b"), group(f, "c")]);
    expect(res.groups).toEqual(["all", "fallback", "all"]);
    for (const id of ["a", "c"]) {
      expect(f.written).toEqual(expect.arrayContaining([`${id}.state`, `${id}.sample`, `${id}.rollup`, `${id}.open`]));
    }
    // b: no sample, but its state (without the sample) and its independent writes landed.
    expect(f.written).toEqual(expect.arrayContaining(["b.bare", "b.rollup", "b.extend", "b.close", "b.open"]));
    expect(f.written).not.toContain("b.state");
    expect(f.written).not.toContain("b.sample");
  });

  it("never lets a failed incident write leave the state pointing at it, and drops its alert", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fakeDb(new Set(["b.incident"]));
    const res = await runWritePlan(f.env, "test", [
      group(f, "a", { incident: true, alert: true }),
      group(f, "b", { incident: true, alert: true }),
    ]);
    expect(res.groups).toEqual(["all", "fallback"]);
    expect(f.written).toEqual(expect.arrayContaining(["a.incident", "a.state", "a.alert"]));
    // b's state and sample landed without the incident columns, and no alert went out.
    expect(f.written).toEqual(expect.arrayContaining(["b.bare", "b.sample", "b.rollup"]));
    expect(f.written).not.toContain("b.state");
    expect(f.written).not.toContain("b.alert");
  });

  it("keeps the core when only an independent write fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fakeDb(new Set(["a.close"]));
    const res = await runWritePlan(f.env, "test", [group(f, "a", { incident: true, alert: true })]);
    expect(res.groups).toEqual(["partial"]);
    expect(f.written).toEqual(expect.arrayContaining(["a.incident", "a.state", "a.sample", "a.alert", "a.rollup"]));
    // The interval's statements are one unit: none of them landed.
    expect(f.written).not.toContain("a.extend");
    expect(f.written).not.toContain("a.open");
  });

  it("writes nothing for a monitor whose state can't be written at all, so it stays due", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fakeDb(new Set(["a.bare", "a.state"]));
    const res = await runWritePlan(f.env, "test", [group(f, "a"), group(f, "b")]);
    expect(res.groups).toEqual(["none", "all"]);
    expect(f.written.filter((w) => w.startsWith("a."))).toEqual([]);
  });

  it("stops retrying once the run is out of D1 budget", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fakeDb(new Set(["a.sample", "b.sample"]));
    let allowance = 2;
    const res = await runWritePlan(f.env, "test", [group(f, "a"), group(f, "b")], [], {
      canSpend: () => allowance-- > 0,
    });
    // The whole batch, then two retries; then nothing more is sent.
    expect(f.roundTrips).toBe(3);
    expect(res.groups).toEqual(["none", "none"]);
  });

  it("splits a very large plan into batches of whole monitors", async () => {
    const f = fakeDb();
    const perGroup = group(f, "x").core.statements.length + 4;
    const n = Math.ceil((MAX_BATCH_STATEMENTS * 2) / perGroup);
    const groups = Array.from({ length: n }, (_, i) => group(f, `m${i}`));
    const res = await runWritePlan(f.env, "test", groups, [{ label: "claim", stmt: f.stmt("claim") }]);
    expect(res.groups.every((g) => g === "all")).toBe(true);
    expect(f.roundTrips).toBe(4); // three batches of groups, then the tail
    expect(f.written.at(-1)).toBe("claim");
  });
});

describe("batchEach within a budget", () => {
  it("skips the one-by-one retries the budget can't pay for", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fakeDb(new Set(["b"]));
    let allowance = 1;
    const res = await batchEach(
      f.env,
      "test",
      ["a", "b", "c"].map((n) => ({ label: n, stmt: f.stmt(n) })),
      { canSpend: () => allowance-- > 0 },
    );
    expect(res[0]).not.toBeNull();
    expect(res.slice(1)).toEqual([null, null]);
    expect(f.roundTrips).toBe(2);
  });
});
