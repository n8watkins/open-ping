import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LAST_UNCHECKED_MIGRATION, migrationNumber, migrationProblems } from "./check-migrations.mjs";

const DIR = new URL("../migrations/", import.meta.url);

describe("migrationProblems", () => {
  it("accepts additive changes", () => {
    expect(
      migrationProblems(`
        -- A comment may say DROP or RENAME.
        CREATE TABLE things (id TEXT PRIMARY KEY, name TEXT NOT NULL);
        ALTER TABLE monitors ADD COLUMN note TEXT;
        ALTER TABLE monitors ADD COLUMN level INTEGER NOT NULL DEFAULT 0;
        CREATE INDEX idx_things_name ON things(name);
        INSERT INTO settings (key, value) VALUES ('x', 'drop me');
      `),
    ).toEqual([]);
  });

  it("refuses a drop, a rename, and a NOT NULL column without a default", () => {
    expect(migrationProblems("DROP TABLE things;")).toHaveLength(1);
    expect(migrationProblems("ALTER TABLE things DROP COLUMN name;")).toHaveLength(1);
    expect(migrationProblems("ALTER TABLE things RENAME TO stuff;")).toHaveLength(1);
    expect(migrationProblems("ALTER TABLE things RENAME COLUMN a TO b;")).toHaveLength(1);
    expect(migrationProblems("ALTER TABLE things ADD COLUMN level INTEGER NOT NULL;")).toHaveLength(1);
  });
});

describe("the migrations", () => {
  const files = readdirSync(DIR).filter((name) => name.endsWith(".sql"));

  it(`are all additive after ${LAST_UNCHECKED_MIGRATION} (RELEASING.md, "Database migrations")`, () => {
    const checked = files.filter((name) => migrationNumber(name) > LAST_UNCHECKED_MIGRATION);
    const problems = checked.flatMap((name) =>
      migrationProblems(readFileSync(new URL(name, DIR), "utf8")).map((p) => `${name} ${p}`),
    );
    expect(problems).toEqual([]);
  });

  it("are numbered without gaps or duplicates", () => {
    const numbers = files.map(migrationNumber).sort((a, b) => a - b);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });
});
