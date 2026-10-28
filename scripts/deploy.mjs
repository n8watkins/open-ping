import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
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
// Before any of that, it compares the vars the Worker runs with now against
// the ones this deploy would set, and stops if they differ, unless you confirm
// (or set OPENPING_ALLOW_VAR_CHANGES=1). Without that check, a plain deploy
// from a fresh clone, signed in to an account whose Worker keeps different
// vars, would silently replace them; it happened once to the canonical
// install's landing page. Workers Builds (the button's installs) skips it:
// there the repository is the source of truth.
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

/** Plain-text vars of a version, from `wrangler versions view --json`. */
export function versionVars(versionJson) {
  const version = JSON.parse(versionJson.slice(versionJson.indexOf("{")));
  const bindings = version?.resources?.bindings ?? [];
  return Object.fromEntries(
    bindings.filter((b) => b.type === "plain_text").map((b) => [b.name, b.text]),
  );
}

/** The version serving most traffic, from `wrangler deployments status --json`. */
export function servingVersion(statusJson) {
  const status = JSON.parse(statusJson.slice(statusJson.indexOf("{")));
  const versions = [...(status?.versions ?? [])].sort((a, b) => b.percentage - a.percentage);
  return versions[0]?.version_id ?? null;
}

/** Every var whose live value this deploy would change or remove. */
export function varChanges(live, planned) {
  return Object.entries(live)
    .filter(([name, value]) => planned[name] !== value)
    .map(([name, from]) => ({ name, from, to: planned[name] }));
}

export function describeChanges(workerName, changes) {
  const lines = changes.map(
    ({ name, from, to }) => `  ${name}: "${from}" -> ${to === undefined ? "(removed)" : `"${to}"`}`,
  );
  return `This deploy would change vars the live Worker "${workerName}" runs with:\n${lines.join("\n")}`;
}

function wranglerJson(args) {
  const result = spawnSync("npx", ["wrangler", ...args], {
    stdio: ["inherit", "pipe", "pipe"],
    encoding: "utf8",
  });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** The live Worker's vars, or null when the Worker doesn't exist yet. */
function liveVars(workerName) {
  const status = wranglerJson(["deployments", "status", "--name", workerName, "--json"]);
  if (!status.ok) {
    // 10007: "This Worker does not exist on your account", a first install.
    if (/\b10007\b/.test(status.stdout + status.stderr)) return null;
    process.stderr.write(status.stderr);
    throw new Error("Could not read the live Worker's deployment, so the deploy stopped.");
  }
  const versionId = servingVersion(status.stdout);
  if (!versionId) return null;
  const version = wranglerJson(["versions", "view", versionId, "--name", workerName, "--json"]);
  if (!version.ok) {
    process.stderr.write(version.stderr);
    throw new Error("Could not read the live Worker's vars, so the deploy stopped.");
  }
  return versionVars(version.stdout);
}

async function guardVarChanges(config) {
  if (process.env.WORKERS_CI === "1" || process.env.OPENPING_ALLOW_VAR_CHANGES === "1") return;
  const live = liveVars(config.name);
  if (!live) return;
  const changes = varChanges(live, config.vars ?? {});
  if (changes.length === 0) return;
  const message = describeChanges(config.name, changes);
  const hint =
    `If this checkout should keep the live values, put them in ${OVERRIDES_PATH} and run ` +
    "`npm run deploy:prod`, or edit wrangler.jsonc.";
  if (!process.stdin.isTTY) {
    throw new Error(`${message}\n${hint}\nTo deploy anyway, set OPENPING_ALLOW_VAR_CHANGES=1.`);
  }
  console.log(`${message}\n${hint}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("Deploy anyway and change them? (y/N) ");
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) throw new Error("Deploy cancelled; nothing changed.");
}

function run(command) {
  const [bin, ...args] = command;
  const exe = bin === "wrangler" ? "npx" : bin;
  const argv = bin === "wrangler" ? ["wrangler", ...args] : args;
  console.log(`\n> ${command.join(" ")}`);
  const result = spawnSync(exe, argv, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function databaseExists(config) {
  const db = databaseBinding(config);
  if (db.database_id) return true;
  const list = wranglerJson(["d1", "list", "--json"]);
  if (!list.ok) {
    process.stderr.write(list.stderr);
    throw new Error("Could not list your D1 databases, so the deploy stopped.");
  }
  return listIncludes(list.stdout, db.database_name);
}

async function main() {
  const configPath = process.env.OPENPING_WRANGLER_CONFIG || TEMPLATE_PATH;
  guardPlainDeploy({ configPath, hasOverrides: existsSync(OVERRIDES_PATH) });
  const config = parseJsonc(readFileSync(configPath, "utf8"));
  await guardVarChanges(config);
  const exists = databaseExists(config);
  if (!exists) console.log("The D1 database does not exist yet: deploying first creates it, then migrating.");
  for (const step of deploySteps({ configPath, databaseExists: exists })) run(step);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
