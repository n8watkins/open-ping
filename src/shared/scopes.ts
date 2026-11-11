/**
 * API token scopes, shared by the Worker (src/worker/lib/scopes.ts, which maps
 * routes and MCP tools to them) and the Developers page.
 */

export const SCOPES = ["read", "monitors:write", "incidents:write", "maintenance:write", "admin"] as const;
export type Scope = (typeof SCOPES)[number];

/** What each scope allows, in plain words. */
export const SCOPE_INFO: Record<Scope, { label: string; description: string }> = {
  read: {
    label: "Read",
    description:
      "See monitors, incidents, uptime, reports, diagnostics, maintenance, status pages, categories and channels (credentials hidden). Not settings, exports or tokens.",
  },
  "monitors:write": { label: "Monitors: write", description: "Create, edit, pause and resume monitors. Not delete." },
  "incidents:write": { label: "Incidents: write", description: "Post, edit and remove incident updates and notes." },
  "maintenance:write": {
    label: "Maintenance: write",
    description: "Open, change and end maintenance windows, and cancel ones that have not started.",
  },
  admin: {
    label: "Admin",
    description: "Everything else too: deleting monitors, alert channels, settings and data export.",
  },
};

/** The presets the Developers page offers. */
export const SCOPE_PRESETS: readonly { id: string; label: string; scopes: readonly Scope[]; hint: string }[] = [
  { id: "read-only", label: "Read-only", scopes: ["read"], hint: "Dashboards, reports, checking status" },
  { id: "monitoring-sync", label: "Monitoring sync", scopes: ["read", "monitors:write"], hint: "An agent that keeps monitors in sync" },
  { id: "maintenance", label: "Maintenance", scopes: ["read", "maintenance:write"], hint: "Deploy scripts that pause alerts" },
  { id: "admin", label: "Full admin", scopes: ["admin"], hint: "Everything; only for your own CLI" },
];

/** Expiry choices in days (null: never). */
export const EXPIRY_DAYS = [7, 30, 90, null] as const;
