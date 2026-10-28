import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";

/**
 * `virtual:openping-bundle`: what the Worker needs to know about its own build,
 * compiled in at build time (src/worker/bundle.d.ts has its types).
 *
 * - `version`: the OpenPing version from package.json.
 * - `migrations`: every file in migrations/, in order, each split into its
 *   statements by Wrangler's own SQL splitter, the one `wrangler d1 migrations
 *   apply` and the integration tests use. In hosted mode the Worker applies the
 *   ones its database is missing (src/worker/lib/migrate.ts), since nobody runs
 *   `wrangler d1 migrations apply` against a customer's database.
 *
 * vite.config.ts and both Vitest configs load this plugin, so the build, the
 * dev server and the tests all see the same module.
 */
export const BUNDLE_MODULE_ID = "virtual:openping-bundle";
const RESOLVED_ID = `\0${BUNDLE_MODULE_ID}`;

/** A migration file's number: the digits it starts with (Wrangler orders by these). */
function migrationNumber(name: string): number {
  return Number(/^(\d+)/.exec(name)?.[1] ?? Number.NaN);
}

export function openpingBundle(root: string = process.cwd()): Plugin {
  const migrationsDir = resolve(root, "migrations");
  const packageJson = resolve(root, "package.json");
  return {
    name: "openping-bundle",
    resolveId(id) {
      return id === BUNDLE_MODULE_ID ? RESOLVED_ID : undefined;
    },
    async load(id) {
      if (id !== RESOLVED_ID) return undefined;
      const { unstable_splitSqlQuery: split } = await import("wrangler");
      const files = readdirSync(migrationsDir)
        .filter((name) => name.endsWith(".sql") && Number.isFinite(migrationNumber(name)))
        .sort((a, b) => migrationNumber(a) - migrationNumber(b) || a.localeCompare(b));
      const migrations = files.map((name) => {
        const path = join(migrationsDir, name);
        this.addWatchFile(path);
        return { name, queries: split(readFileSync(path, "utf8")) };
      });
      this.addWatchFile(packageJson);
      const { version } = JSON.parse(readFileSync(packageJson, "utf8")) as { version: string };
      return [
        `export const version = ${JSON.stringify(version)};`,
        `export const migrations = ${JSON.stringify(migrations)};`,
      ].join("\n");
    },
  };
}
