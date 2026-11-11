import { describe, expect, it } from "vitest";
import { api } from "../routes/api";
import {
  PUBLIC_PREFIXES,
  PUBLIC_ROUTES,
  ROUTE_SCOPES,
  hasScope,
  insufficientScopeBody,
  normalizeScopes,
  parseScopes,
  routeAccess,
  SCOPES,
  toolScope,
} from "./scopes";
import { LEGACY_SCOPES, PERMISSIONS } from "../../shared/scopes";

/** Every concrete route the /api app serves, as "METHOD /api/path" (middleware left out). */
function registeredRoutes(): string[] {
  const keys = new Set<string>();
  for (const r of api.routes) {
    if (r.method === "ALL") continue;
    keys.add(`${r.method} /api${r.path === "/" ? "" : r.path}`.replace(/\/$/, ""));
  }
  return [...keys].sort();
}

const isPublic = (key: string) => {
  const path = key.slice(key.indexOf(" ") + 1);
  return PUBLIC_ROUTES.includes(key) || PUBLIC_PREFIXES.some((p) => path === p.replace(/\/$/, "") || path.startsWith(p));
};

describe("route scope table", () => {
  it("has a row for every authenticated /api route, so no route is open to tokens by accident", () => {
    const missing = registeredRoutes().filter((key) => !isPublic(key) && !Object.hasOwn(ROUTE_SCOPES, key));
    // A new route needs a row in ROUTE_SCOPES (or PUBLIC_ROUTES when it has no requireAuth).
    expect(missing).toEqual([]);
  });

  it("has no rows for routes that do not exist", () => {
    const routes = new Set(registeredRoutes());
    expect(Object.keys(ROUTE_SCOPES).filter((key) => !routes.has(key))).toEqual([]);
    expect(PUBLIC_ROUTES.filter((key) => !routes.has(key))).toEqual([]);
  });

  it("matches concrete paths, a literal segment winning over a parameter", () => {
    expect(routeAccess("GET", "/api/monitors/mon_1")).toBe("monitors:read");
    expect(routeAccess("HEAD", "/api/monitors")).toBe("monitors:read");
    expect(routeAccess("GET", "/api/monitors/uptime")).toBe("uptime:read");
    expect(routeAccess("GET", "/api/api-tokens/self")).toBe("token");
    expect(routeAccess("GET", "/api/incidents/export.csv")).toBe("incidents:read");
    expect(routeAccess("POST", "/api/monitors/mon_1/pause")).toBe("monitors:edit");
    expect(routeAccess("POST", "/api/monitors/mon_1/test")).toBe("monitors:edit");
    expect(routeAccess("DELETE", "/api/monitors/mon_1")).toBe("monitors:edit");
    expect(routeAccess("DELETE", "/api/api-tokens/tok_1")).toBe("session");
  });

  it("maps every route to exactly one permission that exists, and uses every permission", () => {
    const used = new Set<string>();
    for (const [key, access] of Object.entries(ROUTE_SCOPES)) {
      if (access === "token" || access === "session") continue;
      expect(PERMISSIONS as readonly string[], key).toContain(access);
      used.add(access);
    }
    expect(PERMISSIONS.filter((p) => !used.has(p))).toEqual([]);
  });

  it("offers only Read and Edit, or Read only, on every resource", () => {
    for (const p of PERMISSIONS) expect(p).toMatch(/:(read|edit)$/);
  });

  it("knows nothing about an unmapped route (requireScope then demands admin)", () => {
    expect(routeAccess("GET", "/api/brand-new-feature")).toBeNull();
    expect(routeAccess("POST", "/api/overview")).toBeNull();
    expect(routeAccess("GET", "/api/monitors/a/b/c/d")).toBeNull();
  });

  it("keeps settings, exports, key status and tokens out of the legacy read", () => {
    const read = normalizeScopes(["read"]);
    for (const key of [
      "GET /api/settings",
      "GET /api/data/export",
      "GET /api/admin/rekey/status",
      "GET /api/waitlist",
      "GET /api/passkeys",
    ]) {
      expect(read, key).not.toContain(ROUTE_SCOPES[key]);
    }
    expect(ROUTE_SCOPES["GET /api/api-tokens"]).toBe("session");
  });
});

describe("scopes", () => {
  it("parse, normalize and imply", () => {
    expect(parseScopes("monitors:edit bogus")).toEqual(["monitors:read", "monitors:edit"]);
    expect(parseScopes(null)).toEqual([]);
    expect(normalizeScopes(["incidents:read", "monitors:edit", "monitors:edit"])).toEqual([
      "monitors:read",
      "monitors:edit",
      "incidents:read",
    ]);
    expect(normalizeScopes(["monitors:read", "admin"])).toEqual(["admin"]);
    // Removed ids from the draft (and anything else unknown) are dropped.
    expect(normalizeScopes(["monitors:delete"])).toEqual([]);
    expect(hasScope(["admin"], "maintenance:edit")).toBe(true);
    expect(hasScope(["monitors:read"], "monitors:edit")).toBe(false);
  });

  it("expand the older scope words to the same access", () => {
    expect(parseScopes("monitors:write")).toEqual(["monitors:read", "monitors:edit"]);
    expect(parseScopes("incidents:write")).toEqual(["incidents:read", "incidents:edit"]);
    expect(parseScopes("maintenance:write")).toEqual(["maintenance:read", "maintenance:edit"]);
    expect(parseScopes("read")).toEqual([...LEGACY_SCOPES.read].sort((a, b) => SCOPES.indexOf(a) - SCOPES.indexOf(b)));
    expect(parseScopes("admin read")).toEqual(["admin"]);
  });

  it("never reuse an older scope word as a permission id, so a rollback refuses new tokens", () => {
    for (const word of Object.keys(LEGACY_SCOPES)) expect(SCOPES as readonly string[]).not.toContain(word);
  });

  it("make an unknown MCP tool admin only", () => {
    expect(toolScope("list_monitors")).toBe("monitors:read");
    expect(toolScope("delete_monitor")).toBe("monitors:edit");
    expect(toolScope("something_new")).toBe("admin");
    expect(toolScope("constructor")).toBe("admin");
  });

  it("explain a refusal by naming the missing scope", () => {
    const body = insufficientScopeBody("monitors:edit", ["monitors:read"]);
    expect(body).toMatchObject({
      error: "insufficient_scope",
      required: "monitors:edit",
      scopes: ["monitors:read"],
    });
    expect(body.message).toContain("monitors:edit");
  });
});
