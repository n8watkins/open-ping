/**
 * API token permissions, shared by the Worker (src/worker/lib/scopes.ts, which
 * maps every route and MCP tool to one) and the Developers page.
 *
 * A permission is a `resource:action` pair, like `monitors:edit`. Resources
 * are grouped into categories for the page; each lists only the actions it
 * supports. Any action other than read implies read of the same resource.
 * `admin` (Full access) is separate and implies everything.
 *
 * Tokens created before these pairs existed store the older, broader scopes
 * (read, monitors:write, ...). They keep working: LEGACY_SCOPES expands them
 * when a token is read, so they can do exactly what they could before.
 */

export const ACTIONS = ["read", "edit", "test", "delete"] as const;
export type Action = (typeof ACTIONS)[number];
export const ACTION_LABEL: Record<Action, string> = {
  read: "Read",
  edit: "Edit",
  test: "Test",
  delete: "Delete",
};

interface ResourceDef {
  id: string;
  label: string;
  /** What the resource is, in plain words. */
  description: string;
  /** The actions it supports, each with what it grants in plain words. */
  actions: Partial<Record<Action, string>>;
}
interface CategoryDef {
  id: string;
  label: string;
  resources: readonly ResourceDef[];
}

export const PERMISSION_CATEGORIES = [
  {
    id: "monitoring",
    label: "Monitoring",
    resources: [
      {
        id: "monitors",
        label: "Monitors",
        description: "The sites, APIs, ports and heartbeats OpenPing checks.",
        actions: {
          read: "See monitors, their settings and their current status",
          edit: "Add, change, pause and resume monitors",
          test: "Run a monitor's check on demand",
          delete: "Delete monitors and their history",
        },
      },
      {
        id: "uptime",
        label: "Uptime and checks",
        description: "The overview, uptime percentages and the result of every check.",
        actions: { read: "See the overview, uptime and check history" },
      },
      {
        id: "heartbeats",
        label: "Heartbeat URLs",
        description: "The secret URL a cron job or script pings to say it ran.",
        actions: {
          edit: "Replace a heartbeat's secret URL, so the old one stops working",
        },
      },
      {
        id: "categories",
        label: "Categories",
        description: "The groups monitors are sorted into.",
        actions: {
          read: "See categories",
          edit: "Create, rename, reorder and delete categories",
        },
      },
    ],
  },
  {
    id: "incidents",
    label: "Incidents and maintenance",
    resources: [
      {
        id: "incidents",
        label: "Incidents",
        description: "Outages OpenPing detected, with their timelines and notes.",
        actions: {
          read: "See incidents and their timelines, and export them as CSV or JSON",
          edit: "Post, edit and remove incident updates and notes",
        },
      },
      {
        id: "maintenance",
        label: "Maintenance windows",
        description: "Planned downtime that pauses alerts.",
        actions: {
          read: "See maintenance windows",
          edit: "Schedule, change and end windows, and cancel ones that have not started",
          delete: "Delete windows that have already started, removing them from history",
        },
      },
    ],
  },
  {
    id: "status-pages",
    label: "Status pages",
    resources: [
      {
        id: "status_pages",
        label: "Status pages",
        description: "Public pages that show your monitors, and the embeds built on them.",
        actions: {
          read: "See status pages and their settings",
          edit: "Create, change and delete status pages",
        },
      },
    ],
  },
  {
    id: "notifications",
    label: "Notifications",
    resources: [
      {
        id: "channels",
        label: "Alert channels",
        description: "Email, Slack, Discord, webhooks and the other places alerts go.",
        actions: {
          read: "See alert channels (never their secrets)",
          edit: "Add, change and delete alert channels",
          test: "Send a test alert through a channel",
        },
      },
      {
        id: "push",
        label: "Phone push",
        description: "Phones that get push alerts, and the keys that sign them.",
        actions: {
          read: "See registered phones and how push is set up",
          edit: "Register, turn on or off and remove phones, and set up push keys",
          test: "Send a test push to a phone",
        },
      },
    ],
  },
  {
    id: "data",
    label: "Reports and data",
    resources: [
      {
        id: "reports",
        label: "Reports",
        description: "Monthly uptime and incident reports.",
        actions: { read: "See monthly reports" },
      },
      {
        id: "diagnostics",
        label: "Diagnostics",
        description: "How checks and the scheduler are running, and plan usage.",
        actions: { read: "See diagnostics and usage" },
      },
      {
        id: "backups",
        label: "Backups",
        description: "A full export of your data, and importing one.",
        actions: {
          read: "Download a full export of your data",
          edit: "Import a backup over your current data",
        },
      },
      {
        id: "site",
        label: "Landing page",
        description: "Click counts and the Hosted waitlist (only on the OpenPing project's own site).",
        actions: {
          read: "See landing page click counts and export the waitlist",
        },
      },
    ],
  },
  {
    id: "account",
    label: "Account",
    resources: [
      {
        id: "settings",
        label: "Settings",
        description: "Install-wide settings: name, timezone, defaults and integrations.",
        actions: { read: "See settings", edit: "Change settings" },
      },
      {
        id: "encryption",
        label: "Encryption key",
        description: "The key that protects the credentials OpenPing stores.",
        actions: {
          read: "See whether stored credentials use the current key",
          edit: "Re-encrypt stored credentials with a new key",
        },
      },
      {
        id: "security",
        label: "Sign-in and security",
        description: "Signed-in sessions, passkeys and support access.",
        actions: {
          read: "See signed-in sessions, passkeys and support access",
          edit: "Sign out sessions and add or remove passkeys",
        },
      },
    ],
  },
] as const satisfies readonly CategoryDef[];

