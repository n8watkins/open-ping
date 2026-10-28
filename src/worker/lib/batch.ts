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
  /** Asked before each one-by-one retry; once false the rest are skipped (lib/budget.ts). */
  opts: { canSpend?: () => boolean } = {},
): Promise<(D1Result | null)[]> {
  if (statements.length === 0) return [];
  try {
    return await env.DB.batch(statements.map((s) => s.stmt));
  } catch (e) {
    console.error(`[${scope}] batch failed; retrying its statements one by one`, e);
  }
  const results: (D1Result | null)[] = [];
  for (const { label, stmt } of statements) {
    if (opts.canSpend && !opts.canSpend()) {
      console.error(`[${scope}] ${label} skipped: out of D1 budget`);
      results.push(null);
      continue;
    }
    try {
      results.push(await stmt.all());
    } catch (e) {
      console.error(`[${scope}] ${label} failed`, e);
      results.push(null);
    }
  }
  return results;
}

/** Statements that must land together or not at all (one transaction). */
export interface WriteUnit {
  label: string;
  statements: D1PreparedStatement[];
}

/**
 * One monitor's writes for a run, grouped by how they may fail.
 *
 * - `core` must land as one: a monitor's state, its sample and any incident it
 *   opens or resolves, so the state's incident pointer never disagrees with
 *   the incidents table.
 * - `afterCore` only makes sense once `core` landed (the alert for the incident
 *   it opened); each unit is atomic, and they are independent of each other.
 * - `fallbacks`, when `core` can't land, are smaller atomic sets tried in turn
 *   until one lands (the state and sample without the incident change, then
 *   the state alone), so one bad incident or sample write can't stop the check
 *   from being recorded.
 * - `extras` are independent of `core` and of each other (the hourly rollup, the
 *   status interval), and each unit is atomic.
 */
export interface WriteGroup {
  label: string;
  core: WriteUnit;
  afterCore?: WriteUnit[];
  fallbacks?: WriteUnit[];
  extras?: WriteUnit[];
}

/** How much of a group landed: everything, its core without some of the rest, a fallback, or nothing. */
export type GroupOutcome = "all" | "partial" | "fallback" | "none";

export interface WritePlanResult {
  /** Per group, in order. */
  groups: GroupOutcome[];
  /** The tail statements' results in order, null for one that failed. */
  tail: (D1Result | null)[];
}

/** Most statements one D1 batch carries; a bigger plan is split (each part is still one round trip). */
export const MAX_BATCH_STATEMENTS = 500;

const unitsOf = (g: WriteGroup): WriteUnit[] => [g.core, ...(g.afterCore ?? []), ...(g.extras ?? [])];
const statementsOf = (g: WriteGroup): D1PreparedStatement[] => unitsOf(g).flatMap((u) => u.statements);

/**
 * Write a run's groups, then its tail (independent statements whose results the
 * caller reads, such as the outbox claim), in as few round trips as possible.
 *
 * The common case is one round trip: every group and the tail in one batch, in
 * order, so the tail sees what the groups wrote. A batch is one transaction, so
 * if it fails nothing was written and the work is retried in smaller pieces:
 * the groups alone, then each group on its own, then a failing group's core
 * and each of its other units separately (or its fallbacks when the core
 * itself fails), and the tail through {@link batchEach}. One bad statement
 * therefore costs only its own unit.
 *
 * `canSpend` is asked before every retry round trip (a run has a fixed D1
 * allowance, lib/budget.ts); once it says no, the remaining retries are
 * skipped and logged, and what they would have written counts as not landed.
 */
