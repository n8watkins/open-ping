import { Hono } from "hono";
import type { AppEnv, Env } from "../types";
import { listMonitors } from "../db/monitors";
import { getSetting } from "../db/settings";
import { publicMaintenance, type MaintenanceWindow } from "../db/maintenance";
import type { MonitorState } from "../../shared/states";

/**
 * Public status-page API mounted at /api/public (PRD §15). This router is
 * UNAUTHENTICATED, so every value it emits is deliberately and strictly
 * redacted (acceptance criterion #27): it NEVER reads or returns a monitor's
 * config (URLs, request bodies, auth/credentials, headers), its heartbeat
 * token, or any internal diagnostic error (monitor_state.last_error, the
 * incidents.error column, private notes). Incident/maintenance copy comes only
 * from the admin-authored `public_message`; service identity comes only from the
 * public display name, falling back to the monitor name. Anything the operator
 * has not explicitly marked public (public.visible / incidents.public) is
 * omitted or anonymized to "A service".
 */
export const publicStatus = new Hono<AppEnv>();

const DAY_MS = 24 * 60 * 60 * 1000;
const BAR_DAYS = 90;
const RECENT_INCIDENT_LIMIT = 10;
const UPCOMING_MAINT_LIMIT = 10;
// Short, shared cache window: this endpoint is unauthenticated and does
// unbounded per-monitor work, so let the CDN absorb bursts (the page tolerates a
// few seconds of staleness). The "decrypt only visible monitors" optimization
// lives in db/monitors.ts and is a separate follow-up.
const STATUS_CACHE_SECONDS = 20;

// ---------------------------------------------------------------------------
// Public-facing value types (the wire shape consumed by the status page SPA).
// ---------------------------------------------------------------------------

/** Safe, public-only projection of a monitor's lifecycle state. */
export type PublicServiceState =
  | "operational"
  | "degraded"
  | "down"
  | "maintenance"
  | "scheduled_off"
  | "unknown";

/** Aggregate banner status for the whole page. */
export type OverallStatus =
  | "operational"
  | "degraded"
  | "partial_outage"
  | "major_outage"
  | "maintenance"
  | "all_off";

/** One day in the 90-day uptime bar strip. */
interface PublicBar {
  date: string; // YYYY-MM-DD (UTC)
  uptimePct: number | null;
  state: "up" | "degraded" | "down" | "none";
}

interface PublicService {
  id: string;
  name: string;
  description: string | null;
  state: PublicServiceState;
  showUptime: boolean;
  uptime90d: number | null;
  latestMs: number | null;
  bars: PublicBar[];
}

interface PublicIncident {
  id: string;
  title: string;
  message: string;
  startedAt: number;
  resolvedAt: number | null;
  durationSeconds: number | null;
  monitorName: string;
}

interface PublicMaint {
  // NB: the window's internal `title` is deliberately NOT exposed — operators
  // treat it as an internal label (it has no "shown publicly" hint in the admin
  // UI), and the sibling incident projection anonymizes its title for the same
  // reason. Only the admin-authored public message is surfaced.
  message: string;
  startsAt: number;
  endsAt: number;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested) — no DB, no request context.
// ---------------------------------------------------------------------------

/**
 * Derive the overall page banner from the public service states plus whether a
 * maintenance window is currently active.
 *
 * Precedence (PRD §15): an *outage* (any service `down`) always wins, then an
 * active maintenance window, then a `degraded` service, otherwise operational.
 * "No outages" for the maintenance clause means no `down` services — a degraded
 * service does not block the maintenance banner. `scheduled_off`, `maintenance`
 * and `unknown` service states never count toward an outage.
 */
export function computeOverall(
  services: { state: PublicServiceState }[],
  hasActiveMaintenance: boolean,
): OverallStatus {
  if (services.length === 0) return "all_off";

  let down = 0;
  let degraded = 0;
  for (const s of services) {
    if (s.state === "down") down += 1;
    else if (s.state === "degraded") degraded += 1;
  }

  if (down > 0) return down === services.length ? "major_outage" : "partial_outage";
  if (hasActiveMaintenance) return "maintenance";
  if (degraded > 0) return "degraded";
  return "operational";
}

