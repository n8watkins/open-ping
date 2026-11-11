/**
 * What an API token may do: its scopes (resource:action permissions, or
 * admin; src/shared/scopes.ts), and the one table that says which permission
 * each authenticated REST route and MCP tool needs. Every route maps to
 * exactly one.
 *
 * DEFAULT DENY. A route or tool missing from these tables needs `admin`, so a
 * new feature is never open to a narrower token by accident. A browser session
 * is the owner and is never limited by scopes. scopes.test.ts fails when a
 * route is registered without a row here, so every new route is a decision.
 */

import { isScope, LEGACY_SCOPES, normalizeScopes, SCOPES, type Permission, type Scope } from "../../shared/scopes";

export { isScope, normalizeScopes, SCOPES, type Permission, type Scope };

/** The older scope words (#121) a create request may still send. */
export const LEGACY_SCOPES_IDS: readonly string[] = Object.keys(LEGACY_SCOPES);

/** Parse a stored scopes column into the canonical list (see normalizeScopes). */
export function parseScopes(stored: string | null | undefined): Scope[] {
  return normalizeScopes(stored);
}

/** Whether a token with `scopes` (canonical, from parseScopes) has `needed`. `admin` implies everything. */
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
  // Overview and uptime
  "GET /api/overview": "uptime:read",
  "GET /api/overview/history": "uptime:read",
  "GET /api/monitors/uptime": "uptime:read",
  "GET /api/monitors/:id/history": "uptime:read",

  // Monitors
  "GET /api/monitors": "monitors:read",
  "GET /api/monitors/:id": "monitors:read",
  "GET /api/monitors/:id/detail": "monitors:read",
  "GET /api/monitors/:id/icon": "monitors:read",
  "POST /api/monitors": "monitors:edit",
  "PUT /api/monitors/:id": "monitors:edit",
  "PATCH /api/monitors/:id": "monitors:edit",
  "POST /api/monitors/:id/pause": "monitors:edit",
  "POST /api/monitors/:id/resume": "monitors:edit",
  "POST /api/monitors/:id/test": "monitors:test",
  "DELETE /api/monitors/:id": "monitors:delete",
  "POST /api/monitors/:id/rotate-heartbeat-token": "heartbeats:edit",

  // Categories
  "GET /api/categories": "categories:read",
  "GET /api/categories/:id": "categories:read",
  "POST /api/categories": "categories:edit",
  "PUT /api/categories/:id": "categories:edit",
  "DELETE /api/categories/:id": "categories:edit",

  // Incidents
  "GET /api/incidents": "incidents:read",
  "GET /api/incidents/export.json": "incidents:read",
  "GET /api/incidents/export.csv": "incidents:read",
  "GET /api/incidents/:id": "incidents:read",
  "PATCH /api/incidents/:id": "incidents:edit",
  "POST /api/incidents/:id/updates": "incidents:edit",
  "PATCH /api/incidents/:id/updates/:updateId": "incidents:edit",
  "DELETE /api/incidents/:id/updates/:updateId": "incidents:edit",

  // Maintenance: deleting a window that has started also needs
  // maintenance:delete (checked in routes/maintenance.ts)
  "GET /api/maintenance": "maintenance:read",
  "GET /api/maintenance/:id": "maintenance:read",
  "POST /api/maintenance": "maintenance:edit",
  "PUT /api/maintenance/:id": "maintenance:edit",
  "POST /api/maintenance/:id/end": "maintenance:edit",
  "DELETE /api/maintenance/:id": "maintenance:edit",

  // Status pages (embeds read these too)
  "GET /api/status-pages": "status_pages:read",
  "GET /api/status-pages/:id": "status_pages:read",
  "POST /api/status-pages": "status_pages:edit",
  "PUT /api/status-pages/:id": "status_pages:edit",
  "PATCH /api/status-pages/:id": "status_pages:edit",
  "DELETE /api/status-pages/:id": "status_pages:edit",

  // Alert channels (responses never carry credentials)
  "GET /api/channels": "channels:read",
  "GET /api/channels/:id": "channels:read",
  "POST /api/channels": "channels:edit",
  "PUT /api/channels/:id": "channels:edit",
  "DELETE /api/channels/:id": "channels:edit",
  "POST /api/channels/:id/test": "channels:test",

  // Phone push
  "GET /api/push/vapid-public-key": "push:read",
  "GET /api/push/fcm": "push:read",
  "GET /api/push/devices": "push:read",
  "POST /api/push/subscribe": "push:edit",
  "POST /api/push/fcm": "push:edit",
  "DELETE /api/push/fcm": "push:edit",
  "DELETE /api/push/devices/:id": "push:edit",
  "POST /api/push/devices/:id/disable": "push:edit",
  "POST /api/push/devices/:id/enable": "push:edit",
  "POST /api/push/generate-vapid": "push:edit",
  "POST /api/push/devices/:id/test": "push:test",

  // Reports, diagnostics, backups, the landing page
  "GET /api/reports/monthly": "reports:read",
  "GET /api/diagnostics": "diagnostics:read",
  "GET /api/diagnostics/usage": "diagnostics:read",
  "GET /api/data/export": "backups:read",
  "POST /api/data/import": "backups:edit",
  "GET /api/events": "site:read",
  "GET /api/waitlist": "site:read",
  "GET /api/waitlist/export.csv": "site:read",

  // Settings, encryption key, sign-in and security
  "GET /api/settings": "settings:read",
  "PUT /api/settings": "settings:edit",
  "GET /api/admin/rekey/status": "encryption:read",
  "POST /api/admin/rekey": "encryption:edit",
  "GET /api/auth/sessions": "security:read",
  "GET /api/auth/support-activity": "security:read",
  "GET /api/passkeys": "security:read",
  "DELETE /api/auth/sessions/:id": "security:edit",
  "POST /api/passkeys/register/options": "security:edit",
  "POST /api/passkeys/register/verify": "security:edit",
  "DELETE /api/passkeys/:id": "security:edit",

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
  return {
    method,
    parts,
    literals: parts.filter((p) => !p.startsWith(":")).length,
    access,
  };
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
  get_status: "uptime:read",
  get_uptime: "uptime:read",
  list_monitors: "monitors:read",
  get_monitor: "monitors:read",
  list_incidents: "incidents:read",
  get_monthly_report: "reports:read",
  get_diagnostics: "diagnostics:read",
  get_key_status: "encryption:read",
  list_channels: "channels:read",
  list_status_pages: "status_pages:read",
  list_categories: "categories:read",
  list_maintenance: "maintenance:read",
  create_monitor: "monitors:edit",
  update_monitor: "monitors:edit",
  pause_monitor: "monitors:edit",
  resume_monitor: "monitors:edit",
  delete_monitor: "monitors:delete",
  rotate_heartbeat_token: "heartbeats:edit",
  create_maintenance_window: "maintenance:edit",
  end_maintenance_window: "maintenance:edit",
  delete_maintenance_window: "maintenance:edit",
  post_incident_update: "incidents:edit",
  update_status_page: "status_pages:edit",
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
      : `This token does not have the ${needed} permission${detail ? ` (${detail})` : ""}. Its permissions: ${scopes.join(", ") || "none"}. Create a token with ${needed} under Developers > API tokens.`;
  return {
    error: needed === "session" ? "session_required" : "insufficient_scope",
    required: needed,
    scopes,
    message,
  };
}
