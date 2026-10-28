import type { Env } from "../types";

/** One statement of a {@link batchEach} call, named for its log line. */
export interface LabeledStatement {
  label: string;
  stmt: D1PreparedStatement;
}

/**
 * Run independent statements in one D1 round trip, without letting one bad
 * statement take the others down with it.
 *
 * A `db.batch()` is a single round trip, which matters for the cron run: it
 * often runs far from the database, where a round trip measured about 160 ms
 * (docs/FREE_TIER.md). But a batch is also one transaction, so a single failing
 * statement rolls back the rest. If the batch fails, each statement is retried
 * on its own and only the ones that still fail are logged and skipped, so the
 * common case costs one round trip and the failure case keeps the per-statement
 * isolation the separate queries had.
 *
 * Returns each statement's result in order, or null for one that failed.
 */
export async function batchEach(
  env: Env,
  scope: string,
  statements: LabeledStatement[],
): Promise<(D1Result | null)[]> {
  if (statements.length === 0) return [];
  try {
    return await env.DB.batch(statements.map((s) => s.stmt));
  } catch (e) {
    console.error(`[${scope}] batch failed; retrying its statements one by one`, e);
  }
  const results: (D1Result | null)[] = [];
  for (const { label, stmt } of statements) {
    try {
      results.push(await stmt.all());
    } catch (e) {
      console.error(`[${scope}] ${label} failed`, e);
      results.push(null);
    }
  }
  return results;
}
