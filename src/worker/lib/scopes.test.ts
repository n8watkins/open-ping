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
  toolScope,
} from "./scopes";

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
    expect(routeAccess("GET", "/api/monitors/mon_1")).toBe("read");
    expect(routeAccess("HEAD", "/api/monitors")).toBe("read");
    expect(routeAccess("GET", "/api/api-tokens/self")).toBe("token");
    expect(routeAccess("GET", "/api/incidents/export.csv")).toBe("read");
    expect(routeAccess("POST", "/api/monitors/mon_1/pause")).toBe("monitors:write");
    expect(routeAccess("DELETE", "/api/monitors/mon_1")).toBe("admin");
    expect(routeAccess("DELETE", "/api/api-tokens/tok_1")).toBe("session");
  });

  it("knows nothing about an unmapped route (requireScope then demands admin)", () => {
    expect(routeAccess("GET", "/api/brand-new-feature")).toBeNull();
    expect(routeAccess("POST", "/api/overview")).toBeNull();
    expect(routeAccess("GET", "/api/monitors/a/b/c/d")).toBeNull();
  });

  it("keeps settings, exports, key status and tokens out of read", () => {
    for (const key of ["GET /api/settings", "GET /api/data/export", "GET /api/admin/rekey/status", "GET /api/waitlist"]) {
      expect(ROUTE_SCOPES[key], key).toBe("admin");
    }
    expect(ROUTE_SCOPES["GET /api/api-tokens"]).toBe("session");
    expect(ROUTE_SCOPES["GET /api/passkeys"]).toBe("admin");
  });
});

describe("scopes", () => {
  it("parse, normalize and imply", () => {
    expect(parseScopes("read monitors:write bogus")).toEqual(["read", "monitors:write"]);
    expect(parseScopes(null)).toEqual([]);
    expect(normalizeScopes(["monitors:write", "read", "read"])).toEqual(["read", "monitors:write"]);
    expect(normalizeScopes(["read", "admin"])).toEqual(["admin"]);
    expect(hasScope(["admin"], "maintenance:write")).toBe(true);
    expect(hasScope(["read"], "monitors:write")).toBe(false);
  });

  it("make an unknown MCP tool admin only", () => {
    expect(toolScope("list_monitors")).toBe("read");
    expect(toolScope("delete_monitor")).toBe("admin");
    expect(toolScope("something_new")).toBe("admin");
    expect(toolScope("constructor")).toBe("admin");
  });

  it("explain a refusal by naming the missing scope", () => {
    const body = insufficientScopeBody("monitors:write", ["read"]);
    expect(body).toMatchObject({ error: "insufficient_scope", required: "monitors:write", scopes: ["read"] });
    expect(body.message).toContain("monitors:write");
  });
});
