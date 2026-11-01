/**
 * Single use for the platform's signed calls in starter mode
 * (docs/hosted/CONTRACT.md, section 10; migration 0028). Called only after a
 * call's signature and timestamp have verified, so nothing unsigned ever
 * reaches the table.
 */

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS used_platform_call_nonces (
  nonce      TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
)`;
const CREATE_INDEX =
  "CREATE INDEX IF NOT EXISTS idx_used_platform_call_nonces_expires ON used_platform_call_nonces(expires_at)";

async function record(db: D1Database, nonce: string, expiresAt: number, now: number): Promise<boolean> {
  // One round trip: the expired rows go, then the new one goes in. The
  // primary key lets exactly one insert of a nonce happen, so two requests
  // racing with the same call can't both win.
  const [, inserted] = await db.batch([
    db.prepare("DELETE FROM used_platform_call_nonces WHERE expires_at <= ?").bind(now),
    db.prepare("INSERT INTO used_platform_call_nonces (nonce, expires_at) VALUES (?, ?) ON CONFLICT(nonce) DO NOTHING").bind(nonce, expiresAt),
  ]);
  return inserted?.meta.changes === 1;
}

/**
 * Records `nonce` as used until `expiresAt` (epoch ms). True when this call
 * recorded it; false when it was already there (a replay). The first platform
 * call after an upload can come before the tenant has applied migration 0028
 * (it applies its migrations during that very call), so a missing table is
 * created here with the migration's own statements, and the insert tried
 * once more.
 */
export async function recordPlatformCallNonce(db: D1Database, nonce: string, expiresAt: number, now: number = Date.now()): Promise<boolean> {
  try {
    return await record(db, nonce, expiresAt, now);
  } catch (error) {
    if (!/no such table/i.test(error instanceof Error ? error.message : String(error))) throw error;
    await db.batch([db.prepare(CREATE_TABLE), db.prepare(CREATE_INDEX)]);
    return record(db, nonce, expiresAt, now);
  }
}
