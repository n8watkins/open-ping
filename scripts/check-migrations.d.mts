// Types for check-migrations.mjs, which the platform's release runner also
// imports (platform/src/releases/checks.ts), so both apply one rule.

export declare const LAST_UNCHECKED_MIGRATION: number;
/** What in one migration's SQL isn't additive, as readable sentences (none: fine). */
export declare function migrationProblems(sql: string): string[];
/** A migration file's number ("0021_x.sql" is 21), or NaN. */
export declare function migrationNumber(name: string): number;
