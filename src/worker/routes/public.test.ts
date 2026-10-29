import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks. The public route pulls monitors, maintenance and the resolved
// status page from these DB modules; we stub the async readers so each test can
// drive the exact fixture it needs. `selectPageMonitors` (a pure helper) is kept
// REAL via importOriginal so the per-page filtering under test is the production
// code, not a stub. `getSetting` stays mocked to null as the legacy fallback
// path (used by the disabled/no-DB cache-header test).
// ---------------------------------------------------------------------------
vi.mock("../db/settings", () => ({
  getSetting: vi.fn(async () => null),
}));
vi.mock("../db/monitors", () => ({
  listMonitors: vi.fn(async () => []),
}));
vi.mock("../db/maintenance", () => ({
  publicMaintenance: vi.fn(async () => ({ active: [], upcoming: [] })),
}));
vi.mock("../db/status-pages", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/status-pages")>();
  return {
    ...actual, // keep the real, pure selectPageMonitors
    getDefaultPage: vi.fn(async () => null),
    getStatusPageBySlug: vi.fn(async () => null),
  };
});

import {
  computeOverall,
  computeUptimeAndBars,
  publicStatus,
  type PublicServiceState,
} from "./public";
import type { Env } from "../types";
import type { MonitorRecord } from "../db/monitors";
import type { MaintenanceWindow } from "../db/maintenance";
import type { StatusPageRecord } from "../db/status-pages";
import type { PublicConfig } from "../../shared/schemas";
import type { MonitorState } from "../../shared/states";
import { listMonitors } from "../db/monitors";
import { publicMaintenance } from "../db/maintenance";
import { getDefaultPage, getStatusPageBySlug } from "../db/status-pages";
import { getSetting } from "../db/settings";

/** Tiny factory for a service with only the state field computeOverall reads. */
function svc(state: PublicServiceState): { state: PublicServiceState } {
  return { state };
}

describe("computeOverall", () => {
  it("returns all_off when there are no public services", () => {
    expect(computeOverall([], false)).toBe("all_off");
    // No services beats even an active maintenance window.
    expect(computeOverall([], true)).toBe("all_off");
  });

  it("returns operational when all services are up", () => {
    expect(computeOverall([svc("operational"), svc("operational")], false)).toBe(
      "operational",
    );
  });

  it("returns all_off when every service is scheduled off", () => {
    expect(computeOverall([svc("scheduled_off")], false)).toBe("all_off");
    expect(
      computeOverall([svc("scheduled_off"), svc("scheduled_off")], false),
    ).toBe("all_off");
  });

  it("keeps a page with some services off-hours and the rest up operational", () => {
    expect(
      computeOverall([svc("operational"), svc("scheduled_off")], false),
    ).toBe("operational");
  });

  it("lets maintenance and outages win over an all-off page", () => {
    expect(
      computeOverall([svc("scheduled_off"), svc("scheduled_off")], true),
    ).toBe("maintenance");
    expect(
      computeOverall([svc("down"), svc("scheduled_off"), svc("scheduled_off")], false),
    ).toBe("partial_outage");
    expect(
      computeOverall([svc("degraded"), svc("scheduled_off")], false),
    ).toBe("degraded");
  });

  it("treats maintenance/scheduled_off/unknown as non-outage states", () => {
    expect(
      computeOverall(
        [
          svc("operational"),
          svc("maintenance"),
          svc("scheduled_off"),
          svc("unknown"),
        ],
        false,
      ),
    ).toBe("operational");
  });

  it("returns degraded when some services are degraded and none are down", () => {
    expect(computeOverall([svc("operational"), svc("degraded")], false)).toBe(
      "degraded",
    );
  });

  it("returns partial_outage when some (but not all) services are down", () => {
    expect(computeOverall([svc("operational"), svc("down")], false)).toBe(
      "partial_outage",
    );
    expect(computeOverall([svc("degraded"), svc("down")], false)).toBe(
      "partial_outage",
    );
  });

  it("returns major_outage when every service is down", () => {
    expect(computeOverall([svc("down")], false)).toBe("major_outage");
    expect(computeOverall([svc("down"), svc("down")], false)).toBe(
      "major_outage",
    );
  });

  it("counts a suspended service as an outage (never operational)", () => {
    // A suspended (turned-off) service is unavailable, so it behaves like down.
    expect(computeOverall([svc("suspended")], false)).toBe("major_outage");
    expect(computeOverall([svc("operational"), svc("suspended")], false)).toBe(
      "partial_outage",
    );
    // Mixed down + suspended is still a full outage when nothing is up.
    expect(computeOverall([svc("down"), svc("suspended")], false)).toBe(
      "major_outage",
    );
    // An outage (suspended) beats an active maintenance window.
    expect(computeOverall([svc("suspended")], true)).toBe("major_outage");
  });

  it("returns maintenance when a window is active and there are no outages", () => {
    expect(computeOverall([svc("operational")], true)).toBe("maintenance");
    // Maintenance takes precedence over a merely-degraded service.
    expect(computeOverall([svc("operational"), svc("degraded")], true)).toBe(
      "maintenance",
    );
  });

  it("lets outages take precedence over an active maintenance window", () => {
    expect(computeOverall([svc("down")], true)).toBe("major_outage");
    expect(computeOverall([svc("operational"), svc("down")], true)).toBe(
      "partial_outage",
    );
  });
});

