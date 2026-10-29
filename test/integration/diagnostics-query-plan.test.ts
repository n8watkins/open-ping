import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

// The diagnostics' "latest failed run" lookup (routes/diagnostics.ts) must not
// read every run record on an install that has never failed: D1 bills every
// row read, and the Free plan caps a day's reads (docs/FREE_TIER.md).

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("diagnostics query plan", () => {
  it("finds the latest failed run through the failed-runs index", async () => {
    const { results } = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM scheduler_runs WHERE ok = 0 ORDER BY started_at DESC LIMIT 1",
    ).all<{ detail: string }>();
    expect(results.map((r) => r.detail).join(" | ")).toContain("idx_scheduler_runs_failed");
  });
});
