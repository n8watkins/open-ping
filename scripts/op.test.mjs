import { describe, expect, it, vi } from "vitest";
import {
  COMMANDS,
  configFromFlags,
  helpText,
  loadConfig,
  parseCommandLine,
  parseEnvFile,
  run,
  scheduleFromFlags,
  table,
  UsageError,
  weekdayText,
} from "./op.mjs";

const ENV = { OPENPING_URL: "https://op.test/", OPENPING_TOKEN: "tok" };

/** Run the CLI against a fake fetch; returns the exit code, output and calls. */
async function cli(argv, responses = {}) {
  const calls = [];
  const fetch = vi.fn(async (url, init) => {
    const path = url.replace("https://op.test", "");
    calls.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    const key = `${init.method} ${path.split("?")[0]}`;
    const [status, body] = responses[key] ?? [200, {}];
    return new Response(JSON.stringify(body), { status });
  });
  let stdout = "";
  let stderr = "";
  const code = await run(argv, {
    env: ENV,
    readFile: () => {
      throw new Error("no file");
    },
    fetch,
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
  });
  return { code, stdout, stderr, calls };
}

describe("parseCommandLine", () => {
  it("finds two-word and one-word commands with args and typed flags", () => {
    expect(parseCommandLine(["monitors", "get", "mon_1"])).toMatchObject({
      command: "monitors get",
      positionals: ["mon_1"],
      flags: {},
    });
    expect(parseCommandLine(["diagnostics", "--runs", "5", "--json"])).toMatchObject({
      command: "diagnostics",
      flags: { runs: 5, json: true },
    });
    expect(parseCommandLine(["--json", "status"]).flags).toEqual({ json: true });
    expect(parseCommandLine(["monitors", "update", "mon_1", "--days=1,2,3", "--name", "API"]).flags).toEqual({
      days: ["1", "2", "3"],
      name: "API",
    });
  });

  it("errors on an unknown flag instead of ignoring it", () => {
    expect(() => parseCommandLine(["monitors", "list", "--bogus"])).toThrow(/Unknown flag --bogus/);
    expect(() => parseCommandLine(["monitors", "list", "--bogus=1"])).toThrow(UsageError);
    expect(() => parseCommandLine(["status", "-x"])).toThrow(/Unknown flag -x/);
    // A flag that exists on another command is still unknown here.
    expect(() => parseCommandLine(["status", "--yes"])).toThrow(/Unknown flag --yes/);
  });

  it("errors on missing or extra arguments, values and bad types", () => {
    expect(() => parseCommandLine(["monitors", "get"])).toThrow(/Missing <id>/);
    expect(() => parseCommandLine(["monitors", "get", "a", "b"])).toThrow(/Unexpected argument "b"/);
    expect(() => parseCommandLine(["incidents", "list", "--limit"])).toThrow(/needs a value/);
    expect(() => parseCommandLine(["incidents", "list", "--limit", "many"])).toThrow(/must be a number/);
    expect(() => parseCommandLine(["incidents", "list", "--status", "closed"])).toThrow(/one of open, resolved, all/);
    expect(() => parseCommandLine(["monitors", "delete", "a", "--yes=no"])).toThrow(/takes no value/);
    expect(() => parseCommandLine(["monitors", "create", "--name", "a", "--name", "b"])).toThrow(/twice/);
    expect(() => parseCommandLine(["monitors", "create", "--config", "[1]"])).toThrow(/JSON object/);
  });

  it("errors on an unknown command and names the subcommands", () => {
    expect(() => parseCommandLine(["nope"])).toThrow(/Unknown command "nope"/);
    expect(() => parseCommandLine(["monitors"])).toThrow(/needs a subcommand: list, get/);
    expect(() => parseCommandLine(["monitors", "explode"])).toThrow(/Unknown command "monitors explode"/);
  });

  it("returns help for --help anywhere and for no command", () => {
    expect(parseCommandLine([])).toEqual({ command: null, help: true });
    expect(parseCommandLine(["--help"]).help).toBe(true);
    expect(parseCommandLine(["monitors", "create", "--bogus", "-h"])).toEqual({ command: "monitors create", help: true });
  });
});

describe("help", () => {
  it("lists every command and per-command flags", () => {
    const all = helpText(null);
    for (const name of Object.keys(COMMANDS)) expect(all).toContain(`op ${name}`);
    expect(helpText("monitors delete")).toContain("--yes");
    expect(helpText("monitors")).not.toContain("op status");
  });
});

describe("config", () => {
  it("parses .op.env lines", () => {
    expect(
      parseEnvFile('# comment\nexport OPENPING_URL="https://a.test"\nOPENPING_TOKEN=abc # note\nBAD LINE\n'),
    ).toEqual({ OPENPING_URL: "https://a.test", OPENPING_TOKEN: "abc" });
  });

  it("prefers the environment over .op.env and trims the URL", () => {
    const readFile = () => "OPENPING_URL=https://file.test/\nOPENPING_TOKEN=file-token\n";
    expect(loadConfig({ env: {}, cwd: "/x", readFile })).toEqual({ url: "https://file.test", token: "file-token" });
    expect(loadConfig({ env: { OPENPING_TOKEN: "env-token" }, cwd: "/x", readFile })).toEqual({
      url: "https://file.test",
      token: "env-token",
    });
  });
});

