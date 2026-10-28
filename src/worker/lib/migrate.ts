import { migrations as BUNDLED_MIGRATIONS, version } from "virtual:openping-bundle";

/**
 * Self-migration, for hosted mode only (docs/hosted/CONTRACT.md, section 6).
 *
 * A plain install's migrations run from `npm run deploy` (`wrangler d1
 * migrations apply`), and nothing here ever runs for it. A customer's OpenPing
 * in OpenPing Hosted has nobody to run that, so it carries its migrations in
 * the bundle (scripts/bundle-module.ts), and the platform's own calls (the
 * every-minute scheduler, the release runner's health check) apply the ones
 * its database is missing. A public call only looks (schemaIsCurrent): a
 * visitor's request, which the browser may cancel at any moment, never takes
 * the lock.
 *
 * It keeps Wrangler's own bookkeeping: applied migrations are rows of
 * `d1_migrations`, by file name, so this and `wrangler d1 migrations apply`
 * always agree on what a database has. Each migration and its row go in one
 * batch, which D1 runs as one transaction: a migration is applied whole or not
 * at all, and `d1_migrations.name` is UNIQUE, so it can't be applied twice.
 * A lock row (`d1_migrations_lock`, with a short TTL pushed on with each
 * migration) keeps a second call from even trying while one migrates; that
 * call waits for it, polling with reads only.
 *
 * Migrations must be additive (RELEASING.md; scripts/check-migrations.test.mjs),
 * because an older bundle keeps running on a newer schema during a rollout or
 * after a rollback.
 */

/** The OpenPing version of this bundle (package.json). */
export const BUNDLE_VERSION = version;

export interface Migration {
  readonly name: string;
  readonly queries: readonly string[];
}

/** A migration's number: the digits its file name starts with ("0019_x.sql" is 19). */
export function migrationNumber(name: string): number {
  const digits = /^(\d+)/.exec(name)?.[1];
  return digits ? Number(digits) : 0;
}

/** The highest migration number among `names` (0 for none). */
export function schemaVersionOf(names: Iterable<string>): number {
  let max = 0;
  for (const name of names) max = Math.max(max, migrationNumber(name));
  return max;
}

/** The highest migration this bundle carries. */
export const BUNDLED_SCHEMA_VERSION = schemaVersionOf(BUNDLED_MIGRATIONS.map((m) => m.name));

export type SchemaResult =
  | { ok: true; applied: number; schemaVersion: number }
  | { ok: false; reason: "busy" | "failed"; error: string; applied: number; schemaVersion: number };

export interface EnsureSchemaOptions {
  /** How long to wait for another call that holds the lock (ms). 0 tries once. */
  waitMs?: number;
  /** How often to look again while waiting (ms). */
  pollMs?: number;
  /** Tests only: the migrations to apply instead of the bundle's. */
  migrations?: readonly Migration[];
}

const MIGRATIONS_TABLE = "d1_migrations";
const LOCK_TABLE = "d1_migrations_lock";
const LOCK_NAME = "schema";
/**
 * A lock left by a call that died mid-migration frees itself after this. Short,
 * because the holder pushes it on with every migration it applies.
 */
export const MIGRATION_LOCK_TTL_MS = 15_000;
const DEFAULT_WAIT_MS = 8_000;
const DEFAULT_POLL_MS = 250;
const ERROR_MAX_LENGTH = 200;
/** How long an isolate trusts that the schema is current before it looks again. */
export const CURRENT_TTL_MS = 10 * 60_000;
/** How long an isolate answers a failed migration from memory instead of trying again. */
export const FAILURE_TTL_MS = 30_000;

/**
 * Per isolate (a new bundle starts in new isolates, so the first call of each
 * after an update looks again): when the schema was last seen current, and
 * when a migration last failed here.
 */
let knownCurrent: { schemaVersion: number; at: number } | null = null;
let lastFailure: { result: SchemaResult & { ok: false }; at: number; of: readonly Migration[] } | null = null;

/**
 * Forget what this isolate remembers about the schema: for tests, and when a
 * query finds a table or column missing (index.ts), which means the database
 * changed under a schema it thought was current.
 */
