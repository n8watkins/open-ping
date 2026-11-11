/**
 * API token scopes, shared by the Worker (src/worker/lib/scopes.ts, which maps
 * routes and MCP tools to them) and the Developers page.
 */

export const SCOPES = ["read", "monitors:write", "incidents:write", "maintenance:write", "admin"] as const;
export type Scope = (typeof SCOPES)[number];

/** What each scope allows, in plain words. The ids stay technical (API docs, CLI); the labels are what the app shows. */
export const SCOPE_INFO: Record<Scope, { label: string; description: string }> = {
  read: {
    label: "See everything",
    description: "See monitors, incidents, uptime, reports, maintenance, status pages and alert channels. Not settings, exports or tokens.",
  },
  "monitors:write": { label: "Manage monitors", description: "Add, change, pause and resume monitors. Not remove them." },
  "incidents:write": { label: "Manage incidents", description: "Post, edit and remove incident updates and notes." },
  "maintenance:write": {
    label: "Manage maintenance",
    description: "Start, change and end maintenance windows, and cancel ones that have not started.",
  },
  admin: {
    label: "Full control",
    description: "Everything, including settings, exports and other tokens.",
  },
};

export interface ScopePreset {
  id: string;
  label: string;
  /** One line shown on the collapsed card. */
  summary: string;
  scopes: readonly Scope[];
  can: readonly string[];
  cant: readonly string[];
}

/** The ready-made choices the Developers page offers, in order. "Custom" is added by the page. */
export const SCOPE_PRESETS: readonly ScopePreset[] = [
  {
    id: "read-only",
    label: "Read-only",
    summary: "Look, but never change anything",
    scopes: ["read"],
    can: ["See monitors, incidents, uptime and reports", "See maintenance windows, status pages and alert channels"],
    cant: ["Change anything", "See settings or exports", "Create or manage tokens"],
  },
  {
    id: "monitoring-sync",
    label: "Monitoring sync",
    summary: "Keeps your monitors in step with your code",
    scopes: ["read", "monitors:write"],
    can: ["See monitors, incidents, uptime and reports", "Add, change, pause and resume monitors"],
    cant: ["Remove monitors", "Change settings or exports", "Manage other tokens"],
  },
  {
    id: "maintenance",
    label: "Maintenance",
    summary: "Lets a deploy script pause alerts",
    scopes: ["read", "maintenance:write"],
    can: ["See monitors, incidents, uptime and reports", "Start, change and end maintenance windows"],
    cant: ["Change monitors", "Change settings or exports", "Manage other tokens"],
  },
  {
    id: "admin",
    label: "Full admin",
    summary: "Everything. Only for your own CLI",
    scopes: ["admin"],
    can: ["Everything, including settings, exports and other tokens"],
    cant: [],
  },
];

/** Expiry choices in days (null: never). */
export const EXPIRY_DAYS = [7, 30, 90, null] as const;
