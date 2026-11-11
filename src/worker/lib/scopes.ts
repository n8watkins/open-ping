/**
 * What an API token may do: its scopes, and the one table that says which
 * scope each authenticated REST route and MCP tool needs.
 *
 * DEFAULT DENY. A route or tool missing from these tables needs `admin`, so a
 * new feature is never open to a narrower token by accident. A browser session
 * is the owner and is never limited by scopes. scopes.test.ts fails when a
 * route is registered without a row here, so every new route is a decision.
 */

import { SCOPES, type Scope } from "../../shared/scopes";

export { SCOPES, type Scope };

export function isScope(value: string): value is Scope {
  return (SCOPES as readonly string[]).includes(value);
}

/** Parse a stored scopes column ('read monitors:write'); unknown words are dropped. */
export function parseScopes(stored: string | null | undefined): Scope[] {
  const out = new Set<Scope>();
  for (const word of (stored ?? "").split(/[\s,]+/)) if (isScope(word)) out.add(word);
  return SCOPES.filter((s) => out.has(s));
}

/** The canonical stored form: known scopes in table order; just 'admin' when admin is in it. */
export function normalizeScopes(scopes: readonly string[]): Scope[] {
  const parsed = parseScopes(scopes.join(" "));
  return parsed.includes("admin") ? ["admin"] : parsed;
}

/** Whether a token with `scopes` has `needed`. `admin` implies every scope. */
export function hasScope(scopes: readonly Scope[], needed: Scope): boolean {
  return scopes.includes("admin") || scopes.includes(needed);
}

/**
 * Who may call an authenticated route:
 * - a scope: a session, or a token with that scope (or admin);
 * - "token": a session or any valid token (it only describes the caller);
 * - "session": a signed-in browser session only, never a token, not even admin.
 * Public routes (no requireAuth) are listed in PUBLIC_ROUTES instead.
 */
export type RouteAccess = Scope | "token" | "session";

/**
 * Every authenticated REST route under /api, as "METHOD /api/path" with Hono's
 * `:param` segments. HEAD is checked as GET.
 */
export const ROUTE_SCOPES: Record<string, RouteAccess> = {
  // Overview, uptime, reports, diagnostics
  "GET /api/overview": "read",
  "GET /api/overview/history": "read",
  "GET /api/reports/monthly": "read",
  "GET /api/diagnostics": "read",
  "GET /api/diagnostics/usage": "read",

  // Monitors: no delete or heartbeat token rotation below admin
  "GET /api/monitors": "read",
  "GET /api/monitors/uptime": "read",
  "GET /api/monitors/:id": "read",
  "GET /api/monitors/:id/detail": "read",
  "GET /api/monitors/:id/history": "read",
  "POST /api/monitors": "monitors:write",
  "PUT /api/monitors/:id": "monitors:write",
  "PATCH /api/monitors/:id": "monitors:write",
  "POST /api/monitors/:id/pause": "monitors:write",
  "POST /api/monitors/:id/resume": "monitors:write",
  "POST /api/monitors/:id/test": "monitors:write",
  "DELETE /api/monitors/:id": "admin",
  "POST /api/monitors/:id/rotate-heartbeat-token": "admin",

  // Incidents
  "GET /api/incidents": "read",
  "GET /api/incidents/export.json": "read",
  "GET /api/incidents/export.csv": "read",
  "GET /api/incidents/:id": "read",
  "PATCH /api/incidents/:id": "incidents:write",
  "POST /api/incidents/:id/updates": "incidents:write",
  "PATCH /api/incidents/:id/updates/:updateId": "incidents:write",
  "DELETE /api/incidents/:id/updates/:updateId": "incidents:write",

  // Maintenance: deleting a window that has started needs admin (routes/maintenance.ts)
  "GET /api/maintenance": "read",
  "GET /api/maintenance/:id": "read",
  "POST /api/maintenance": "maintenance:write",
  "PUT /api/maintenance/:id": "maintenance:write",
  "POST /api/maintenance/:id/end": "maintenance:write",
  "DELETE /api/maintenance/:id": "maintenance:write",

  // Status pages, categories, channels (responses never carry credentials)
  "GET /api/status-pages": "read",
  "GET /api/status-pages/:id": "read",
  "POST /api/status-pages": "admin",
  "PUT /api/status-pages/:id": "admin",
  "PATCH /api/status-pages/:id": "admin",
  "DELETE /api/status-pages/:id": "admin",
  "GET /api/categories": "read",
  "GET /api/categories/:id": "read",
  "POST /api/categories": "admin",
  "PUT /api/categories/:id": "admin",
  "DELETE /api/categories/:id": "admin",
  "GET /api/channels": "read",
  "GET /api/channels/:id": "read",
  "POST /api/channels": "admin",
  "PUT /api/channels/:id": "admin",
  "DELETE /api/channels/:id": "admin",
  "POST /api/channels/:id/test": "admin",

  // Settings, data, keys, waitlist, click counts, push devices: admin only
  "GET /api/settings": "admin",
  "PUT /api/settings": "admin",
  "GET /api/data/export": "admin",
  "POST /api/data/import": "admin",
  "GET /api/admin/rekey/status": "admin",
  "POST /api/admin/rekey": "admin",
  "GET /api/waitlist": "admin",
  "GET /api/waitlist/export.csv": "admin",
  "GET /api/events": "admin",
  "GET /api/push/vapid-public-key": "admin",
  "POST /api/push/subscribe": "admin",
  "GET /api/push/fcm": "admin",
  "POST /api/push/fcm": "admin",
  "DELETE /api/push/fcm": "admin",
  "GET /api/push/devices": "admin",
  "DELETE /api/push/devices/:id": "admin",
  "POST /api/push/devices/:id/disable": "admin",
  "POST /api/push/devices/:id/enable": "admin",
  "POST /api/push/devices/:id/test": "admin",
  "POST /api/push/generate-vapid": "admin",

  // Sign-in and security
  "GET /api/auth/sessions": "admin",
  "DELETE /api/auth/sessions/:id": "admin",
  "GET /api/auth/support-activity": "admin",
  "GET /api/passkeys": "admin",
  "POST /api/passkeys/register/options": "admin",
  "POST /api/passkeys/register/verify": "admin",
  "DELETE /api/passkeys/:id": "admin",

  // API tokens: only the owner's browser session manages them; a token may
  // only describe itself.
  "GET /api/api-tokens": "session",
  "POST /api/api-tokens": "session",
  "DELETE /api/api-tokens/:id": "session",
  "GET /api/api-tokens/self": "token",
};