export function forgetSchemaCheck(): void {
  knownCurrent = null;
  lastFailure = null;
}

/** "no such table" / "no such column": the schema is not what this bundle expects. */
export function isSchemaError(error: unknown): boolean {
  return /no such (table|column)/i.test(error instanceof Error ? error.message : String(error));
}

function isMissingTable(error: unknown): boolean {
  return /no such table/i.test(error instanceof Error ? error.message : String(error));
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > ERROR_MAX_LENGTH ? `${message.slice(0, ERROR_MAX_LENGTH - 3)}...` : message;
}

/** Names of the applied migrations; none when the bookkeeping table doesn't exist yet. */
async function appliedNames(db: D1Database): Promise<Set<string>> {
  try {
    const { results } = await db.prepare(`SELECT name FROM ${MIGRATIONS_TABLE}`).all<{ name: string }>();
    return new Set(results.map((r) => r.name));
  } catch (error) {
    if (isMissingTable(error)) return new Set();
    throw error;
  }
}

/** Is someone holding the migration lock now? A read; no lock table means no. */
async function lockHeld(db: D1Database, now: number): Promise<boolean> {
  try {
    const row = await db
      .prepare(`SELECT 1 AS held FROM ${LOCK_TABLE} WHERE name = ? AND expires_at > ?`)
      .bind(LOCK_NAME, now)
      .first<{ held: number }>();
    return !!row;
  } catch (error) {
    if (isMissingTable(error)) return false;
    throw error;
  }
}

/** The schema as the database has it now, for GET /__platform/health. */
export async function readSchemaState(
  db: D1Database,
  now: number = Date.now(),
): Promise<{ schemaVersion: number; migrating: boolean }> {
  const [names, migrating] = await Promise.all([appliedNames(db), lockHeld(db, now)]);
  return { schemaVersion: schemaVersionOf(names), migrating };
}

function fresh(memo: { at: number } | null, ttl: number, now: number): boolean {
  return !!memo && now - memo.at < ttl;
}

/**
 * For a public call: does the database carry every bundled migration? A read
 * at most (none while this isolate saw it current in the last 10 minutes); it
 * never migrates. Undefined when the database couldn't be read: the call goes
 * on and meets that error itself.
 */