type AnyResource = (typeof PERMISSION_CATEGORIES)[number]["resources"][number];
export type ResourceId = AnyResource["id"];
/** Every `resource:action` pair the table defines. */
export type Permission = AnyResource extends infer R
  ? R extends { id: infer I extends string; actions: infer A }
    ? `${I}:${keyof A & string}`
    : never
  : never;
export type Scope = Permission | "admin";

export interface Resource {
  id: ResourceId;
  label: string;
  description: string;
  categoryId: string;
  /** The actions it supports, in ACTIONS order. */
  actions: readonly Action[];
  /** What each supported action grants. */
  grants: Partial<Record<Action, string>>;
}

export const RESOURCES: readonly Resource[] = PERMISSION_CATEGORIES.flatMap((c) =>
  c.resources.map((r): Resource => ({
    id: r.id,
    label: r.label,
    description: r.description,
    categoryId: c.id,
    actions: ACTIONS.filter((a) => a in r.actions),
    grants: r.actions,
  })),
);

/** Every permission, in table order (category, resource, then ACTIONS order). */
export const PERMISSIONS: readonly Permission[] = RESOURCES.flatMap((r) => r.actions.map((a) => `${r.id}:${a}` as Permission));
/** Everything a token may be given: the permissions, then admin. */
export const SCOPES: readonly Scope[] = [...PERMISSIONS, "admin"];

export function isScope(value: string): value is Scope {
  return (SCOPES as readonly string[]).includes(value);
}

export function permission(resource: ResourceId, action: Action): Permission | null {
  const p = `${resource}:${action}`;
  return (PERMISSIONS as readonly string[]).includes(p) ? (p as Permission) : null;
}

/**
 * Implications beyond "any action implies read": deleting a maintenance window
 * that has started goes through the same route as cancelling an upcoming one,
 * which needs edit.
 */
const EXTRA_IMPLIES: Partial<Record<Permission, readonly Permission[]>> = {
  "maintenance:delete": ["maintenance:edit"],
};

/** What `p` implies on its own resource: its read (when there is one) and any EXTRA_IMPLIES, transitively. */
export function implies(p: Permission): Permission[] {
  const out = new Set<Permission>();
  const visit = (q: Permission) => {
    const [resource, action] = q.split(":") as [ResourceId, Action];
    const read = action === "read" ? null : permission(resource, "read");
    for (const r of [...(read ? [read] : []), ...(EXTRA_IMPLIES[q] ?? [])]) {
      if (!out.has(r)) {
        out.add(r);
        visit(r);
      }
    }
  };
  visit(p);
  return [...out];
}