describe("flag builders", () => {
  it("builds type-specific config and rejects flags for another type", () => {
    expect(configFromFlags("http", { url: "https://a", method: "head", "expect-status": "200-299" })).toEqual({
      url: "https://a",
      method: "HEAD",
      expectedStatus: { min: 200, max: 299 },
    });
    expect(configFromFlags("tcp", { host: "db", port: 5432, config: { timeoutMs: 5000 } })).toEqual({
      host: "db",
      port: 5432,
      timeoutMs: 5000,
    });
    expect(() => configFromFlags("dns", { url: "https://a" })).toThrow(/--url is for http monitors/);
  });

  it("builds and adjusts business-hours schedules", () => {
    expect(scheduleFromFlags({}, null)).toBeNull();
    expect(scheduleFromFlags({ schedule: "always" }, null)).toEqual({ mode: "always" });
    const current = { mode: "business_hours", weekdays: [1, 2], start: "09:00", end: "17:00", timezone: "UTC" };
    expect(scheduleFromFlags({ end: "18:00" }, current)).toEqual({ ...current, end: "18:00" });
    expect(() => scheduleFromFlags({ tz: "UTC" }, { mode: "always" })).toThrow(/--schedule business/);
    expect(() => scheduleFromFlags({ schedule: "business", days: ["9"] }, null)).toThrow(/0 \(Sunday\) to 6/);
  });

  it("names weekdays like the MCP tools do", () => {
    expect(weekdayText([1, 2, 3, 4, 5])).toBe("Mon-Fri");
    expect(weekdayText([0, 6])).toBe("Sun,Sat");
  });

  it("renders aligned tables", () => {
    expect(table([{ a: "x", b: 1 }, { a: "long", b: 22 }], [["A", (r) => r.a], ["B", (r) => r.b]])).toBe(
      "A     B\nx     1\nlong  22",
    );
  });
});

describe("run", () => {
  it("sends the bearer token and prints a table", async () => {
    const r = await cli(["monitors", "list"], {
      "GET /api/monitors": [200, { monitors: [{ id: "mon_1", type: "http", enabled: true, paused: false, name: "API", schedule: { mode: "always" }, config: { url: "https://a.test/x?k=secret" } }] }],
    });
    expect(r.code).toBe(0);
    expect(r.calls[0].headers.authorization).toBe("Bearer tok");
    expect(r.stdout).toContain("mon_1");
    expect(r.stdout).toContain("https://a.test/x");
    expect(r.stdout).not.toContain("secret");
  });

  it("prints JSON with --json", async () => {
    const r = await cli(["categories", "list", "--json"], { "GET /api/categories": [200, { categories: [{ id: "c1" }] }] });
    expect(JSON.parse(r.stdout)).toEqual({ categories: [{ id: "c1" }] });
  });

  it("refuses to delete without --yes and makes no request", async () => {
    const r = await cli(["monitors", "delete", "mon_1"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--yes");
    expect(r.calls).toEqual([]);
    const ok = await cli(["monitors", "delete", "mon_1", "--yes"], { "DELETE /api/monitors/mon_1": [200, { ok: true }] });
    expect(ok.code).toBe(0);
    expect(ok.calls.map((c) => c.method)).toEqual(["DELETE"]);
  });

  it("updates with a PATCH holding only the given fields", async () => {
    const r = await cli(["monitors", "update", "mon_1", "--url", "https://b.test", "--private"], {
      "GET /api/monitors/mon_1": [200, { monitor: { id: "mon_1", type: "http", schedule: { mode: "always" } } }],
      "PATCH /api/monitors/mon_1": [200, { monitor: { id: "mon_1", name: "API" } }],
    });
    expect(r.code).toBe(0);
    expect(r.calls[1]).toMatchObject({ method: "PATCH", body: { config: { url: "https://b.test" }, public: { visible: false } } });
  });

  it("prints a heartbeat ping URL once on create", async () => {
    const r = await cli(["monitors", "create", "--type", "heartbeat", "--name", "Job", "--interval", "3600"], {
      "POST /api/monitors": [201, { monitor: { id: "mon_hb", type: "heartbeat", name: "Job", schedule: { mode: "always" }, heartbeatToken: "raw" } }],
    });
    expect(r.calls[0].body).toEqual({ type: "heartbeat", name: "Job", config: { intervalSeconds: 3600 } });
    expect(r.stdout).toContain("https://op.test/hb/raw");
  });

  it("reports API errors with their validation issues", async () => {
    const r = await cli(["monitors", "create", "--name", "Bad", "--url", "nope"], {
      "POST /api/monitors": [400, { error: "validation", issues: [{ path: ["config", "url"], message: "Invalid URL" }] }],
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("HTTP 400 validation");
    expect(r.stderr).toContain("config.url: Invalid URL");
  });

  it("exits 2 with a message on an unknown flag", async () => {
    const r = await cli(["uptime", "--montior", "mon_1"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Unknown flag --montior");
    expect(r.calls).toEqual([]);
  });
});