/**
 * /api routes with no requireAuth: sign-in flows, first-run setup, the public
 * status page and the public tools. Listed so the coverage test can tell an
 * intentionally public route from one missing a scope.
 */
export const PUBLIC_ROUTES: readonly string[] = [
  "GET /api/health",
  "GET /api/auth/me",
  "GET /api/auth/status",
  "POST /api/auth/logout",
  "POST /api/auth/logout-all",
  "GET /api/setup/state",
  "POST /api/setup/save",
  "POST /api/setup/complete",
  "POST /api/setup/passkeys/options",
  "POST /api/setup/passkeys/verify",
  "GET /api/waitlist/config",
  "POST /api/waitlist",
  "OPTIONS /api/waitlist",
  "POST /api/events",
];
/** Public route prefixes (each file there serves only unauthenticated routes). */
export const PUBLIC_PREFIXES: readonly string[] = [
  "/api/public/",
  "/api/tools/is-it-down",
  "/api/auth/magic/",
  "/api/auth/passkeys/",
];

interface CompiledRoute {
  method: string;
  parts: string[];
  literals: number;
  access: RouteAccess;
}

const COMPILED: CompiledRoute[] = Object.entries(ROUTE_SCOPES).map(([key, access]) => {
  const [method = "", path = ""] = key.split(" ");
  const parts = path.split("/").filter(Boolean);
  return { method, parts, literals: parts.filter((p) => !p.startsWith(":")).length, access };
});

/**
 * Who may call `method path` (a concrete request path), from ROUTE_SCOPES. A
 * literal segment beats a `:param` (so /monitors/uptime is not /monitors/:id).
 * Null when the route is not in the table: callers treat that as admin only.
 */
export function routeAccess(method: string, path: string): RouteAccess | null {
  const m = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  const segs = path.split("/").filter(Boolean);
  let best: CompiledRoute | null = null;
  for (const r of COMPILED) {
    if (r.method !== m || r.parts.length !== segs.length) continue;
    if (!r.parts.every((p, i) => p.startsWith(":") || p === segs[i])) continue;
    if (!best || r.literals > best.literals) best = r;
  }
  return best?.access ?? null;
}

/**
 * The scope an MCP tool needs (src/worker/mcp/tools.ts). A tool missing here
 * needs admin. A token without the scope never sees the tool in tools/list,
 * and a call to it is refused.
 */
export const TOOL_SCOPES: Record<string, Scope> = {
  get_status: "read",
  list_monitors: "read",
  get_monitor: "read",
  list_incidents: "read",
  get_uptime: "read",
  get_monthly_report: "read",
  get_diagnostics: "read",
  get_key_status: "admin",
  list_channels: "read",
  list_status_pages: "read",
  list_categories: "read",
  list_maintenance: "read",
  create_monitor: "monitors:write",
  update_monitor: "monitors:write",
  pause_monitor: "monitors:write",
  resume_monitor: "monitors:write",
  create_maintenance_window: "maintenance:write",
  end_maintenance_window: "maintenance:write",
  delete_maintenance_window: "maintenance:write",
  post_incident_update: "incidents:write",
  update_status_page: "admin",
  delete_monitor: "admin",
  rotate_heartbeat_token: "admin",
};

/** The scope `tool` needs: its TOOL_SCOPES row, else admin (default deny). */
export function toolScope(tool: string): Scope {
  return (Object.hasOwn(TOOL_SCOPES, tool) && TOOL_SCOPES[tool]) || "admin";
}

/** The body of a 403 for a token missing `needed`. */
export function insufficientScopeBody(needed: Scope | "session", scopes: readonly Scope[], detail?: string) {
  const message =
    needed === "session"
      ? "Only a signed-in browser session can do this; no API token can."
      : `This token does not have the ${needed} scope${detail ? ` (${detail})` : ""}. Its scopes: ${scopes.join(", ") || "none"}. Create a token with ${needed} under Developers > API tokens.`;
  return { error: needed === "session" ? "session_required" : "insufficient_scope", required: needed, scopes, message };
}