/**
 * The scopes tokens stored before resource:action pairs existed (#121), and
 * the pairs each stands for: exactly what it allowed then, plus read of the
 * same resource for a write scope. None of these words is a new permission id
 * (admin aside, which means the same in both), so an older OpenPing after a
 * rollback reads a new token's pairs as unknown and refuses it.
 */
export const LEGACY_SCOPES: Record<"read" | "monitors:write" | "incidents:write" | "maintenance:write", readonly Permission[]> = {
  read: [
    "monitors:read",
    "uptime:read",
    "categories:read",
    "incidents:read",
    "maintenance:read",
    "status_pages:read",
    "channels:read",
    "reports:read",
    "diagnostics:read",
  ],
  "monitors:write": ["monitors:read", "monitors:edit", "monitors:test"],
  "incidents:write": ["incidents:read", "incidents:edit"],
  "maintenance:write": ["maintenance:read", "maintenance:edit"],
};

/**
 * Parse stored or requested scopes ('monitors:edit incidents:read', or older
 * words like 'read monitors:write') into the canonical list: legacy words
 * expanded, implied reads added, unknown words dropped, in SCOPES order, and
 * just ['admin'] when admin is in it.
 */
export function normalizeScopes(input: string | readonly string[] | null | undefined): Scope[] {
  const words = typeof input === "string" || input == null ? (input ?? "").split(/[\s,]+/) : input;
  const out = new Set<Scope>();
  for (const word of words) {
    if (word === "admin") return ["admin"];
    if (Object.hasOwn(LEGACY_SCOPES, word)) for (const p of LEGACY_SCOPES[word as keyof typeof LEGACY_SCOPES]) out.add(p);
    else if (isScope(word)) out.add(word);
  }
  for (const p of [...out]) if (p !== "admin") for (const q of implies(p)) out.add(q);
  return SCOPES.filter((s) => out.has(s));
}

/** One resource's granted actions, for summaries ("Monitors: edit, test"). */
export interface GrantedResource {
  resource: Resource;
  actions: Action[];
}

/** The resources `scopes` grants anything on, in table order. Empty for admin (callers say "Full access"). */
export function grantedResources(scopes: readonly Scope[]): GrantedResource[] {
  const set = new Set<string>(scopes);
  return RESOURCES.map((resource) => ({
    resource,
    actions: resource.actions.filter((a) => set.has(`${resource.id}:${a}`)),
  })).filter((g) => g.actions.length > 0);
}

/** "edit, test" for a resource: the strongest actions, leaving out the read that edit implies. */
export function shortActions(actions: readonly Action[]): string {
  const beyondRead = actions.filter((a) => a !== "read");
  return (beyondRead.length ? beyondRead : actions).map((a) => ACTION_LABEL[a].toLowerCase()).join(", ");
}

export interface PermissionTemplate {
  id: string;
  label: string;
  /** What it is for, one line. */
  hint: string;
  scopes: readonly Permission[];
}

/** Starting points under Bulk select. They only tick boxes, which the owner then sees and can change. */
export const PERMISSION_TEMPLATES: readonly PermissionTemplate[] = [
  {
    id: "read-only",
    label: "Read-only",
    hint: "See monitors, incidents, uptime and reports",
    scopes: LEGACY_SCOPES.read,
  },
  {
    id: "monitoring-sync",
    label: "Monitoring sync",
    hint: "Keep monitors in step with your code",
    scopes: [...LEGACY_SCOPES.read, ...LEGACY_SCOPES["monitors:write"]],
  },
  {
    id: "maintenance",
    label: "Maintenance",
    hint: "Let a deploy script pause alerts",
    scopes: [...LEGACY_SCOPES.read, ...LEGACY_SCOPES["maintenance:write"]],
  },
];

/** Expiry choices in days (null: never). */
export const EXPIRY_DAYS = [7, 30, 90, null] as const;