/** Map a raw monitor lifecycle state to its safe public projection. */
function mapPublicState(
  state: MonitorState,
  showScheduledOff: boolean,
): PublicServiceState {
  switch (state) {
    case "up":
      return "operational";
    case "degraded":
      return "degraded";
    case "down":
      return "down";
    case "maintenance":
      return "maintenance";
    case "scheduled_off":
      // Hidden from the page (and from the outage calc) unless the operator
      // opts in; treat as operational when hidden.
      return showScheduledOff ? "scheduled_off" : "operational";
    default:
      // unknown / warming_up / paused — nothing meaningful to show publicly.
      return "unknown";
  }
}

/** Format an epoch-ms instant as a UTC YYYY-MM-DD string. */
function utcDateString(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Round a percentage to 3 decimal places. */
function roundPct(pct: number): number {
  return Math.round(pct * 1000) / 1000;
}

/** Minimal shape of a daily `summaries` row needed for the public page. */
interface DaySummaryRow {
  bucket_start: number;
  checks: number;
  ok_checks: number;
}

/**
 * Pure reducer: turn daily summary rows into the 90-day uptime % and the bar
 * strip (one entry per UTC day, oldest first). Days with no data are emitted as
 * `{ uptimePct: null, state: "none" }`; the headline figure is 100 when there
 * is no data at all (nothing was observed, so nothing was down).
 */
export function computeUptimeAndBars(
  rows: DaySummaryRow[],
  now: number,
): { uptime90d: number; bars: PublicBar[] } {
  const byDate = new Map<string, { checks: number; ok: number }>();
  let totalChecks = 0;
  let totalOk = 0;

  for (const r of rows) {
    const key = utcDateString(r.bucket_start);
    const agg = byDate.get(key) ?? { checks: 0, ok: 0 };
    agg.checks += r.checks;
    agg.ok += r.ok_checks;
    byDate.set(key, agg);
    totalChecks += r.checks;
    totalOk += r.ok_checks;
  }

  const bars: PublicBar[] = [];
  for (let i = BAR_DAYS - 1; i >= 0; i--) {
    const date = utcDateString(now - i * DAY_MS);
    const agg = byDate.get(date);
    if (!agg || agg.checks <= 0) {
      bars.push({ date, uptimePct: null, state: "none" });
      continue;
    }
    const pct = (agg.ok / agg.checks) * 100;
    const state: PublicBar["state"] =
      agg.ok <= 0 ? "down" : agg.ok >= agg.checks ? "up" : "degraded";
    bars.push({ date, uptimePct: roundPct(pct), state });
  }

  const uptime90d = totalChecks > 0 ? roundPct((totalOk / totalChecks) * 100) : 100;
  return { uptime90d, bars };
}

// ---------------------------------------------------------------------------
// DB readers (each selects ONLY public-safe columns).
// ---------------------------------------------------------------------------

interface PublicStateRow {
  monitor_id: string;
  state: MonitorState;
  last_duration_ms: number | null;
  last_checked_at: number | null;
}

/** Load daily summary counters for one monitor over the trailing 90 days. */
async function loadDaySummaries(
  env: Env,
  monitorId: string,
  sinceMs: number,
  now: number,
): Promise<DaySummaryRow[]> {
  const res = await env.DB.prepare(
    `SELECT bucket_start, checks, ok_checks
       FROM summaries
      WHERE monitor_id = ?
        AND period = 'day'
        AND bucket_start >= ?
        AND bucket_start <= ?`,
  )
    .bind(monitorId, sinceMs, now)
    .all<DaySummaryRow>();
  return res.results ?? [];
}

/** Project a maintenance window to its public shape (admin message only). */
function toPublicMaint(w: MaintenanceWindow): PublicMaint {
  return {
    message: w.publicMessage ?? "",
    startsAt: w.startsAt,
    endsAt: w.endsAt,
  };
}

/**
 * Load active + upcoming maintenance windows that carry a public message. Uses
 * the recurrence-aware `publicMaintenance` helper (via `isWindowActiveAt`) so a
 * weekly window is only "active" during its actual recurring slot, not for the
 * whole multi-month envelope. Only `public_message` (never `private_notes`) is
 * exposed; empty messages are dropped.
 */
async function loadMaintenance(
  env: Env,
  now: number,
): Promise<{ active: PublicMaint[]; upcoming: PublicMaint[] }> {
  const { active, upcoming } = await publicMaintenance(env, now);
  const hasMessage = (w: MaintenanceWindow) =>
    w.publicMessage != null && w.publicMessage !== "";
  return {
    active: active.filter(hasMessage).map(toPublicMaint),
    upcoming: upcoming.filter(hasMessage).map(toPublicMaint).slice(0, UPCOMING_MAINT_LIMIT),
  };
}

/** Public-safe columns of an `incidents` row (no error/notes/title/url). */
interface PublicIncidentRow {
  id: string;
  monitor_id: string;
  started_at: number;
  resolved_at: number | null;
  duration_seconds: number | null;
  public_message: string | null;
}

/**
 * Project an incident row to its public shape. The service is named only if its
 * monitor is itself public; otherwise it is anonymized to "A service" so the
 * incident can still appear without leaking which internal service it belongs
 * to. The title is rebuilt from the public name (the stored title embeds the
 * internal monitor name) and the body is the admin-authored public message.
 */
function toPublicIncident(
  row: PublicIncidentRow,
  publicNames: Map<string, string>,
): PublicIncident {
  const named = publicNames.get(row.monitor_id);
  const monitorName = named ?? "A service";
  return {
    id: row.id,
    title: `${monitorName} incident`,
    message: row.public_message ?? "",
    startedAt: row.started_at,
    resolvedAt: row.resolved_at,
    durationSeconds: row.duration_seconds,
    monitorName,
  };
}

// ---------------------------------------------------------------------------
// GET /status — the entire public status page payload.
// ---------------------------------------------------------------------------

publicStatus.get("/status", async (c) => {
  const env = c.env;
  const now = Date.now();

  // Let the CDN serve repeat hits; applies to both the disabled early-return
  // below and the full payload.
  c.header("Cache-Control", `public, max-age=${STATUS_CACHE_SECONDS}`);

  // --- Page branding/config (settings keys status_page_*) ---
  const [
    name,
    description,
    logo,
    accent,
    theme,
    homepage,
    footer,
    attributionRaw,
    enabledRaw,
  ] = await Promise.all([
    getSetting(env, "status_page_name"),
    getSetting(env, "status_page_description"),
    getSetting(env, "status_page_logo"),
    getSetting(env, "status_page_accent"),
    getSetting(env, "status_page_theme"),
    getSetting(env, "status_page_homepage"),
    getSetting(env, "status_page_footer"),
    getSetting(env, "status_page_attribution"),
    getSetting(env, "status_page_enabled"),
  ]);

  const page = {
    name: name ?? "OpenPing",
    description: description ?? null,
    logo: logo ?? null,
    accent: accent ?? "#6d8bff",
    theme: theme ?? "dark",
    homepage: homepage ?? null,
    footer: footer ?? null,
    attribution: attributionRaw == null ? true : attributionRaw === "true",
  };
  const enabled = enabledRaw === "true";

  // Enforce the operator's kill switch server-side: when the status page is not
  // explicitly enabled, expose nothing but the page name. None of the work
  // below (services, uptime, incidents, maintenance) runs or is returned.
  if (!enabled) {
    return c.json({ enabled: false, page: { name: page.name } });
  }

  // --- Visible monitors only ---
  const visible = (await listMonitors(env)).filter(
    (m) => m.public?.visible === true,
  );

  // Current state per monitor (no last_error / no last_status_code).
  const stateRes = await env.DB.prepare(
    `SELECT monitor_id, state, last_duration_ms, last_checked_at FROM monitor_state`,
  ).all<PublicStateRow>();
  const stateMap = new Map<string, PublicStateRow>(
    (stateRes.results ?? []).map((s) => [s.monitor_id, s]),
  );

  // Public display name per visible monitor (for incident attribution).
  const publicNames = new Map<string, string>();
  for (const m of visible) {
    publicNames.set(m.id, m.public.name || m.name);
  }

  // --- Build services (with grouping metadata carried alongside) ---
  let updatedAt = 0;
  const built = await Promise.all(
    visible.map(async (m) => {
      const st = stateMap.get(m.id);
      if (st?.last_checked_at != null && st.last_checked_at > updatedAt) {
        updatedAt = st.last_checked_at;
      }
      const pub = m.public;
      const state = mapPublicState(st?.state ?? "unknown", pub.showScheduledOff);

      let uptime90d: number | null = null;
      let bars: PublicBar[] = [];
      if (pub.showUptime) {
        const rows = await loadDaySummaries(
          env,
          m.id,
          now - BAR_DAYS * DAY_MS,
          now,
        );
        const computed = computeUptimeAndBars(rows, now);
        uptime90d = computed.uptime90d;
        bars = computed.bars;
      }

      const service: PublicService = {
        id: m.id,
        name: m.public.name || m.name,
        description: pub.description ?? null,
        state,
        showUptime: pub.showUptime,
        uptime90d,
        latestMs: pub.showResponseTime ? (st?.last_duration_ms ?? null) : null,
        bars,
      };

      const group = pub.group && pub.group.length > 0 ? pub.group : null;
      return { service, group, sortOrder: pub.sortOrder ?? 0 };
    }),
  );
  if (updatedAt === 0) updatedAt = now;

  // --- Group + sort (services by sortOrder then name; null group last) ---
  const groupMap = new Map<
    string | null,
    { service: PublicService; sortOrder: number }[]
  >();
  for (const item of built) {
    const arr = groupMap.get(item.group) ?? [];
    arr.push({ service: item.service, sortOrder: item.sortOrder });
    groupMap.set(item.group, arr);
  }
  const groups = [...groupMap.entries()]
    .map(([groupName, arr]) => {
      arr.sort(
        (a, b) =>
          a.sortOrder - b.sortOrder ||
          a.service.name.localeCompare(b.service.name),
      );
      return {
        name: groupName,
        services: arr.map((x) => x.service),
        minSortOrder: Math.min(...arr.map((x) => x.sortOrder)),
      };
    })
    .sort((a, b) => {
      if (a.name === null) return 1;
      if (b.name === null) return -1;
      return a.minSortOrder - b.minSortOrder || a.name.localeCompare(b.name);
    })
    .map((g) => ({ name: g.name, services: g.services }));

  // --- Maintenance + overall banner ---
  const maintenance = await loadMaintenance(env, now);
  const overall = computeOverall(
    built.map((b) => b.service),
    maintenance.active.length > 0,
  );

  // --- Public incidents (public=1 only; safe columns only) ---
  const [activeRes, recentRes] = await Promise.all([
    env.DB.prepare(
      `SELECT id, monitor_id, started_at, resolved_at, duration_seconds, public_message
         FROM incidents
        WHERE public = 1 AND status = 'open'
        ORDER BY started_at DESC`,
    ).all<PublicIncidentRow>(),
    env.DB.prepare(
      `SELECT id, monitor_id, started_at, resolved_at, duration_seconds, public_message
         FROM incidents
        WHERE public = 1 AND status = 'resolved'
        ORDER BY resolved_at DESC
        LIMIT ?`,
    )
      .bind(RECENT_INCIDENT_LIMIT)
      .all<PublicIncidentRow>(),
  ]);

  const activeIncidents = (activeRes.results ?? []).map((r) =>
    toPublicIncident(r, publicNames),
  );
  const recentIncidents = (recentRes.results ?? []).map((r) =>
    toPublicIncident(r, publicNames),
  );

  return c.json({
    page,
    enabled,
    overall,
    updatedAt,
    groups,
    activeIncidents,
    recentIncidents,
    maintenance,
  });
});
