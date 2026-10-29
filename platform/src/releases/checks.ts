/**
 * What a release must pass before it reaches any tenant (build plan, section
 * 11): its D1 migrations are additive, and neither they nor its Durable
 * Object migrations rewrite anything the tenants already ran.
 *
 * The rule is the repository's own (scripts/check-migrations.mjs, which `npm
 * test` runs over migrations/), applied here to what is actually in R2 and
 * compared with what the tenants run now, so a bundle built from an older
 * checkout, or by hand, can't slip past it.
 */

import { LAST_UNCHECKED_MIGRATION, migrationNumber, migrationProblems } from "../../../scripts/check-migrations.mjs";
import type { BundleD1Migration, BundleMigration, TenantBundle } from "../bundle";

export interface ReleaseChecks {
  /** Empty when the release may go out. Each is one plain sentence. */
  problems: string[];
  /** D1 migrations the tenants don't have yet (rollout) or have and the target lacks (rollback). */
  newMigrations: string[];
  /** Durable Object migration tags the tenants get (rollout). */
  newDurableObjectTags: string[];
}

/** Reads the SQL of one of the release's own migrations. */
export type MigrationSql = (name: string) => Promise<string>;

function sameMigration(a: BundleD1Migration | undefined, b: BundleD1Migration | undefined): boolean {
  return !!a && !!b && a.name === b.name && a.sha256 === b.sha256;
}

function stepsJson(m: BundleMigration): string {
  const { tag: _tag, ...step } = m;
  return JSON.stringify(step, Object.keys(step).sort());
}

/** `before` is where `after` starts: the same entries, in the same order. Returns the first that differs, or null. */
function firstDifference<T>(before: T[], after: T[], same: (a: T | undefined, b: T | undefined) => boolean): number | null {
  for (let i = 0; i < before.length; i++) if (!same(before[i], after[i])) return i;
  return null;
}

/**
 * A rollout from `live` (the bundle tenants run now; null for the first
 * release) to `next`.
 */
export async function checkRollout(next: TenantBundle, live: TenantBundle | null, sql: MigrationSql): Promise<ReleaseChecks> {
  const problems: string[] = [];
  if (next.d1Migrations.length === 0) {
    // Nothing else can be compared without the list.
    return { problems: [`${next.version} doesn't list its D1 migrations; build it with scripts/tenant-release.mjs.`], newMigrations: [], newDurableObjectTags: [] };
  }
  // The ones tenants don't have yet; without a list from the live bundle
  // (or before the first release), the ones the rule covers.
  const covered = next.d1Migrations.filter((m) => migrationNumber(m.name) > LAST_UNCHECKED_MIGRATION);
  const fresh = live?.d1Migrations.length ? next.d1Migrations.slice(live.d1Migrations.length) : covered;
  if (live?.d1Migrations.length) {
    const at = firstDifference(live.d1Migrations, next.d1Migrations, sameMigration);
    if (at !== null) {
      const was = live.d1Migrations[at]!;
      const now = next.d1Migrations[at];
      problems.push(
        now && now.name === was.name
          ? `${was.name} was changed after tenants ran it; add a new migration instead.`
          : `${was.name}, which tenants already ran, is missing or out of order in ${next.version}.`,
      );
    }
  }
  for (const migration of fresh) {
    for (const problem of migrationProblems(await sql(migration.name))) problems.push(`${migration.name} ${problem}`);
  }

  let freshTags = next.migrations.map((m) => m.tag);
  if (live) {
    const at = firstDifference(live.migrations, next.migrations, (a, b) => !!a && !!b && a.tag === b.tag && stepsJson(a) === stepsJson(b));
    if (at !== null) problems.push(`Durable Object migration ${live.migrations[at]!.tag} was changed or removed after tenants ran it.`);
    freshTags = next.migrations.slice(live.migrations.length).map((m) => m.tag);
  }
  return { problems, newMigrations: (live ? fresh : next.d1Migrations).map((m) => m.name), newDurableObjectTags: freshTags };
}

/**
 * A rollback from `live` to the older `target`: the older bundle then runs on
 * the newer schema, which is fine exactly when the newer one only added to it,
 * and its Durable Object migrations can't be undone, so they must match.
 */
export function checkRollback(target: TenantBundle, live: TenantBundle | null): ReleaseChecks {
  const problems: string[] = [];
  let newer: BundleD1Migration[] = [];
  if (live) {
    if (target.d1Migrations.length && live.d1Migrations.length) {
      const at = firstDifference(target.d1Migrations, live.d1Migrations, sameMigration);
      if (at !== null) problems.push(`${target.version}'s migration ${target.d1Migrations[at]!.name} isn't one the tenants ran, so it can't run on their schema.`);
      newer = live.d1Migrations.slice(target.d1Migrations.length);
    }
    const tags = (b: TenantBundle) => b.migrations.map((m) => m.tag).join(",");
    if (tags(target) !== tags(live)) {
      problems.push(
        `${live.version} has Durable Object migrations ${target.version} doesn't, and those can't be undone; ship a fix forward instead.`,
      );
    }
  }
  return { problems, newMigrations: newer.map((m) => m.name), newDurableObjectTags: [] };
}
