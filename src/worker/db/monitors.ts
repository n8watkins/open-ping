import type { Env } from "../types";
import { newId, randomToken } from "../lib/ids";
import { encryptConfig, decryptConfig, mergeSecrets } from "../lib/secret-config";
import { MONITOR_TYPES, type MonitorType } from "../../shared/states";
import type {
  Assertion,
  CreateMonitorInput,
  DnsConfig,
  DomainConfig,
  HeartbeatConfig,
  HttpConfig,
  NotifyPrefs,
  PublicConfig,
  Schedule,
  TcpConfig,
} from "../../shared/schemas";

/** Config shapes across every monitor type, stored as JSON in the `config` column. */
type MonitorConfig =
  | HttpConfig
  | HeartbeatConfig
  | DnsConfig
  | TcpConfig
  | DomainConfig;

/**
 * Monitor CRUD data layer. The `monitors` table stores config/schedule/
 * assertions/notify/public as JSON TEXT and booleans as 0/1 integers; this
 * module maps rows to/from a camelCase `MonitorRecord` with parsed objects.
 * Timestamps are epoch milliseconds. Polled monitors (http/dns/tcp/domain) run
 * on a fixed interval (720s); heartbeat monitors derive interval/grace from
 * their config.
 */

export interface MonitorRecord {
  id: string;
  type: MonitorType;
  name: string;
  enabled: boolean;
  paused: boolean;
  intervalSeconds: number;
  graceSeconds: number | null;
  config: MonitorConfig;
  schedule: Schedule;
  assertions: Assertion[];
  notify: NotifyPrefs;
  public: PublicConfig;
  categoryId: string | null;
  heartbeatToken: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/** Raw shape of a `monitors` row as returned by D1. */
interface MonitorRow {
  id: string;
  type: string;
  name: string;
  enabled: number;
  paused: number;
  interval_seconds: number;
  grace_seconds: number | null;
  config: string;
  schedule: string;
  assertions: string | null;
  notify: string | null;
  public: string | null;
  category_id: string | null;
  heartbeat_token: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

/** Parse a JSON column, falling back to a sensible empty on null/corrupt data. */
function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const DEFAULT_NOTIFY: NotifyPrefs = { channels: [] };
const DEFAULT_PUBLIC: PublicConfig = {
  visible: false,
  sortOrder: 0,
  showUptime: true,
  showResponseTime: false,
  showIncidentDetails: true,
  showScheduledOff: false,
};

/** Map a raw row to a typed record, parsing JSON and coercing 0/1 to booleans. */
function rowToMonitor(row: MonitorRow): MonitorRecord {
  return {
    id: row.id,
    // Validate against the known set; fall back to "http" for an unknown/corrupt
    // value so a bad row can't produce an off-union `type`.
    type: (MONITOR_TYPES as readonly string[]).includes(row.type)
      ? (row.type as MonitorType)
      : "http",
    name: row.name,
    enabled: row.enabled !== 0,
    paused: row.paused !== 0,
    intervalSeconds: row.interval_seconds,
    graceSeconds: row.grace_seconds ?? null,
    config: parseJson<MonitorConfig>(row.config, {} as MonitorConfig),
    schedule: parseJson<Schedule>(row.schedule, { mode: "always" }),
    assertions: parseJson<Assertion[]>(row.assertions, []),
    notify: parseJson<NotifyPrefs>(row.notify, DEFAULT_NOTIFY),
    public: parseJson<PublicConfig>(row.public, DEFAULT_PUBLIC),
    categoryId: row.category_id ?? null,
    heartbeatToken: row.heartbeat_token,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function decryptRecord(env: Env, rec: MonitorRecord): Promise<MonitorRecord> {
  rec.config = (await decryptConfig(
    env,
    rec.config as Record<string, unknown>,
  )) as MonitorRecord["config"];
  return rec;
}

export async function listMonitors(env: Env): Promise<MonitorRecord[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM monitors ORDER BY sort_order, created_at",
  ).all<MonitorRow>();
  return Promise.all((res.results ?? []).map((r) => decryptRecord(env, rowToMonitor(r))));
}

export async function getMonitor(
  env: Env,
  id: string,
): Promise<MonitorRecord | null> {
  const row = await env.DB.prepare("SELECT * FROM monitors WHERE id = ?")
    .bind(id)
    .first<MonitorRow>();
  return row ? decryptRecord(env, rowToMonitor(row)) : null;
}

/** Look up a heartbeat monitor by its ingestion token (for /hb/:token). */
export async function getMonitorByHeartbeatToken(
  env: Env,
  token: string,
): Promise<MonitorRecord | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM monitors WHERE heartbeat_token = ? AND type = 'heartbeat'",
  )
    .bind(token)
    .first<MonitorRow>();
  return row ? decryptRecord(env, rowToMonitor(row)) : null;
}

export async function createMonitor(
  env: Env,
  input: CreateMonitorInput,
): Promise<MonitorRecord> {
  const id = newId("mon");
  const now = Date.now();
  const heartbeatToken = input.type === "heartbeat" ? randomToken(18) : null;
  const intervalSeconds =
    input.type === "heartbeat" ? input.config.intervalSeconds : 720;
  const graceSeconds =
    input.type === "heartbeat" ? input.config.graceSeconds : null;
  const assertions = input.type === "http" ? input.assertions : null;
  const storedConfig = await encryptConfig(
    env,
    input.type,
    input.config as Record<string, unknown>,
  );

  // Both inserts run as one transaction (like deleteMonitor): a failure of
  // either rolls back both, so a monitor can never exist without its
  // monitor_state row. An orphaned monitor would be permanently un-checkable —
  // every other code path only UPDATEs monitor_state (0 rows when absent).
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO monitors (
         id, type, name, enabled, paused, interval_seconds, grace_seconds,
         config, schedule, assertions, notify, public, category_id, heartbeat_token,
         sort_order, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      input.type,
      input.name,
      input.enabled ? 1 : 0,
      0,
      intervalSeconds,
      graceSeconds,
      JSON.stringify(storedConfig),
      JSON.stringify(input.schedule),
      assertions == null ? null : JSON.stringify(assertions),
      JSON.stringify(input.notify),
      JSON.stringify(input.public),
      input.categoryId ?? null,
      heartbeatToken,
      0,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO monitor_state (
         monitor_id, state, state_since, consecutive_failures,
         consecutive_successes, next_check_at, updated_at
       ) VALUES (?, 'unknown', ?, 0, 0, ?, ?)`,
    ).bind(id, now, now, now),
  ]);

  const created = await getMonitor(env, id);
  if (!created) throw new Error("createMonitor: failed to read back inserted row");
  return created;
}

export async function updateMonitor(
  env: Env,
  id: string,
  input: CreateMonitorInput,
): Promise<MonitorRecord | null> {
  const existing = await getMonitor(env, id);
  if (!existing) return null;

  const now = Date.now();
  const intervalSeconds =
    input.type === "heartbeat" ? input.config.intervalSeconds : 720;
  const graceSeconds =
    input.type === "heartbeat" ? input.config.graceSeconds : null;
  const assertions = input.type === "http" ? input.assertions : null;
  // Preserve secrets the client redacted (sent empty), then encrypt at rest.
  const merged = mergeSecrets(
    input.config as Record<string, unknown>,
    existing.config as Record<string, unknown>,
  );
  const storedConfig = await encryptConfig(env, input.type, merged);

  // Full replace of mutable fields; id, heartbeat_token, created_at and
  // sort_order are preserved (type is immutable, enforced at the route layer).
  await env.DB.prepare(
    `UPDATE monitors SET
       name = ?, enabled = ?, interval_seconds = ?, grace_seconds = ?,
       config = ?, schedule = ?, assertions = ?, notify = ?, public = ?,
       category_id = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      input.name,
      input.enabled ? 1 : 0,
      intervalSeconds,
      graceSeconds,
      JSON.stringify(storedConfig),
      JSON.stringify(input.schedule),
      assertions == null ? null : JSON.stringify(assertions),
      JSON.stringify(input.notify),
      JSON.stringify(input.public),
      input.categoryId ?? null,
      now,
      id,
    )
    .run();

  return getMonitor(env, id);
}

export async function setPaused(
  env: Env,
  id: string,
  paused: boolean,
): Promise<MonitorRecord | null> {
  const existing = await getMonitor(env, id);
  if (!existing) return null;
  await env.DB.prepare(
    "UPDATE monitors SET paused = ?, updated_at = ? WHERE id = ?",
  )
    .bind(paused ? 1 : 0, Date.now(), id)
    .run();
  return getMonitor(env, id);
}

export async function deleteMonitor(env: Env, id: string): Promise<void> {
  // Explicit cascading delete (child → parent) so removal works regardless of
  // whether FK enforcement is active. Batched so it runs as one transaction.
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM incident_events WHERE incident_id IN (SELECT id FROM incidents WHERE monitor_id = ?)",
    ).bind(id),
    env.DB.prepare("DELETE FROM incidents WHERE monitor_id = ?").bind(id),
    env.DB.prepare("DELETE FROM samples WHERE monitor_id = ?").bind(id),
    env.DB.prepare("DELETE FROM status_intervals WHERE monitor_id = ?").bind(id),
    env.DB.prepare("DELETE FROM summaries WHERE monitor_id = ?").bind(id),
    env.DB.prepare("DELETE FROM monitor_state WHERE monitor_id = ?").bind(id),
    // Purge any queued/failed deliveries for this monitor so a "down" alert
    // can't fire for a monitor that no longer exists (migration 0004 added the
    // monitor_id column that makes this correlation possible).
    env.DB.prepare("DELETE FROM notification_outbox WHERE monitor_id = ?").bind(id),
    env.DB.prepare("DELETE FROM monitors WHERE id = ?").bind(id),
  ]);
}