describe("computeOverall with never-checked (unknown) services", () => {
  it("waits for the first checks when every service is unknown", () => {
    expect(computeOverall([svc("unknown")], false)).toBe("awaiting_data");
    expect(computeOverall([svc("unknown"), svc("unknown")], false)).toBe("awaiting_data");
  });

  it("does not count unknown services toward operational or outage size", () => {
    expect(computeOverall([svc("operational"), svc("unknown")], false)).toBe("operational");
    // The only service with a state is down: that is the whole known page.
    expect(computeOverall([svc("down"), svc("unknown")], false)).toBe("major_outage");
    expect(computeOverall([svc("down"), svc("operational"), svc("unknown")], false)).toBe(
      "partial_outage",
    );
    expect(computeOverall([svc("scheduled_off"), svc("unknown")], false)).toBe("all_off");
  });

  it("still lets maintenance and degraded win over a page of unknowns", () => {
    expect(computeOverall([svc("unknown")], true)).toBe("maintenance");
    expect(computeOverall([svc("degraded"), svc("unknown")], false)).toBe("degraded");
  });
});

describe("computeUptimeAndBars", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 5, 29, 12, 0, 0); // 2026-06-29T12:00:00Z

  it("reports no uptime figure and 90 empty bars when there is no data", () => {
    const { uptime90d, bars } = computeUptimeAndBars([], now);
    // A never-checked service has earned no uptime: null, never 100%.
    expect(uptime90d).toBeNull();
    expect(bars).toHaveLength(90);
    expect(bars.every((b) => b.uptimePct === null && b.state === "none")).toBe(
      true,
    );
    // Oldest first, newest (today) last.
    expect(bars[89]!.date).toBe("2026-06-29");
    expect(bars[0]!.date).toBe("2026-04-01");
  });

  it("computes uptime % and maps per-day bar state", () => {
    const today = Date.UTC(2026, 5, 29, 0, 0, 0);
    const rows = [
      { bucket_start: today, checks: 10, ok_checks: 10 }, // up
      { bucket_start: today - DAY, checks: 10, ok_checks: 5 }, // degraded
      { bucket_start: today - 2 * DAY, checks: 10, ok_checks: 0 }, // down
    ];
    const { uptime90d, bars } = computeUptimeAndBars(rows, now);
    // 15 ok of 30 checks => 50%.
    expect(uptime90d).toBe(50);
    const byDate = new Map(bars.map((b) => [b.date, b]));
    expect(byDate.get("2026-06-29")?.state).toBe("up");
    expect(byDate.get("2026-06-29")?.uptimePct).toBe(100);
    expect(byDate.get("2026-06-28")?.state).toBe("degraded");
    expect(byDate.get("2026-06-28")?.uptimePct).toBe(50);
    expect(byDate.get("2026-06-27")?.state).toBe("down");
    expect(byDate.get("2026-06-27")?.uptimePct).toBe(0);
  });
});

describe("GET /status cache header", () => {
  beforeEach(() => {
    // No status_pages row + all settings null → disabled default page → early
    // return. Nothing touches D1, so the header can be asserted in isolation.
    vi.mocked(getSetting).mockResolvedValue(null);
    vi.mocked(getDefaultPage).mockResolvedValue(null);
  });

  it("sets a short public Cache-Control header so the CDN can absorb load", async () => {
    // Settings are all mocked to null → status page disabled → early return,
    // but the header is set before that branch, so it is present regardless.
    const res = await publicStatus.request("/status", {}, {} as Env);
    expect(res.status).toBe(200);
    const cacheControl = res.headers.get("Cache-Control");
    expect(cacheControl).toContain("public");
    expect(cacheControl).toMatch(/max-age=\d+/);
  });
});