export async function runWritePlan(
  env: Env,
  scope: string,
  groups: WriteGroup[],
  tail: LabeledStatement[] = [],
  opts: { canSpend?: () => boolean } = {},
): Promise<WritePlanResult> {
  const canSpend = opts.canSpend ?? (() => true);
  const outcomes: GroupOutcome[] = groups.map(() => "none");
  const groupStatements = groups.map(statementsOf);
  const total = groupStatements.reduce((n, s) => n + s.length, 0) + tail.length;

  if (total === 0) return { groups: outcomes, tail: [] };
  // Nothing but the tail (a run that checked nothing): its own retry rules.
  if (groups.length === 0) return { groups: outcomes, tail: await batchEach(env, scope, tail, { canSpend }) };

  // The fast path: everything in one batch (or a few, for a very large run).
  if (total <= MAX_BATCH_STATEMENTS) {
    try {
      const results = await env.DB.batch([...groupStatements.flat(), ...tail.map((t) => t.stmt)]);
      return { groups: outcomes.fill("all"), tail: results.slice(total - tail.length) };
    } catch (e) {
      console.error(`[${scope}] batch of ${total} statements failed; retrying in parts`, e);
    }
    if (tail.length > 0 && groups.length > 0) {
      if (!canSpend()) return skipped(scope, groups, tail);
      try {
        await env.DB.batch(groupStatements.flat());
        outcomes.fill("all");
        return { groups: outcomes, tail: await batchEach(env, scope, tail, { canSpend }) };
      } catch (e) {
        console.error(`[${scope}] the run's writes failed together; retrying each monitor's`, e);
      }
    }
  } else {
    // Too big for one batch: chunks of whole groups, each one round trip.
    const chunks: number[][] = [[]];
    let size = 0;
    groupStatements.forEach((s, i) => {
      if (size + s.length > MAX_BATCH_STATEMENTS && chunks.at(-1)!.length > 0) {
        chunks.push([]);
        size = 0;
      }
      chunks.at(-1)!.push(i);
      size += s.length;
    });
    for (const chunk of chunks) {
      if (!canSpend()) break;
      try {
        await env.DB.batch(chunk.flatMap((i) => groupStatements[i]!));
        for (const i of chunk) outcomes[i] = "all";
      } catch (e) {
        console.error(`[${scope}] a batch of ${chunk.length} monitors' writes failed; retrying each`, e);
      }
    }
  }

  for (let i = 0; i < groups.length; i++) {
    if (outcomes[i] !== "none") continue;
    outcomes[i] = await writeGroupAlone(env, scope, groups[i]!, canSpend);
  }
  return { groups: outcomes, tail: await batchEach(env, scope, tail, { canSpend }) };
}

function skipped(scope: string, groups: WriteGroup[], tail: LabeledStatement[]): WritePlanResult {
  console.error(`[${scope}] out of D1 budget; ${groups.length} monitors' writes wait for the next run`);
  return { groups: groups.map(() => "none"), tail: tail.map(() => null) };
}

async function runUnit(env: Env, scope: string, unit: WriteUnit, canSpend: () => boolean): Promise<boolean> {
  if (unit.statements.length === 0) return true;
  if (!canSpend()) {
    console.error(`[${scope}] ${unit.label} skipped: out of D1 budget`);
    return false;
  }
  try {
    await env.DB.batch(unit.statements);
    return true;
  } catch (e) {
    console.error(`[${scope}] ${unit.label} failed`, e);
    return false;
  }
}

/** One group on its own: whole, else core then the rest one by one, else a fallback. */
async function writeGroupAlone(
  env: Env,
  scope: string,
  group: WriteGroup,
  canSpend: () => boolean,
): Promise<GroupOutcome> {
  if (await runUnit(env, scope, { label: group.label, statements: statementsOf(group) }, canSpend)) {
    return "all";
  }
  const extras = async () => {
    let all = true;
    for (const unit of group.extras ?? []) all = (await runUnit(env, scope, unit, canSpend)) && all;
    return all;
  };
  if (await runUnit(env, scope, group.core, canSpend)) {
    let all = true;
    for (const unit of group.afterCore ?? []) all = (await runUnit(env, scope, unit, canSpend)) && all;
    return (await extras()) && all ? "all" : "partial";
  }
  for (const fallback of group.fallbacks ?? []) {
    if (await runUnit(env, scope, fallback, canSpend)) {
      await extras();
      return "fallback";
    }
  }
  return "none";
}
