// Migrations must be additive (RELEASING.md, "Database migrations"): during a
// Hosted rollout, and after a rollback, an older OpenPing keeps running on a
// newer schema, so a migration may add tables, columns, indexes and triggers
// but never remove or rename anything, or add a column older code can't insert
// without. scripts/check-migrations.test.mjs runs this over migrations/.

/**
 * The newest migration when the rule was written down. Older ones predate it
 * and were reviewed by hand; every later one is checked.
 */
export const LAST_UNCHECKED_MIGRATION = 20;

/** SQL with comments and quoted text blanked, so a word inside them can't match. */
function stripCommentsAndStrings(sql) {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
}

/** What in one migration's SQL isn't additive, as readable sentences (none: fine). */
export function migrationProblems(sql) {
  const problems = [];
  for (const statement of stripCommentsAndStrings(sql).split(";")) {
    const text = statement.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (/\bDROP\b/i.test(text)) problems.push(`drops something: ${text.slice(0, 120)}`);
    if (/\bRENAME\b/i.test(text)) problems.push(`renames something: ${text.slice(0, 120)}`);
    if (/\bALTER\s+TABLE\b[\s\S]*\bADD\b/i.test(text) && /\bNOT\s+NULL\b/i.test(text) && !/\bDEFAULT\b/i.test(text)) {
      problems.push(`adds a NOT NULL column without a DEFAULT: ${text.slice(0, 120)}`);
    }
  }
  return problems;
}

/** A migration file's number ("0021_x.sql" is 21), or NaN. */
export function migrationNumber(name) {
  return Number(/^(\d+)/.exec(name)?.[1] ?? Number.NaN);
}