// ---------------------------------------------------------------------------
// Per-page resolution + scoping + redaction (PRD §16 multiple status pages).
// ---------------------------------------------------------------------------

/** A `status_pages` record with sensible defaults, overridable per test. */
function makePage(overrides: Partial<StatusPageRecord> = {}): StatusPageRecord {
  return {
    id: "sp1",
    slug: "default",
    name: "Test Page",
    description: null,
    enabled: true,
    isDefault: true,
    includeMode: "all",
    categoryIds: [],
    monitorIds: [],
    theme: null,
    accent: null,
    logo: null,
    homepage: null,
    footer: null,
    attribution: true,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/**
 * A visible monitor record. Every instance carries deliberately-secret config,
 * a heartbeat token, so redaction assertions can prove those never surface.
 */
function makeMonitor(
  id: string,
  opts: {
    name?: string;
    categoryId?: string | null;
    public?: Partial<PublicConfig>;
    type?: MonitorRecord["type"];
  } = {},
): MonitorRecord {
  const pub: PublicConfig = {
    visible: true,
    sortOrder: 0,
    showUptime: false,
    showResponseTime: false,
    showIncidentDetails: true,
    ...opts.public,
  };
  return {
    id,
    type: opts.type ?? "http",
    name: opts.name ?? id,
    enabled: true,
    paused: false,
    intervalSeconds: 720,
    graceSeconds: null,
    // Secret config that MUST NOT appear in any public payload:
    config: { url: "https://secret.internal/health", body: "SECRET_BODY" },
    schedule: { mode: "always" },
    assertions: [],
    notify: { channels: [] },
    public: pub,
    categoryId: opts.categoryId ?? null,
    heartbeatToken: "SECRET_TOKEN",
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
  } as unknown as MonitorRecord;
}

/** A maintenance window with defaults; overridable scope/monitorIds/message. */
function makeWindow(overrides: Partial<MaintenanceWindow> = {}): MaintenanceWindow {
  return {
    id: "mw",
    title: "internal-label",
    scope: "global",
    monitorIds: null,
    startsAt: 0,
    endsAt: 0,
    recurrence: null,
    publicMessage: "msg",
    privateNotes: "SECRET_NOTES",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

interface FakeIncident {
  id: string;
  monitor_id: string;
  status: "open" | "resolved";
  public: number;
  started_at: number;
  resolved_at: number | null;
  duration_seconds: number | null;
  public_message: string | null;
  // Fields the SELECT never asks for; present to prove the projection drops them.
  error: string;
  title: string;
  private_notes: string;
}

function makeIncident(
  o: Pick<FakeIncident, "id" | "monitor_id" | "status"> & Partial<FakeIncident>,
): FakeIncident {
  return {
    public: 1,
    started_at: 1000,
    resolved_at: o.status === "resolved" ? 2000 : null,
    duration_seconds: o.status === "resolved" ? 60 : null,
    public_message: "public copy",
    error: "SECRET_INC_ERROR",
    title: "SECRET_INC_TITLE",
    private_notes: "SECRET_INC_NOTES",
    ...o,
  };
}

interface FakeState {
  monitor_id: string;
  state: MonitorState;
  state_since?: number | null;
  last_duration_ms?: number | null;
  last_checked_at?: number | null;
  last_error?: string;
}

/**
 * Minimal D1 stub. Answers the three queries the route issues directly:
 * monitor_state, summaries, and the two per-page incident selects. For
 * incidents it honours the `monitor_id IN (...)` scoping by filtering on the
 * bound ids - so if the route ever dropped that clause, off-page rows would leak
 * through here and the redaction-scope test would fail (as intended).
 */
function makeDb(fixture: {
  states?: FakeState[];
  incidents?: FakeIncident[];
  summaries?: { bucket_start: number; checks: number; ok_checks: number }[];
}): Env {
  const states = fixture.states ?? [];
  const incidents = fixture.incidents ?? [];
  const summaries = fixture.summaries ?? [];

  const prepare = (sql: string) => {
    let bound: unknown[] = [];
    const api = {
      bind(...args: unknown[]) {
        bound = args;
        return api;
      },
      async all() {
        if (sql.includes("FROM monitor_state")) return { results: states };
        if (sql.includes("FROM summaries")) return { results: summaries };
        if (sql.includes("FROM incidents")) {
          const status = sql.includes("status = 'open'") ? "open" : "resolved";
          let rows = incidents.filter(
            (i) => i.public === 1 && i.status === status,
          );
          if (sql.includes("monitor_id IN")) {
            // The page's ids are bound first, as one JSON array (db/sql-list.ts).
            const ids = new Set(JSON.parse(String(bound[0])) as string[]);
            rows = rows.filter((i) => ids.has(i.monitor_id));
          }
          return { results: rows };
        }
        return { results: [] };
      },
    };
    return api;
  };

  return { DB: { prepare } } as unknown as Env;
}

describe("GET /status per-page resolution + scoping", () => {
  beforeEach(() => {
    vi.mocked(getSetting).mockResolvedValue(null);
    vi.mocked(listMonitors).mockResolvedValue([]);
    vi.mocked(publicMaintenance).mockResolvedValue({ active: [], upcoming: [] });
    vi.mocked(getDefaultPage).mockResolvedValue(null);
    vi.mocked(getStatusPageBySlug).mockResolvedValue(null);
  });

  it("?slug=X returns only that page's monitors (category scoping)", async () => {
    vi.mocked(getStatusPageBySlug).mockResolvedValue(
      makePage({ slug: "api", includeMode: "categories", categoryIds: ["cat-api"] }),
    );
    vi.mocked(listMonitors).mockResolvedValue([
      makeMonitor("mon-api", { name: "API", categoryId: "cat-api" }),
      makeMonitor("mon-db", { name: "Database", categoryId: "cat-db" }),
    ]);
    const env = makeDb({
      states: [
        { monitor_id: "mon-api", state: "up" },
        { monitor_id: "mon-db", state: "down" },
      ],
    });

    const res = await publicStatus.request("/status?slug=api", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(vi.mocked(getStatusPageBySlug)).toHaveBeenCalledWith(
      expect.anything(),
      "api",
    );
    const names = body.groups.flatMap((g: any) => g.services.map((s: any) => s.name));
    expect(names).toEqual(["API"]);
    // The off-page monitor is DOWN, but excluded, so it must not drive overall.
    expect(body.overall).toBe("operational");
    expect(JSON.stringify(body)).not.toContain("Database");
  });

  it("does NOT surface an off-page monitor's incident or scoped maintenance (redaction-scope)", async () => {
    vi.mocked(getStatusPageBySlug).mockResolvedValue(
      makePage({ slug: "api", includeMode: "monitors", monitorIds: ["mon-api"] }),
    );
    vi.mocked(listMonitors).mockResolvedValue([
      makeMonitor("mon-api", { name: "API" }),
      makeMonitor("mon-db", { name: "Database" }), // visible but off THIS page
    ]);
    vi.mocked(publicMaintenance).mockResolvedValue({
      active: [
        makeWindow({ scope: "global", publicMessage: "Global maintenance" }),
        makeWindow({
          scope: "monitors",
          monitorIds: ["mon-api"],
          publicMessage: "API maintenance",
        }),
        makeWindow({
          scope: "monitors",
          monitorIds: ["mon-db"], // off-page → must be dropped
          publicMessage: "DB maintenance",
        }),
      ],
      upcoming: [],
    });
    const env = makeDb({
      states: [
        { monitor_id: "mon-api", state: "up" },
        { monitor_id: "mon-db", state: "down" },
      ],
      incidents: [
        makeIncident({ id: "inc-api", monitor_id: "mon-api", status: "open", public_message: "API down" }),
        makeIncident({ id: "inc-db", monitor_id: "mon-db", status: "open", public_message: "DB down" }),
        makeIncident({ id: "inc-api-r", monitor_id: "mon-api", status: "resolved", public_message: "API fixed" }),
        makeIncident({ id: "inc-db-r", monitor_id: "mon-db", status: "resolved", public_message: "DB fixed" }),
      ],
    });

    const res = await publicStatus.request("/status?slug=api", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    const activeIds = body.activeIncidents.map((i: any) => i.id);
    expect(activeIds).toContain("inc-api");
    expect(activeIds).not.toContain("inc-db");
    const recentIds = body.recentIncidents.map((i: any) => i.id);
    expect(recentIds).toContain("inc-api-r");
    expect(recentIds).not.toContain("inc-db-r");

    const maintMsgs = body.maintenance.active.map((m: any) => m.message);
    expect(maintMsgs).toEqual(
      expect.arrayContaining(["Global maintenance", "API maintenance"]),
    );
    expect(maintMsgs).not.toContain("DB maintenance");

    // Nothing about the off-page monitor may leak (name, incident copy, error).
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("Database");
    expect(serialized).not.toContain("DB down");
    expect(serialized).not.toContain("DB fixed");
  });

  it("returns 404 for an unknown slug (never falls back to the default page)", async () => {
    vi.mocked(getStatusPageBySlug).mockResolvedValue(null);
    const res = await publicStatus.request("/status?slug=nope", {}, {} as Env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("returns the disabled early-return shape for a disabled page", async () => {
    vi.mocked(getDefaultPage).mockResolvedValue(
      makePage({ name: "Off Page", enabled: false }),
    );
    const res = await publicStatus.request("/status", {}, {} as Env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: false,
      page: { name: "Off Page" },
    });
  });

  it("upholds the redaction contract on a per-category page (no config/URLs/tokens/errors)", async () => {
    vi.mocked(getStatusPageBySlug).mockResolvedValue(
      makePage({ slug: "api", includeMode: "categories", categoryIds: ["cat-api"] }),
    );
    vi.mocked(listMonitors).mockResolvedValue([
      makeMonitor("mon-api", {
        name: "Public API",
        categoryId: "cat-api",
        public: { showResponseTime: true },
      }),
    ]);
    const env = makeDb({
      states: [
        {
          monitor_id: "mon-api",
          state: "up",
          last_duration_ms: 123,
          last_checked_at: 999,
          last_error: "SECRET_LAST_ERROR",
        },
      ],
      incidents: [
        makeIncident({
          id: "inc1",
          monitor_id: "mon-api",
          status: "resolved",
          public_message: "All good now",
        }),
      ],
    });

    const res = await publicStatus.request("/status?slug=api", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const serialized = JSON.stringify(body);

    // Redacted: monitor config/URL, heartbeat token, monitor_state error,
    // incident error, internal incident title, private maintenance notes.
    expect(serialized).not.toContain("secret.internal");
    expect(serialized).not.toContain("SECRET_BODY");
    expect(serialized).not.toContain("SECRET_TOKEN");
    expect(serialized).not.toContain("SECRET_LAST_ERROR");
    expect(serialized).not.toContain("SECRET_INC_ERROR");
    expect(serialized).not.toContain("SECRET_INC_TITLE");
    expect(serialized).not.toContain("SECRET_INC_NOTES");

    // Surfaced: only admin-authored public copy + the public display name.
    expect(serialized).toContain("Public API");
    const inc = body.recentIncidents[0];
    expect(inc.message).toBe("All good now");
    expect(inc.title).toBe("Public API incident"); // rebuilt from public name
    expect(inc.monitorName).toBe("Public API");
    const service = body.groups.flatMap((g: any) => g.services)[0];
    expect(service.latestMs).toBe(123);
  });
});

describe("GET /status off-hours (scheduled_off)", () => {
  beforeEach(() => {
    vi.mocked(getSetting).mockResolvedValue(null);
    vi.mocked(listMonitors).mockResolvedValue([]);
    vi.mocked(publicMaintenance).mockResolvedValue({ active: [], upcoming: [] });
    vi.mocked(getDefaultPage).mockResolvedValue(makePage());
    vi.mocked(getStatusPageBySlug).mockResolvedValue(null);
  });

  const FRI_4_48_PM = Date.UTC(2026, 9, 23, 23, 48); // Fri 16:48 in Los Angeles

  it("reports an off-hours monitor as scheduled_off with the time it went off", async () => {
    vi.mocked(listMonitors).mockResolvedValue([
      makeMonitor("mon-echo", { name: "Echo" }),
      makeMonitor("mon-scout", { name: "Scout" }),
    ]);
    const env = makeDb({
      states: [
        {
          monitor_id: "mon-echo",
          state: "scheduled_off",
          state_since: FRI_4_48_PM + 60_000,
          last_checked_at: FRI_4_48_PM,
        },
        {
          monitor_id: "mon-scout",
          state: "up",
          state_since: 5,
          last_checked_at: FRI_4_48_PM,
        },
      ],
    });

    const res = await publicStatus.request("/status", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const services = body.groups.flatMap((g: any) => g.services);
    const echo = services.find((s: any) => s.name === "Echo");
    const scout = services.find((s: any) => s.name === "Scout");

    expect(echo.state).toBe("scheduled_off");
    expect(echo.since).toBe(FRI_4_48_PM + 60_000);
    // Only off-hours carries a time: a "down since" would leak an outage that
    // was never made public as an incident.
    expect(scout.state).toBe("operational");
    expect(scout.since).toBeNull();
    // Some off, the rest up: off-hours never count as an outage.
    expect(body.overall).toBe("operational");
  });

  it("shows an expiry warning on its row without turning the page Degraded", async () => {
    vi.mocked(listMonitors).mockResolvedValue([
      makeMonitor("mon-site", { name: "Site" }),
      makeMonitor("mon-cert", { name: "Certificate", type: "cert" }),
      makeMonitor("mon-domain", { name: "Domain", type: "domain" }),
    ]);
    const env = makeDb({
      states: [
        { monitor_id: "mon-site", state: "up" },
        { monitor_id: "mon-cert", state: "degraded" },
        { monitor_id: "mon-domain", state: "degraded" },
      ],
    });
    const body = (await (await publicStatus.request("/status", {}, env)).json()) as any;
    const services = body.groups.flatMap((g: any) => g.services);
    expect(services.map((s: any) => [s.name, s.state])).toEqual([
      ["Certificate", "degraded"],
      ["Domain", "degraded"],
      ["Site", "operational"],
    ]);
    expect(body.overall).toBe("operational");
  });

  it("still lets an expired certificate, and a slow HTTP monitor, set the banner", async () => {
    vi.mocked(listMonitors).mockResolvedValue([
      makeMonitor("mon-site", { name: "Site" }),
      makeMonitor("mon-cert", { name: "Certificate", type: "cert" }),
    ]);
    const slow = makeDb({
      states: [
        { monitor_id: "mon-site", state: "degraded" },
        { monitor_id: "mon-cert", state: "up" },
      ],
    });
    expect(((await (await publicStatus.request("/status", {}, slow)).json()) as any).overall).toBe("degraded");
    const expired = makeDb({
      states: [
        { monitor_id: "mon-site", state: "up" },
        { monitor_id: "mon-cert", state: "down" },
      ],
    });
    expect(((await (await publicStatus.request("/status", {}, expired)).json()) as any).overall).toBe("partial_outage");
  });

  it("falls back to the last check time when state_since is missing", async () => {
    vi.mocked(listMonitors).mockResolvedValue([makeMonitor("mon-echo", { name: "Echo" })]);
    const env = makeDb({
      states: [
        { monitor_id: "mon-echo", state: "scheduled_off", last_checked_at: FRI_4_48_PM },
      ],
    });
    const body = (await (await publicStatus.request("/status", {}, env)).json()) as any;
    expect(body.groups[0].services[0].since).toBe(FRI_4_48_PM);
  });

  it("reads all_off and still lists the services when every monitor is off", async () => {
    vi.mocked(listMonitors).mockResolvedValue([
      makeMonitor("mon-echo", { name: "Echo" }),
      makeMonitor("mon-scout", { name: "Scout" }),
    ]);
    const env = makeDb({
      states: [
        { monitor_id: "mon-echo", state: "scheduled_off", state_since: 10 },
        { monitor_id: "mon-scout", state: "scheduled_off", state_since: 20 },
      ],
    });

    const body = (await (await publicStatus.request("/status", {}, env)).json()) as any;
    expect(body.overall).toBe("all_off");
    const services = body.groups.flatMap((g: any) => g.services);
    expect(services.map((s: any) => [s.name, s.state])).toEqual([
      ["Echo", "scheduled_off"],
      ["Scout", "scheduled_off"],
    ]);
  });

  it("ignores a legacy showScheduledOff: false and still reports scheduled_off", async () => {
    // Monitors saved before the option was removed may still carry it.
    vi.mocked(listMonitors).mockResolvedValue([
      makeMonitor("mon-echo", {
        name: "Echo",
        public: { showScheduledOff: false } as Partial<PublicConfig>,
      }),
    ]);
    const env = makeDb({
      states: [{ monitor_id: "mon-echo", state: "scheduled_off", state_since: 10 }],
    });
    const body = (await (await publicStatus.request("/status", {}, env)).json()) as any;
    expect(body.groups[0].services[0].state).toBe("scheduled_off");
    expect(body.overall).toBe("all_off");
  });

  it("applies the same projection on a per-category page (?slug=)", async () => {
    vi.mocked(getStatusPageBySlug).mockResolvedValue(
      makePage({ slug: "apps", includeMode: "categories", categoryIds: ["cat-apps"] }),
    );
    vi.mocked(listMonitors).mockResolvedValue([
      makeMonitor("mon-echo", { name: "Echo", categoryId: "cat-apps" }),
    ]);
    const env = makeDb({
      states: [{ monitor_id: "mon-echo", state: "scheduled_off", state_since: 10 }],
    });
    const body = (await (await publicStatus.request("/status?slug=apps", {}, env)).json()) as any;
    expect(body.groups[0].services[0].state).toBe("scheduled_off");
    expect(body.overall).toBe("all_off");
  });
});

describe("GET /badge.svg per-page resolution", () => {
  beforeEach(() => {
    vi.mocked(getSetting).mockResolvedValue(null);
    vi.mocked(listMonitors).mockResolvedValue([]);
    vi.mocked(publicMaintenance).mockResolvedValue({ active: [], upcoming: [] });
    vi.mocked(getDefaultPage).mockResolvedValue(null);
    vi.mocked(getStatusPageBySlug).mockResolvedValue(null);
  });

  it("scopes the badge overall state to the resolved page's monitors", async () => {
    vi.mocked(getStatusPageBySlug).mockResolvedValue(
      makePage({ slug: "api", includeMode: "categories", categoryIds: ["cat-api"] }),
    );
    vi.mocked(listMonitors).mockResolvedValue([
      makeMonitor("mon-api", { name: "API", categoryId: "cat-api" }),
      makeMonitor("mon-db", { name: "Database", categoryId: "cat-db" }),
    ]);
    const env = makeDb({
      states: [
        { monitor_id: "mon-api", state: "up" },
        { monitor_id: "mon-db", state: "down" }, // off-page: must not affect badge
      ],
    });

    const res = await publicStatus.request("/badge.svg?slug=api", {}, env);
    expect(res.status).toBe(200);
    const svg = await res.text();
    expect(svg).toContain("operational");
    expect(svg).not.toContain("outage");
  });

  it("reads off hours when every service on the page is scheduled off", async () => {
    vi.mocked(getDefaultPage).mockResolvedValue(makePage());
    vi.mocked(listMonitors).mockResolvedValue([
      makeMonitor("mon-echo", { name: "Echo" }),
      makeMonitor("mon-scout", { name: "Scout" }),
    ]);
    const env = makeDb({
      states: [
        { monitor_id: "mon-echo", state: "scheduled_off" },
        { monitor_id: "mon-scout", state: "scheduled_off" },
      ],
    });
    const svg = await (await publicStatus.request("/badge.svg", {}, env)).text();
    expect(svg).toContain("status: off hours");
    expect(svg).not.toContain("operational");
  });

  it("stays operational when only some services are scheduled off", async () => {
    vi.mocked(getDefaultPage).mockResolvedValue(makePage());
    vi.mocked(listMonitors).mockResolvedValue([
      makeMonitor("mon-echo", { name: "Echo" }),
      makeMonitor("mon-scout", { name: "Scout" }),
    ]);
    const env = makeDb({
      states: [
        { monitor_id: "mon-echo", state: "scheduled_off" },
        { monitor_id: "mon-scout", state: "up" },
      ],
    });
    const svg = await (await publicStatus.request("/badge.svg", {}, env)).text();
    expect(svg).toContain("status: operational");
  });

  it("keeps the no services badge for a page with no public services", async () => {
    vi.mocked(getDefaultPage).mockResolvedValue(makePage());
    const svg = await (await publicStatus.request("/badge.svg", {}, makeDb({}))).text();
    expect(svg).toContain("status: no services");
  });

  it("renders the neutral unknown badge for an unknown slug", async () => {
    vi.mocked(getStatusPageBySlug).mockResolvedValue(null);
    const res = await publicStatus.request("/badge.svg?slug=nope", {}, {} as Env);
    expect(res.status).toBe(200);
    const svg = await res.text();
    expect(svg).toContain("unknown");
  });
});
