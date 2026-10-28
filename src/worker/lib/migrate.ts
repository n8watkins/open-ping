import { migrations as BUNDLED_MIGRATIONS, version } from "virtual:openping-bundle";

/**
 * Self-migration, for hosted mode only (docs/hosted/CONTRACT.md, section 6).
 *
 * A plain install's migrations run from `npm run deploy` (`wrangler d1
 * migrations apply`), and nothing here ever runs for it. A customer's OpenPing
 * in OpenPing Hosted has nobody to run that, so it carries its migrations in
 * the bundle (scripts/bundle-module.ts) and applies the ones its database is
 * missing at the start of the first call after an update.
 *
 * It keeps Wrangler's own bookkeeping: applied migrations are rows of
 * `d1_migrations`, by file name, so this and `wrangler d1 migrations apply`
 * always agree on what a database has. Each migration and its row go in one
 * batch, which D1 runs as one transaction: a migration is applied whole or not
 * at all, and `d1_migrations.name` is UNIQUE, so it can't be applied twice.
 * A lock row (`d1_migrations_lock`, with a TTL) keeps a second call from even
 * trying while one migrates; that call waits a few seconds for it instead.
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
/** A lock left by a call that died mid-migration frees itself after this. */
export const MIGRATION_LOCK_TTL_MS = 60_000;
const DEFAULT_WAIT_MS = 8_000;
const DEFAULT_POLL_MS = 250;
const ERROR_MAX_LENGTH = 200;

/**
 * Set once this isolate has seen its database carry every bundled migration.
 * A new bundle starts in new isolates, so the first call of each isolate after
 * an update checks again, and every later one costs nothing.
 */
let knownCurrent: { schemaVersion: number } | null = null;

/** Tests only: forget that the schema was seen current. */
export function forgetSchemaCheck(): void {
  knownCurrent = null;
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

/** The schema as the database has it now, for GET /__platform/health. */
export async function readSchemaState(
  db: D1Database,
  now: number = Date.now(),
): Promise<{ schemaVersion: number; migrating: boolean }> {
  const schemaVersion = schemaVersionOf(await appliedNames(db));
  let migrating = false;
  try {
    const row = await db
      .prepare(`SELECT 1 AS held FROM ${LOCK_TABLE} WHERE name = ? AND expires_at > ?`)
      .bind(LOCK_NAME, now)
      .first<{ held: number }>();
    migrating = !!row;
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
  return { schemaVersion, migrating };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One attempt: nothing to do, "busy" (another call holds the lock), or apply
 * every missing migration under the lock.
 */
async function attempt(db: D1Database, bundled: readonly Migration[]): Promise<SchemaResult | "busy"> {
  const before = await appliedNames(db);
  if (bundled.every((m) => before.has(m.name))) {
    return { ok: true, applied: 0, schemaVersion: schemaVersionOf(before) };
  }

  // Create the bookkeeping (Wrangler's own table definition), take the lock,
  // and re-read what is applied, in one round trip.
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
 * Applies the bundled migrations the database is missing (hosted mode only).
 * Answers at once when this isolate already saw the schema current; otherwise
 * it reads the applied migrations (one query), and only when some are missing
 * takes the lock and applies them, oldest first. A call that finds the lock
 * held waits up to `waitMs` for the holder to finish.
 */
export async function ensureSchema(db: D1Database, opts: EnsureSchemaOptions = {}): Promise<SchemaResult> {
  const bundled = opts.migrations ?? BUNDLED_MIGRATIONS;
  if (knownCurrent && !opts.migrations) return { ok: true, applied: 0, schemaVersion: knownCurrent.schemaVersion };
  const deadline = Date.now() + (opts.waitMs ?? DEFAULT_WAIT_MS);
  for (;;) {
    let result: SchemaResult | "busy";
    try {
      result = await attempt(db, bundled);
    } catch (error) {
      console.error("[migrate] could not check the schema", error);
      return { ok: false, reason: "failed", error: shortError(error), applied: 0, schemaVersion: 0 };
    }
    if (result !== "busy") {
      if (result.ok && !opts.migrations) knownCurrent = { schemaVersion: result.schemaVersion };
      return result;
    }
    if (Date.now() >= deadline) {
      const { schemaVersion } = await readSchemaState(db).catch(() => ({ schemaVersion: 0 }));
      return { ok: false, reason: "busy", error: "another call is applying migrations", applied: 0, schemaVersion };
    }
    await sleep(opts.pollMs ?? DEFAULT_POLL_MS);
  }
}
