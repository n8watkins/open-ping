import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { OVERRIDES_PATH, parseJsonc } from "./prod-config.mjs";

// `npm run deploy`: build, apply the D1 migrations, deploy. It is also the
// deploy command the Deploy to Cloudflare button and Workers Builds run
// (docs/INSTALL.md), so it must work unattended on a brand-new account.
//
// Migrations normally run before the Worker is deployed, so new code never
// meets an old schema. On the very first deploy the database may not exist
// yet: wrangler.jsonc carries no database_id, and `wrangler deploy` creates
// the database (Wrangler's automatic provisioning). Then the order flips:
// deploy first, migrate straight after, before anyone can use the install.
//
// OPENPING_WRANGLER_CONFIG names the config to migrate with (deploy:prod sets
// it to the generated .wrangler.prod.jsonc); `wrangler deploy` itself always
// uses the output of `vite build`, which was built from that same config.

export const BINDING = "DB";
const TEMPLATE_PATH = "wrangler.jsonc";

/** The D1 binding the app uses, from a parsed Wrangler config. */
export function databaseBinding(config) {
  const db = (config.d1_databases ?? []).find((entry) => entry.binding === BINDING);
  if (!db) throw new Error(`No D1 binding named "${BINDING}" in the Wrangler config`);
  return db;
}

/** Whether `wrangler d1 list --json` output includes a database with this name. */
export function listIncludes(listJson, name) {
  const start = listJson.indexOf("[");
  if (start === -1) throw new Error("Unexpected `wrangler d1 list --json` output");
  const dbs = JSON.parse(listJson.slice(start));
  return Array.isArray(dbs) && dbs.some((db) => db && db.name === name);
}

/**
 * Returns the ordered commands for one deploy: migrate before deploying when
 * the database exists, after deploying (which creates it) when it doesn't.
 */
export function deploySteps({ configPath, databaseExists }) {
  const migrate = ["wrangler", "d1", "migrations", "apply", BINDING, "--remote", "-c", configPath];
  const build = ["npm", "run", "build"];
  const deploy = ["wrangler", "deploy"];
  return databaseExists ? [build, migrate, deploy] : [build, deploy, migrate];
}

/**
 * Refuses a plain deploy from a checkout that keeps its own settings in
 * deploy.local.json: that deploy would drop those settings (the canonical
 * install's landing page and waitlist), so it must go through deploy:prod.
 */
export function guardPlainDeploy({ configPath, hasOverrides }) {
  if (configPath === TEMPLATE_PATH && hasOverrides) {
    throw new Error(
      `${OVERRIDES_PATH} exists, so this install has its own settings: run \`npm run deploy:prod\`, ` +
        "not `npm run deploy`, or they would be replaced by wrangler.jsonc's defaults.",
    );
  }
}

function run(command) {
  const [bin, ...args] = command;
  const exe = bin === "wrangler" ? "npx" : bin;
  const argv = bin === "wrangler" ? ["wrangler", ...args] : args;
  console.log(`\n> ${command.join(" ")}`);
  const result = spawnSync(exe, argv, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function databaseExists(configPath) {
  const db = databaseBinding(parseJsonc(readFileSync(configPath, "utf8")));
  if (db.database_id) return true;
  const result = spawnSync("npx", ["wrangler", "d1", "list", "--json", "-c", configPath], {
    stdio: ["inherit", "pipe", "inherit"],
    encoding: "utf8",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  return listIncludes(result.stdout, db.database_name);
}

function main() {
  const configPath = process.env.OPENPING_WRANGLER_CONFIG || TEMPLATE_PATH;
  guardPlainDeploy({ configPath, hasOverrides: existsSync(OVERRIDES_PATH) });
  const exists = databaseExists(configPath);
  if (!exists) console.log("The D1 database does not exist yet: deploying first creates it, then migrating.");
  for (const step of deploySteps({ configPath, databaseExists: exists })) run(step);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
