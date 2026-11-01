// The staging guard and the executor every drill command goes through.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseJsonc } from "../prod-config.mjs";
import { DrillError, d1Query, httpRequest, makeExecutor, parseArgs, parseDuration, parseWranglerJson, stagingProblems, sqlValue, waitFor } from "./lib.mjs";

const STAGING = {
  name: "openping-platform-staging",
  vars: { HOSTED_DOMAIN: "staging.openping.example", DISPATCH_NAMESPACE: "openping-tenants-staging" },
  d1_databases: [{ binding: "PLATFORM_DB", database_name: "openping-platform-staging" }],
  dispatch_namespaces: [{ binding: "TENANTS", namespace: "openping-tenants-staging" }],
  r2_buckets: [{ binding: "EXPORTS", bucket_name: "openping-tenant-exports-staging" }],
  queues: { producers: [{ binding: "SCHEDULE_QUEUE", queue: "openping-schedule-staging" }], consumers: [{ queue: "openping-schedule-staging" }] },
};

describe("the staging guard", () => {
  it("lets a staging config through with --env staging and the confirmation", () => {
    expect(stagingProblems(STAGING, { env: "staging", confirm: "openping-platform-staging", writes: true })).toEqual([]);
    // Reading only needs no confirmation.
    expect(stagingProblems(STAGING, { env: "staging", writes: false })).toEqual([]);
  });

  it("refuses the repository's production config however it is asked", () => {
    const production = parseJsonc(readFileSync(new URL("../../platform/wrangler.jsonc", import.meta.url), "utf8"));
    const problems = stagingProblems(production, { env: "staging", confirm: "openping-platform", writes: true });
    expect(problems.join("\n")).toMatch(/name is openping-platform, which isn't a staging name/);
    expect(problems.join("\n")).toMatch(/database_name is openping-platform,/);
    expect(problems.join("\n")).toMatch(/namespace is openping-tenants,/);
    expect(problems.join("\n")).toMatch(/bucket_name is openping-tenant-exports,/);
    expect(problems.join("\n")).toMatch(/queue is openping-schedule,/);
    expect(problems.join("\n")).toMatch(/HOSTED_DOMAIN/);
    expect(problems.join("\n")).toMatch(/--confirm openping-platform \(got "openping-platform"\)|isn't a staging name/);
  });

  it("refuses any --env but staging", () => {
    expect(stagingProblems(STAGING, { env: "production", writes: false })[0]).toMatch(/--env must be staging/);
    expect(stagingProblems(STAGING, { env: undefined, writes: false })[0]).toMatch(/got nothing/);
  });

  it("refuses one production resource in an otherwise staging config", () => {
    const mixed = { ...STAGING, r2_buckets: [{ binding: "EXPORTS", bucket_name: "openping-tenant-exports" }] };
    expect(stagingProblems(mixed, { env: "staging", writes: false })).toEqual(["r2_buckets[0].bucket_name is openping-tenant-exports, which isn't a staging name (...-staging)"]);
    const domain = { ...STAGING, vars: { ...STAGING.vars, HOSTED_DOMAIN: "openping.example" } };
    expect(stagingProblems(domain, { env: "staging", writes: false })[0]).toMatch(/not a staging domain/);
  });

  it("asks for --confirm with the Worker's name for a run that changes anything", () => {
    expect(stagingProblems(STAGING, { env: "staging", writes: true })).toEqual([`a run that changes anything needs --confirm openping-platform-staging (got nothing)`]);
    expect(stagingProblems(STAGING, { env: "staging", confirm: "yes", writes: true })[0]).toMatch(/got "yes"/);
  });

  it("works for a config without Workers for Platforms (starter mode)", () => {
    const { dispatch_namespaces: _ns, ...starter } = STAGING;
    expect(stagingProblems({ ...starter, vars: { HOSTED_DOMAIN: "staging.openping.example" } }, { env: "staging", writes: false })).toEqual([]);
  });
});

describe("the executor", () => {
  const ctx = { configPath: "staging.jsonc" };
  const read = d1Query(ctx, "db-staging", "SELECT 1", { what: "a read" });
  const write = d1Query(ctx, "db-staging", "UPDATE t SET x = 1", { write: true, what: "a write" });
  const answer = () => ({ status: 0, stdout: 'banner\n[{"results":[{"x":1}]}]', stderr: "" });

  it("runs everything live, and parses Wrangler's JSON after its banner", async () => {
    const ran = [];
    const exec = makeExecutor({ mode: "live", run: (argv) => (ran.push(argv), answer()), log: () => {} });
    expect(await exec(read)).toEqual([{ results: [{ x: 1 }] }]);
    await exec(write);
    expect(ran).toHaveLength(2);
    expect(ran[1]).toContain("--yes");
  });

  it("runs only the reads in a dry run, and nothing with --print, printing every command", async () => {
    for (const [mode, expected] of [
      ["dry-run", 1],
      ["print", 0],
    ]) {
      const ran = [];
      const lines = [];
      const exec = makeExecutor({ mode, run: (argv) => (ran.push(argv), answer()), log: (l) => lines.push(l) });
      await exec(read);
      expect(await exec(write)).toBeNull();
      expect(ran).toHaveLength(expected);
      expect(lines).toEqual([
        "$ npx wrangler d1 execute db-staging --remote --config staging.jsonc --command 'SELECT 1' --json   # read: a read",
        "$ npx wrangler d1 execute db-staging --remote --config staging.jsonc --command 'UPDATE t SET x = 1' --json --yes   # change: a write",
      ]);
    }
  });

  it("never prints a secret header", async () => {
    const lines = [];
    const exec = makeExecutor({ mode: "live", fetch: async () => new Response("{}"), log: (l) => lines.push(l) });
    await exec(httpRequest("https://api.example/graphql", { method: "POST", headers: { authorization: "Bearer tok_secret" }, secretHeaders: ["authorization"], body: "{}", what: "x" }));
    expect(lines.join("")).not.toContain("tok_secret");
    expect(lines[0]).toContain("authorization: <redacted>");
  });

  it("fails with Wrangler's message, or answers the failure when asked to", async () => {
    const exec = makeExecutor({ mode: "live", run: () => ({ status: 1, stdout: "", stderr: "Couldn't find a D1 DB" }), log: () => {} });
    await expect(exec(read)).rejects.toThrow(/a read failed:\nCouldn't find a D1 DB/);
    expect(await exec({ ...read, allowFailure: true })).toMatchObject({ failed: true });
  });
});

describe("small things", () => {
  it("parses arguments", () => {
    expect(parseArgs(["seed", "--tenants", "5", "--print", "--env=staging"], ["print"])).toEqual({ positional: ["seed"], flags: { tenants: "5", print: true, env: "staging" } });
    expect(() => parseArgs(["--tenants"])).toThrow(DrillError);
  });

  it("parses durations", () => {
    expect(parseDuration("60m")).toBe(3_600_000);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("30")).toBe(30_000);
    expect(() => parseDuration("soon")).toThrow(DrillError);
  });

  it("quotes SQL", () => {
    expect(sqlValue("it's")).toBe("'it''s'");
    expect(sqlValue(null)).toBe("NULL");
    expect(sqlValue(12)).toBe("12");
    expect(() => sqlValue(Number.NaN)).toThrow();
  });

  it("finds the JSON in Wrangler's output", () => {
    expect(parseWranglerJson("⛅️ wrangler\n{\"uuid\":\"u\"}")).toEqual({ uuid: "u" });
    expect(() => parseWranglerJson("no json")).toThrow(DrillError);
  });

  it("waits until done, or times out", async () => {
    let t = 0;
    let n = 0;
    expect(await waitFor(async () => (++n === 3 ? "done" : undefined), { everyMs: 10, timeoutMs: 100, what: "x", now: () => t, wait: async (ms) => void (t += ms), log: () => {} })).toBe("done");
    await expect(waitFor(async () => undefined, { everyMs: 10, timeoutMs: 30, what: "never", now: () => t, wait: async (ms) => void (t += ms), log: () => {} })).rejects.toThrow(/waiting for never/);
  });
});
