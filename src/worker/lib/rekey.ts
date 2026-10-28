import type { Env } from "../types";
import {
  DecryptError,
  decryptWithKeyring,
  encryptWithKeyring,
  getKeyring,
  isCiphertext,
  type Keyring,
} from "./crypto";
import {
  ConfigOpenError,
  SEALED_CONFIG_KEY,
  openConfigStrict,
} from "./secret-config";
import { channelSecretFields, secretFieldsFor } from "../db/channels";
import { sha256hex } from "./ids";

/**
 * `MASTER_KEY` rotation: an idempotent re-encryption pass over every protected
 * storage class, and a status report that proves when the previous key is no
 * longer needed (docs/SECURITY.md, "Rotating MASTER_KEY").
 *
 * The pass works in bounded, resumable batches so one request stays far inside
 * the Workers Free limits (50 D1 queries and 10 ms of CPU per invocation): at
 * most {@link MAX_ROWS_PER_CALL} rows are read and rewritten per call, with one
 * SELECT per storage class touched plus one batched UPDATE per changed row.
 * Every UPDATE is a compare-and-swap on the exact stored value, so a concurrent
 * edit by the app (which already writes with the current key) wins and the pass
 * never clobbers it. A row with any value that no configured key can open is
 * reported by id and left exactly as it is.
 */

/** Rows read per call by default, and the most a caller may ask for. */
export const DEFAULT_ROWS_PER_CALL = 25;
export const MAX_ROWS_PER_CALL = 35;

export type StorageClassId =
  | "settings"
  | "monitor_config"
  | "channel_secrets"
  | "push_secrets"
  | "outbox_payloads";

export interface Unreadable {
  class: StorageClassId;
  /** Row id (the settings key for settings). Never a stored value. */
  id: string;
  /** Column or config field that could not be opened. */
  field: string;
  reason: string;
}

interface RowOutcome {
  update: D1PreparedStatement | null;
  reencrypted: number;
  sealed: number;
  unreadable: Unreadable[];
}

type Row = Record<string, unknown> & { id: string };

interface StorageClass {
  id: StorageClassId;
  label: string;
  select(env: Env, after: string, limit: number): D1PreparedStatement;
  rekey(env: Env, keyring: Keyring, row: Row): Promise<RowOutcome>;
}

type ValueOutcome =
  | { kind: "keep" }
  | { kind: "rewrite"; value: string; sealed: boolean }
  | { kind: "unreadable"; reason: string };

/**
 * Bring one stored value onto the current key. A `v2:` value under the current
 * key is still decrypted, so corrupt data is reported instead of passed over.
 * A plaintext value is sealed only where plaintext is a legitimate legacy form.
 */
async function rekeyValue(
  keyring: Keyring,
  value: string,
  plaintextAllowed: boolean,
): Promise<ValueOutcome> {
  if (!isCiphertext(value)) {
    if (!plaintextAllowed) return { kind: "unreadable", reason: "invalid_format" };
    return { kind: "rewrite", value: await encryptWithKeyring(keyring, value), sealed: true };
  }
  try {
    const opened = await decryptWithKeyring(keyring, value);
    if (opened.version === "v2" && opened.keyRole === "current") return { kind: "keep" };
    return {
      kind: "rewrite",
      value: await encryptWithKeyring(keyring, opened.plaintext),
      sealed: false,
    };
  } catch (e) {
    return {
      kind: "unreadable",
      reason: e instanceof DecryptError ? e.code : "decrypt_failed",
    };
  }
}

