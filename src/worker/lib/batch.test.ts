import { describe, expect, it, vi } from "vitest";
import { batchEach } from "./batch";
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