export async function schemaIsCurrent(db: D1Database): Promise<boolean | undefined> {
  const now = Date.now();
  if (fresh(knownCurrent, CURRENT_TTL_MS, now)) return true;
  let names: Set<string>;
  try {
    names = await appliedNames(db);
  } catch (error) {
    console.error("[migrate] could not read the schema", error);
    return undefined;
  }
  const current = BUNDLED_MIGRATIONS.every((m) => names.has(m.name));
  if (current) knownCurrent = { schemaVersion: schemaVersionOf(names), at: now };
  return current;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One attempt: nothing to do, "busy" (another call holds the lock), or apply
 * every missing migration under the lock. Until the lock is free it only reads.
 */
async function attempt(db: D1Database, bundled: readonly Migration[]): Promise<SchemaResult | "busy"> {
  const before = await appliedNames(db);
  if (bundled.every((m) => before.has(m.name))) {
    return { ok: true, applied: 0, schemaVersion: schemaVersionOf(before) };
  }
  if (await lockHeld(db, Date.now())) return "busy";

  // Free (or expired): create the bookkeeping (Wrangler's own table
  // definition), take the lock and re-read what is applied, in one round trip.
  const holder = crypto.randomUUID();
  const now = Date.now();
  const [, , , holderRes, namesRes] = await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
         id         INTEGER PRIMARY KEY AUTOINCREMENT,
         name       TEXT UNIQUE,
         applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
       )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS ${LOCK_TABLE} (
         name       TEXT PRIMARY KEY,
         holder     TEXT NOT NULL,
         expires_at INTEGER NOT NULL
       )`,
    ),
    db
      .prepare(
        `INSERT INTO ${LOCK_TABLE} (name, holder, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
           WHERE ${LOCK_TABLE}.expires_at <= ?`,
      )
      .bind(LOCK_NAME, holder, now + MIGRATION_LOCK_TTL_MS, now),
    db.prepare(`SELECT holder FROM ${LOCK_TABLE} WHERE name = ?`).bind(LOCK_NAME),
    db.prepare(`SELECT name FROM ${MIGRATIONS_TABLE}`),
  ]);
  // Another call took it between the read and the batch.
  if ((holderRes?.results?.[0] as { holder?: string } | undefined)?.holder !== holder) return "busy";

  const applied = new Set(((namesRes?.results ?? []) as { name: string }[]).map((r) => r.name));
  let count = 0;
  try {
    for (const migration of bundled) {
      if (applied.has(migration.name)) continue;
      console.log(`[migrate] applying ${migration.name}`);
      try {
        await db.batch([
          ...migration.queries.map((query) => db.prepare(query)),
          db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES (?)`).bind(migration.name),
          // Still ours while it works: push the lock's expiry on with each migration.
          db
            .prepare(`UPDATE ${LOCK_TABLE} SET expires_at = ? WHERE name = ? AND holder = ?`)
            .bind(Date.now() + MIGRATION_LOCK_TTL_MS, LOCK_NAME, holder),
        ]);
      } catch (error) {
        console.error(`[migrate] ${migration.name} failed`, error);
        return {
          ok: false,
          reason: "failed",
          error: `migration ${migration.name} failed: ${shortError(error)}`,
          applied: count,
          schemaVersion: schemaVersionOf(applied),
        };
      }
      applied.add(migration.name);
      count++;
    }
  } finally {
    await db
      .prepare(`DELETE FROM ${LOCK_TABLE} WHERE name = ? AND holder = ?`)
      .bind(LOCK_NAME, holder)
      .run()
      .catch((error: unknown) => console.error("[migrate] could not release the lock", error));
  }
  if (count > 0) console.log(`[migrate] applied ${count} migration(s); schema version ${schemaVersionOf(applied)}`);
  return { ok: true, applied: count, schemaVersion: schemaVersionOf(applied) };
}

/**
 * Applies the bundled migrations the database is missing. For platform calls
 * only (routes/platform.ts). Answers at once when this isolate saw the schema
 * current in the last 10 minutes, or saw a migration fail in the last 30
 * seconds; otherwise it reads the applied migrations (one query), and only
 * when some are missing and the lock is free takes it and applies them,
 * oldest first. A call that finds the lock held looks again, reading only,
 * for up to `waitMs`.
 */
export async function ensureSchema(db: D1Database, opts: EnsureSchemaOptions = {}): Promise<SchemaResult> {
  const bundled = opts.migrations ?? BUNDLED_MIGRATIONS;
  // "Current" is remembered for the bundle's own migrations only; a failure,
  // for the list that failed (tests pass their own).
  const memo = !opts.migrations;
  const started = Date.now();
  if (memo && knownCurrent && fresh(knownCurrent, CURRENT_TTL_MS, started)) {
    return { ok: true, applied: 0, schemaVersion: knownCurrent.schemaVersion };
  }
  if (lastFailure?.of === bundled && fresh(lastFailure, FAILURE_TTL_MS, started)) return lastFailure.result;

  const deadline = started + (opts.waitMs ?? DEFAULT_WAIT_MS);
  for (;;) {
    let result: SchemaResult | "busy";
    try {
      result = await attempt(db, bundled);
    } catch (error) {
      console.error("[migrate] could not check the schema", error);
      return { ok: false, reason: "failed", error: shortError(error), applied: 0, schemaVersion: 0 };
    }
    if (result !== "busy") {
      if (result.ok) {
        if (memo) knownCurrent = { schemaVersion: result.schemaVersion, at: Date.now() };
        if (lastFailure?.of === bundled) lastFailure = null;
      } else {
        lastFailure = { result, at: Date.now(), of: bundled };
      }
      return result;
    }
    if (Date.now() >= deadline) {
      const { schemaVersion } = await readSchemaState(db).catch(() => ({ schemaVersion: 0 }));
      return { ok: false, reason: "busy", error: "another call is applying migrations", applied: 0, schemaVersion };
    }
    await sleep(opts.pollMs ?? DEFAULT_POLL_MS);
  }
}