/** Fold the per-value outcomes of one row into a row outcome. */
async function rekeyColumns(
  cls: StorageClassId,
  keyring: Keyring,
  row: Row,
  columns: readonly string[],
  plaintextAllowed: boolean,
): Promise<{ values: Map<string, string>; outcome: Omit<RowOutcome, "update"> }> {
  const values = new Map<string, string>();
  const outcome: Omit<RowOutcome, "update"> = { reencrypted: 0, sealed: 0, unreadable: [] };
  for (const column of columns) {
    const value = row[column];
    if (typeof value !== "string" || value === "") continue;
    const result = await rekeyValue(keyring, value, plaintextAllowed);
    if (result.kind === "unreadable") {
      outcome.unreadable.push({ class: cls, id: row.id, field: column, reason: result.reason });
    } else if (result.kind === "rewrite") {
      values.set(column, result.value);
      if (result.sealed) outcome.sealed += 1;
      else outcome.reencrypted += 1;
    }
  }
  return { values, outcome };
}

const unchanged = (): RowOutcome => ({ update: null, reencrypted: 0, sealed: 0, unreadable: [] });

export const STORAGE_CLASSES: readonly StorageClass[] = [
  {
    // The generated VAPID private key (and any other encrypted setting).
    id: "settings",
    label: "Encrypted settings",
    select: (env, after, limit) =>
      env.DB.prepare(
        `SELECT key AS id, value, encrypted FROM settings
          WHERE (encrypted = 1 OR key = 'vapid_private_key') AND key > ?
          ORDER BY key LIMIT ?`,
      ).bind(after, limit),
    async rekey(env, keyring, row) {
      const value = row.value;
      if (typeof value !== "string" || value === "") return unchanged();
      // encrypted = 0 is a VAPID private key generated before MASTER_KEY was
      // configured: plaintext by definition, so seal it (even one that happens
      // to look like ciphertext).
      const result =
        row.encrypted === 1
          ? await rekeyValue(keyring, value, false)
          : { kind: "rewrite" as const, value: await encryptWithKeyring(keyring, value), sealed: true };
      if (result.kind === "keep") return unchanged();
      if (result.kind === "unreadable") {
        return {
          ...unchanged(),
          unreadable: [{ class: "settings", id: row.id, field: "value", reason: result.reason }],
        };
      }
      return {
        update: env.DB.prepare(
          "UPDATE settings SET value = ?, encrypted = 1 WHERE key = ? AND value = ? AND encrypted = ?",
        ).bind(result.value, row.id, value, row.encrypted),
        reencrypted: result.sealed ? 0 : 1,
        sealed: result.sealed ? 1 : 0,
        unreadable: [],
      };
    },
  },
  {
    id: "monitor_config",
    label: "Monitor configuration",
    select: (env, after, limit) =>
      env.DB.prepare(
        "SELECT id, config FROM monitors WHERE id > ? ORDER BY id LIMIT ?",
      ).bind(after, limit),
    async rekey(env, keyring, row) {
      const raw = typeof row.config === "string" ? row.config : "{}";
      let stored: unknown;
      try {
        stored = JSON.parse(raw);
      } catch {
        stored = null;
      }
      if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
        return {
          ...unchanged(),
          unreadable: [{ class: "monitor_config", id: row.id, field: "config", reason: "invalid_json" }],
        };
      }
      try {
        const opened = await openConfigStrict(keyring, stored as Record<string, unknown>);
        if (opened.current) return unchanged();
        // Seal the whole document, exactly as encryptConfig does on save. This
        // also seals a legacy unsealed config, which used to wait for an edit.
        const resealed = JSON.stringify({
          [SEALED_CONFIG_KEY]: await encryptWithKeyring(keyring, JSON.stringify(opened.config)),
        });
        return {
          update: env.DB.prepare(
            "UPDATE monitors SET config = ? WHERE id = ? AND config = ?",
          ).bind(resealed, row.id, raw),
          reencrypted: opened.ciphertexts,
          sealed: opened.sealed ? 0 : 1,
          unreadable: [],
        };
      } catch (e) {
        if (!(e instanceof ConfigOpenError)) throw e;
        return {
          ...unchanged(),
          unreadable: [{ class: "monitor_config", id: row.id, field: e.field, reason: e.code }],
        };
      }
    },
  },
  {
    // Discord, Slack, Teams and generic webhook URLs, the webhook HMAC secret
    // and the Telegram bot token (see CHANNEL_SECRET_FIELDS in db/channels.ts).
    id: "channel_secrets",
    label: "Notification channel secrets",
    select: (env, after, limit) =>
      env.DB.prepare(
        "SELECT id, type, config FROM notification_channels WHERE id > ? ORDER BY id LIMIT ?",
      ).bind(after, limit),
    async rekey(env, keyring, row) {
      const fields = secretFieldsFor(String(row.type));
      if (fields.length === 0) return unchanged();
      const raw = typeof row.config === "string" ? row.config : "{}";
      let config: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        config = parsed as Record<string, unknown>;
      } catch {
        return {
          ...unchanged(),
          unreadable: [{ class: "channel_secrets", id: row.id, field: "config", reason: "invalid_json" }],
        };
      }
      const { values, outcome } = await rekeyColumns(
        "channel_secrets",
        keyring,
        { ...config, id: row.id },
        fields,
        true,
      );
      if (outcome.unreadable.length > 0 || values.size === 0) {
        return { ...outcome, update: null, reencrypted: 0, sealed: 0 };
      }
      const next = { ...config, ...Object.fromEntries(values) };
      return {
        ...outcome,
        update: env.DB.prepare(
          "UPDATE notification_channels SET config = ? WHERE id = ? AND config = ?",
        ).bind(JSON.stringify(next), row.id, raw),
      };
    },
  },
  {
    // Web Push endpoints and their p256dh / auth key material.
    id: "push_secrets",
    label: "Web Push subscriptions",
    select: (env, after, limit) =>
      env.DB.prepare(
        `SELECT id, endpoint, endpoint_hash, p256dh, auth FROM push_subscriptions
          WHERE id > ? ORDER BY id LIMIT ?`,
      ).bind(after, limit),
    async rekey(env, keyring, row) {
      const columns = ["endpoint", "p256dh", "auth"] as const;
      const { values, outcome } = await rekeyColumns("push_secrets", keyring, row, columns, true);
      if (outcome.unreadable.length > 0 || values.size === 0) {
        return { ...outcome, update: null, reencrypted: 0, sealed: 0 };
      }
      // A subscription from before migration 0008 has no endpoint digest yet;
      // give it one while sealing it, as a re-registration would.
      let endpointHash = row.endpoint_hash as string | null;
      if (!endpointHash && !isCiphertext(row.endpoint)) {
        endpointHash = await sha256hex(String(row.endpoint));
      }
      const next = (c: (typeof columns)[number]) => values.get(c) ?? (row[c] as string);
      return {
        ...outcome,
        // OR IGNORE: a legacy duplicate whose digest is already taken stays as
        // it is (and is counted as a conflict) instead of failing the batch.
        update: env.DB.prepare(
          `UPDATE OR IGNORE push_subscriptions
              SET endpoint = ?, p256dh = ?, auth = ?, endpoint_hash = ?
            WHERE id = ? AND endpoint = ? AND p256dh = ? AND auth = ?`,
        ).bind(
          next("endpoint"),
          next("p256dh"),
          next("auth"),
          endpointHash,
          row.id,
          row.endpoint,
          row.p256dh,
          row.auth,
        ),
      };
    },
  },
  {
    // Every outbox payload, delivered history included: it stays readable.
    id: "outbox_payloads",
    label: "Notification outbox payloads",
    select: (env, after, limit) =>
      env.DB.prepare(
        "SELECT id, payload FROM notification_outbox WHERE id > ? ORDER BY id LIMIT ?",
      ).bind(after, limit),
    async rekey(env, keyring, row) {
      const { values, outcome } = await rekeyColumns("outbox_payloads", keyring, row, ["payload"], true);
      const payload = values.get("payload");
      if (outcome.unreadable.length > 0 || payload === undefined) {
        return { ...outcome, update: null, reencrypted: 0, sealed: 0 };
      }
      return {
        ...outcome,
        update: env.DB.prepare(
          "UPDATE notification_outbox SET payload = ? WHERE id = ? AND payload = ?",
        ).bind(payload, row.id, row.payload),
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

interface Cursor {
  /** Index into STORAGE_CLASSES. */
  c: number;
  /** Last primary key processed in that class ("" = from the start). */
  a: string;
}

export function encodeCursor(cursor: Cursor): string {
  return btoa(JSON.stringify(cursor)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode a cursor from a previous batch; null when it is not one. */
export function decodeCursor(value: string): Cursor | null {
  try {
    const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(atob(b64)) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    const { c, a } = parsed as Record<string, unknown>;
    if (!Number.isInteger(c) || (c as number) < 0 || (c as number) > STORAGE_CLASSES.length) {
      return null;
    }
    if (typeof a !== "string" || a.length > 256) return null;
    return { c: c as number, a };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export interface BatchStats {
  scanned: number;
  /** Rows written back with every value on the current key. */
  rewritten: number;
  /** Values decrypted with an older key or format and encrypted again. */
  reencrypted: number;
  /** Legacy plaintext values encrypted for the first time. */
  sealed: number;
  /** Rows already entirely on the current key. */
  unchanged: number;
  /** Rows changed by someone else mid-batch (they already use the current key). */
  conflicts: number;
}

export interface BatchResult {
  done: boolean;
  /** Pass this back to continue; null once every class is done. */
  cursor: string | null;
  stats: BatchStats;
  unreadable: Unreadable[];
  /** The storage class the next batch starts in (null when done). */
  nextClass: StorageClassId | null;
}

export type RekeyPrecondition = "master_key_not_configured" | "previous_key_invalid";

/** Why the pass cannot run with this configuration, or null when it can. */
export function rekeyPrecondition(keyring: Keyring): RekeyPrecondition | null {
  if (!keyring.current) return "master_key_not_configured";
  // Rewriting while the old key is unusable would only report its values as
  // unreadable; refuse so a typo in the secret is fixed first.
  if (keyring.previousInvalid) return "previous_key_invalid";
  return null;
}

/** Run one bounded batch of the re-encryption pass from `cursor`. */
export async function runRekeyBatch(
  env: Env,
  keyring: Keyring,
  cursor: Cursor = { c: 0, a: "" },
  rowLimit = DEFAULT_ROWS_PER_CALL,
): Promise<BatchResult> {
  const limit = Math.max(1, Math.min(MAX_ROWS_PER_CALL, Math.floor(rowLimit)));
  const stats: BatchStats = {
    scanned: 0,
    rewritten: 0,
    reencrypted: 0,
    sealed: 0,
    unchanged: 0,
    conflicts: 0,
  };
  const unreadable: Unreadable[] = [];
  let { c, a } = cursor;
  let remaining = limit;

  while (c < STORAGE_CLASSES.length && remaining > 0) {
    const cls = STORAGE_CLASSES[c]!;
    const requested = remaining;
    const { results } = await cls.select(env, a, requested).all<Row>();
    const rows = results ?? [];
    const updates: D1PreparedStatement[] = [];
    let pendingReencrypted = 0;
    let pendingSealed = 0;
    for (const row of rows) {
      const outcome = await cls.rekey(env, keyring, row);
      stats.scanned += 1;
      unreadable.push(...outcome.unreadable);
      if (outcome.update) {
        updates.push(outcome.update);
        pendingReencrypted += outcome.reencrypted;
        pendingSealed += outcome.sealed;
      } else if (outcome.unreadable.length === 0) {
        stats.unchanged += 1;
      }
    }
    if (updates.length > 0) {
      // One D1 batch: a single round trip, applied as one transaction.
      const written = await env.DB.batch(updates);
      const applied = written.filter((r) => (r.meta?.changes ?? 0) > 0).length;
      stats.rewritten += applied;
      stats.conflicts += updates.length - applied;
      // A conflicted row was rewritten by the app under the current key; count
      // only the values this pass actually wrote when nothing conflicted.
      if (applied === updates.length) {
        stats.reencrypted += pendingReencrypted;
        stats.sealed += pendingSealed;
      } else {
        stats.reencrypted += Math.round((pendingReencrypted * applied) / updates.length);
        stats.sealed += Math.round((pendingSealed * applied) / updates.length);
      }
    }
    remaining -= rows.length;
    if (rows.length < requested) {
      // Fewer rows than requested: this class is exhausted.
      c += 1;
      a = "";
    } else {
      a = rows[rows.length - 1]!.id;
    }
  }

  const done = c >= STORAGE_CLASSES.length;
  return {
    done,
    cursor: done ? null : encodeCursor({ c, a }),
    stats,
    unreadable,
    nextClass: done ? null : STORAGE_CLASSES[c]!.id,
  };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Each storage class's protected values as `(id, field, v, hint)` rows. `hint`
 * forces a classification the value itself cannot carry: "plaintext" for a
 * legacy unsealed location, "invalid" for a row whose JSON cannot be read.
 */
/**
 * The (field, JSON path, channel type) rows of every channel secret, built from
 * the data layer's own list so a new channel type is always counted. It is a
 * `json_each` table rather than a chain of UNION ALLs, because D1 allows only a
 * few terms in one compound SELECT. The names are fixed identifiers from code,
 * never user input, and contain no quotes.
 */
const CHANNEL_SECRET_SOURCE = `
            SELECT json_extract(value, '$.field') AS field,
                   json_extract(value, '$.path') AS path,
                   json_extract(value, '$.type') AS type
              FROM json_each('${JSON.stringify(
                channelSecretFields().map(({ type, field }) => ({ field, path: `$.${field}`, type })),
              )}')`;

const VALUE_SOURCES: Record<StorageClassId, string> = {
  settings: `
    SELECT key AS id, 'value' AS field, value AS v,
           CASE WHEN encrypted = 0 THEN 'plaintext' END AS hint
      FROM settings WHERE encrypted = 1 OR key = 'vapid_private_key'`,
  monitor_config: `
    SELECT id, 'config' AS field,
           CASE WHEN json_valid(config) THEN json_extract(config, '$.${SEALED_CONFIG_KEY}') END AS v,
           CASE WHEN NOT json_valid(config) THEN 'invalid'
                WHEN json_type(config, '$.${SEALED_CONFIG_KEY}') IS NOT 'text' THEN 'plaintext' END AS hint
      FROM monitors
    UNION ALL
    SELECT id, f.field, json_extract(config, f.path), NULL
      FROM monitors,
           (SELECT 'secret' AS field, '$.secret' AS path
            UNION ALL SELECT 'auth.password', '$.auth.password'
            UNION ALL SELECT 'auth.token', '$.auth.token') AS f
     WHERE json_valid(config)
       AND json_type(config, '$.${SEALED_CONFIG_KEY}') IS NOT 'text'
       AND json_type(config, f.path) = 'text'
       AND (json_extract(config, f.path) GLOB 'v1:*' OR json_extract(config, f.path) GLOB 'v2:*')`,
  channel_secrets: `
    SELECT id, f.field,
           CASE WHEN json_valid(config) THEN json_extract(config, f.path) END AS v,
           CASE WHEN NOT json_valid(config) THEN 'invalid' END AS hint
      FROM notification_channels,
           (${CHANNEL_SECRET_SOURCE}) AS f
     WHERE notification_channels.type = f.type
       AND (NOT json_valid(config) OR json_type(config, f.path) = 'text')`,
  push_secrets: `
    SELECT id, f.field,
           CASE f.field WHEN 'endpoint' THEN endpoint WHEN 'p256dh' THEN p256dh ELSE auth END AS v,
           NULL AS hint
      FROM push_subscriptions,
           (SELECT 'endpoint' AS field UNION ALL SELECT 'p256dh' UNION ALL SELECT 'auth') AS f`,
  outbox_payloads: `
    SELECT id, 'payload' AS field, payload AS v, NULL AS hint FROM notification_outbox`,
};

/** SQL classification of one value; ?1 is the current key id, ?2 the previous. */
const CLASSIFY = `
  CASE
    WHEN hint IS NOT NULL THEN hint
    WHEN v IS NULL OR v = '' THEN NULL
    WHEN v GLOB 'v2:*' AND substr(v, 4, 8) = ?1 THEN 'current'
    WHEN v GLOB 'v2:*' AND substr(v, 4, 8) = ?2 THEN 'previous'
    WHEN v GLOB 'v2:*' THEN 'unknown'
    WHEN v GLOB 'v1:*' THEN 'legacy'
    ELSE 'plaintext'
  END`;

const ROW_COUNTS: Record<StorageClassId, string> = {
  settings: "SELECT COUNT(*) FROM settings WHERE encrypted = 1 OR key = 'vapid_private_key'",
  monitor_config: "SELECT COUNT(*) FROM monitors",
  channel_secrets: "SELECT COUNT(*) FROM notification_channels",
  push_secrets: "SELECT COUNT(*) FROM push_subscriptions",
  outbox_payloads: "SELECT COUNT(*) FROM notification_outbox",
};

/** How many non-current values the status report opens to see which key they need. */
const TRIAL_LIMIT = 50;
/** The most unreadable locations one status report lists. */
const UNREADABLE_LIST_LIMIT = 100;

export interface ClassStatus {
  id: StorageClassId;
  label: string;
  /** Rows the re-encryption pass scans (for progress). */
  rows: number;
  /** `v2:` values under the current key. */
  current: number;
  /** `v2:` values under the previous key. */
  previous: number;
  /** `v1:` values (no key id: re-encrypting them proves which key they need). */
  legacy: number;
  /** Legacy plaintext values that the pass will encrypt. */
  unsealed: number;
  /** Values under a key that is not configured, or rows that cannot be parsed. */
  unreadable: number;
}

export interface RekeyStatus {
  encryptionConfigured: boolean;
  currentKeyId: string | null;
  previousKey: {
    configured: boolean;
    valid: boolean;
    keyId: string | null;
    sameAsCurrent: boolean;
  };
  classes: ClassStatus[];
  /** Values the pass would still rewrite (previous key, legacy format, plaintext). */
  needsReencryption: number;
  /** Values that can only be read with the previous key (or not yet checked). */
  dependsOnPreviousKey: number;
  /** Non-current values beyond the trial-decryption sample, assumed to depend on it. */
  unverified: number;
  /** Values no configured key can open: never rewritten, listed by location. */
  unreadable: Unreadable[];
  unreadableCount: number;
  safeToRemovePreviousKey: boolean;
  summary: string;
}

interface ValueRow {
  class: StorageClassId;
  id: string;
  field: string;
  v: string | null;
  cls: string;
}

/** Count every protected value by key and prove what still needs the previous key. */
export async function rekeyStatus(env: Env): Promise<RekeyStatus> {
  let keyring: Keyring;
  let currentInvalid = false;
  try {
    keyring = await getKeyring(env);
  } catch {
    // An invalid MASTER_KEY: report it rather than failing the whole page.
    currentInvalid = true;
    keyring = await getKeyring({ ...env, MASTER_KEY: undefined });
  }
  const currentKid = keyring.current?.kid ?? null;
  const previousKid = keyring.previous?.kid ?? null;
  // A key id is 8 hex characters, so "-" can never match a stored one.
  const binds = [currentKid ?? "-", previousKid ?? "-"];

  const values = (Object.keys(VALUE_SOURCES) as StorageClassId[])
    .map((id) => `SELECT '${id}' AS class, id, field, v, ${CLASSIFY} AS cls FROM (${VALUE_SOURCES[id]})`)
    .join("\nUNION ALL\n");
  const rowCounts = (Object.keys(ROW_COUNTS) as StorageClassId[])
    .map((id) => `SELECT '${id}' AS class, (${ROW_COUNTS[id]}) AS n`)
    .join(" UNION ALL ");

  const [counted, sample, rowTotals] = await env.DB.batch([
    env.DB.prepare(
      `SELECT class, cls, COUNT(*) AS n FROM (${values}) WHERE cls IS NOT NULL GROUP BY class, cls`,
    ).bind(...binds),
    // Unreadable locations first (always listed), then the values whose key is
    // not known from the key id alone, which are opened below.
    env.DB.prepare(
      `SELECT class, id, field, CASE WHEN cls IN ('legacy', 'previous') THEN v END AS v, cls
         FROM (${values})
        WHERE cls IN ('unknown', 'invalid', 'legacy', 'previous')
        ORDER BY CASE cls WHEN 'unknown' THEN 0 WHEN 'invalid' THEN 0 ELSE 1 END, class, id
        LIMIT ?3`,
    ).bind(...binds, UNREADABLE_LIST_LIMIT + TRIAL_LIMIT),
    env.DB.prepare(rowCounts),
  ]);

  const classes: ClassStatus[] = STORAGE_CLASSES.map((cls) => ({
    id: cls.id,
    label: cls.label,
    rows: 0,
    current: 0,
    previous: 0,
    legacy: 0,
    unsealed: 0,
    unreadable: 0,
  }));
  const byId = new Map(classes.map((c) => [c.id, c]));
  for (const r of (rowTotals?.results ?? []) as Array<{ class: StorageClassId; n: number }>) {
    byId.get(r.class)!.rows = r.n;
  }
  for (const r of (counted?.results ?? []) as Array<{ class: StorageClassId; cls: string; n: number }>) {
    const c = byId.get(r.class)!;
    if (r.cls === "current") c.current += r.n;
    else if (r.cls === "previous") c.previous += r.n;
    else if (r.cls === "legacy") c.legacy += r.n;
    else if (r.cls === "plaintext") c.unsealed += r.n;
    else c.unreadable += r.n;
  }

  const sum = (k: keyof Omit<ClassStatus, "id" | "label">) =>
    classes.reduce((n, c) => n + c[k], 0);
  // Values whose key the key id alone does not settle: a v1 value could be
  // under either key, and a previous-key value could be corrupt.
  const nonCurrent = sum("previous") + sum("legacy");

  const unreadable: Unreadable[] = [];
  let dependsOnPrevious = 0;
  let checked = 0;
  const canTrial = keyring.current !== null || keyring.previous !== null;
  for (const r of (sample?.results ?? []) as unknown as ValueRow[]) {
    if (r.cls === "unknown" || r.cls === "invalid") {
      unreadable.push({
        class: r.class,
        id: r.id,
        field: r.field,
        reason: r.cls === "unknown" ? "unknown_key" : "invalid_json",
      });
      continue;
    }
    if (!canTrial || checked >= TRIAL_LIMIT || r.v == null) continue;
    checked += 1;
    const c = byId.get(r.class)!;
    if (!isCiphertext(r.v)) {
      // A plaintext value that merely starts with "v1:": the pass seals it.
      c.legacy -= 1;
      c.unsealed += 1;
      continue;
    }
    try {
      const opened = await decryptWithKeyring(keyring, r.v);
      if (opened.keyRole === "previous") dependsOnPrevious += 1;
    } catch (e) {
      unreadable.push({
        class: r.class,
        id: r.id,
        field: r.field,
        reason: e instanceof DecryptError ? e.code : "decrypt_failed",
      });
      if (r.cls === "legacy") c.legacy -= 1;
      else c.previous -= 1;
      c.unreadable += 1;
    }
  }
  // Values beyond the trial sample are assumed to need the previous key until
  // the pass has rewritten them (after a complete pass only unreadable ones remain).
  const unverified = Math.max(0, nonCurrent - checked);
  dependsOnPrevious += unverified;

  const previousConfigured = Boolean(env.MASTER_KEY_PREVIOUS);
  const sameAsCurrent = previousKid !== null && previousKid === currentKid;
  const encryptionConfigured = keyring.current !== null && !currentInvalid;
  const safeToRemovePreviousKey =
    previousConfigured && !keyring.previousInvalid && (sameAsCurrent || dependsOnPrevious === 0);
  const unreadableCount = sum("unreadable");

  return {
    encryptionConfigured,
    currentKeyId: currentKid,
    previousKey: {
      configured: previousConfigured,
      valid: previousConfigured && !keyring.previousInvalid,
      keyId: previousKid,
      sameAsCurrent,
    },
    classes,
    needsReencryption: sum("previous") + sum("legacy") + sum("unsealed"),
    dependsOnPreviousKey: keyring.previous ? dependsOnPrevious : 0,
    unverified,
    unreadable: unreadable.slice(0, UNREADABLE_LIST_LIMIT),
    unreadableCount,
    safeToRemovePreviousKey,
    summary: summarize({
      encryptionConfigured,
      currentInvalid,
      previousConfigured,
      previousInvalid: keyring.previousInvalid,
      sameAsCurrent,
      dependsOnPrevious,
      needs: sum("previous") + sum("legacy") + sum("unsealed"),
      unreadableCount,
    }),
  };
}

function summarize(s: {
  encryptionConfigured: boolean;
  currentInvalid: boolean;
  previousConfigured: boolean;
  previousInvalid: boolean;
  sameAsCurrent: boolean;
  dependsOnPrevious: number;
  needs: number;
  unreadableCount: number;
}): string {
  const parts: string[] = [];
  const values = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "value" : "values"}`;
  if (s.currentInvalid) {
    parts.push("MASTER_KEY is not a base64-encoded 32-byte key, so nothing can be encrypted or re-encrypted.");
  } else if (!s.encryptionConfigured) {
    parts.push("MASTER_KEY is not configured, so encryption at rest is off and nothing can be re-encrypted.");
  } else if (s.previousInvalid) {
    parts.push(
      "MASTER_KEY_PREVIOUS is set but is not a base64-encoded 32-byte key. Values sealed with the old key cannot be read until it is fixed.",
    );
  } else if (s.previousConfigured) {
    if (s.sameAsCurrent) {
      parts.push("MASTER_KEY_PREVIOUS is the same key as MASTER_KEY. It is safe to delete MASTER_KEY_PREVIOUS.");
    } else if (s.dependsOnPrevious === 0) {
      parts.push("No stored value depends on the previous key. It is safe to delete MASTER_KEY_PREVIOUS.");
    } else {
      parts.push(
        `${values(s.dependsOnPrevious)} still depend on the previous key. Run the re-encryption pass, then check again before deleting MASTER_KEY_PREVIOUS.`,
      );
    }
  } else if (s.needs > 0) {
    parts.push(`${values(s.needs)} are not yet on the current key format. Run the re-encryption pass to update them.`);
  } else {
    parts.push(
      s.unreadableCount > 0
        ? "Every readable value is encrypted with the current key."
        : "Every protected value is encrypted with the current key.",
    );
  }
  if (s.unreadableCount > 0) {
    parts.push(
      s.unreadableCount === 1
        ? "1 value cannot be decrypted with any configured key. It is listed below by location, was left unchanged, and must be re-created or deleted."
        : `${values(s.unreadableCount)} cannot be decrypted with any configured key. They are listed below by location, were left unchanged, and must be re-created or deleted.`,
    );
  }
  return parts.join(" ");
}
