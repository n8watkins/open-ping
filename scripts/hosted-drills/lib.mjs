// What the OpenPing Hosted launch drills share (docs/hosted/LAUNCH_DRILLS.md):
// the staging guard, the remote commands they print and run, and parsing
// what Wrangler answers.
//
// Every remote step is a command object: its argv (or an HTTP request), what
// it is for, and whether it changes anything. The drills hand each one to an
// executor that prints it first and then, depending on the mode, runs it:
//
//   live      runs every command
//   dry-run   runs the read-only ones, prints the writes without running them
//   print     runs nothing
//
// No secret is ever part of a command: SQL that carries ciphertext goes in a
// file, and PLATFORM_KEY is read from the environment, used in memory, and
// never printed or written.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "../prod-config.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Where the drills keep their state, reports and downloads (gitignored). */
export const STATE_DIR = ".hosted-drills";

export class DrillError extends Error {}

// --- Arguments -------------------------------------------------------------------

/** `--name value`, `--name=value` and the boolean flags named in `booleans`. */
export function parseArgs(argv, booleans = []) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (booleans.includes(name)) flags[name] = true;
    else if (eq !== -1) flags[name] = arg.slice(eq + 1);
    else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new DrillError(`--${name} needs a value`);
      flags[name] = value;
      i++;
    }
  }
  return { positional, flags };
}

/** "60m", "90s", "2h", "1500ms" or a bare number of seconds, as milliseconds. */
export function parseDuration(text, what = "duration") {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(text ?? "").trim());
  if (!m) throw new DrillError(`${what} must look like 60m, 90s or 2h`);
  const n = Number(m[1]);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? "s"];
  return Math.round(n * unit);
}

export function parsePositiveInt(text, what, { max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new DrillError(`${what} must be a whole number from 1 to ${max}`);
  return n;
}

/** The mode from --print and --dry-run. */
export function modeOf(flags) {
  if (flags.print) return "print";
  if (flags["dry-run"]) return "dry-run";
  return "live";
}

// --- The staging guard -------------------------------------------------------------

const STAGING_SUFFIX = "-staging";

/** Every Cloudflare resource name a platform config names, with where it came from. */
export function resourceNames(config) {
  const names = [];
  const add = (where, value) => {
    if (typeof value === "string" && value !== "") names.push({ where, value });
  };
  add("name", config.name);
  for (const [i, d] of (config.d1_databases ?? []).entries()) add(`d1_databases[${i}].database_name`, d.database_name);
  for (const [i, d] of (config.dispatch_namespaces ?? []).entries()) add(`dispatch_namespaces[${i}].namespace`, d.namespace);
  for (const [i, b] of (config.r2_buckets ?? []).entries()) add(`r2_buckets[${i}].bucket_name`, b.bucket_name);
  for (const [i, q] of (config.queues?.producers ?? []).entries()) add(`queues.producers[${i}].queue`, q.queue);
  for (const [i, q] of (config.queues?.consumers ?? []).entries()) add(`queues.consumers[${i}].queue`, q.queue);
  add("vars.DISPATCH_NAMESPACE", config.vars?.DISPATCH_NAMESPACE);
  return names;
}

/**
 * Why this run must not touch `config`, or [] when it may. The drills only
 * ever run against staging: `--env staging`, a platform config whose every
 * resource is named `...-staging`, a Hosted domain with a `staging` label,
 * and, for a run that changes anything, `--confirm` repeating the config's
 * Worker name, so a production config can't be used by a slip of the
 * keyboard or a copied command line.
 */
export function stagingProblems(config, { env, confirm, writes }) {
  const problems = [];
  if (env !== "staging") problems.push(`--env must be staging (got ${env === undefined ? "nothing" : JSON.stringify(env)}); the drills never run anywhere else`);
  if (!config || typeof config !== "object") return [...problems, "no platform config"];
  for (const { where, value } of resourceNames(config)) {
    if (!value.endsWith(STAGING_SUFFIX)) problems.push(`${where} is ${value}, which isn't a staging name (...${STAGING_SUFFIX})`);
  }
  if (!(config.d1_databases ?? []).some((d) => d.binding === "PLATFORM_DB")) problems.push("the config binds no PLATFORM_DB");
  const domain = config.vars?.HOSTED_DOMAIN;
  if (typeof domain !== "string" || !domain.split(".").some((label) => /(^|-)staging($|-)/.test(label)) || domain.endsWith(".invalid")) {
    problems.push(`vars.HOSTED_DOMAIN is ${JSON.stringify(domain ?? null)}, not a staging domain (one of its labels must be staging, as in staging.<domain>)`);
  }
  if (writes && confirm !== config.name) {
    problems.push(`a run that changes anything needs --confirm ${config.name ?? "<the config's name>"} (got ${confirm === undefined ? "nothing" : JSON.stringify(confirm)})`);
  }
  return problems;
}

export function assertStaging(config, options) {
  const problems = stagingProblems(config, options);
  if (problems.length) throw new DrillError(`Refusing to run:\n  - ${problems.join("\n  - ")}`);
}

/** Reads and parses a wrangler config (JSONC). */
export function readConfig(path) {
  if (!path) throw new DrillError("--config <the staging platform config> is required");
  let text;
  try {
    text = readFileSync(resolve(ROOT, path), "utf8");
  } catch {
    throw new DrillError(`can't read ${path}`);
  }
  try {
    return parseJsonc(text);
  } catch (error) {
    throw new DrillError(`${path} isn't valid JSONC: ${error.message}`);
  }
}

/** The platform database's name and the exports bucket, from the config. */
export function platformResources(config) {
  const db = (config.d1_databases ?? []).find((d) => d.binding === "PLATFORM_DB");
  const exportsBucket = (config.r2_buckets ?? []).find((b) => b.binding === "EXPORTS");
  const domain = config.vars?.HOSTED_DOMAIN ?? "";
  return { database: db?.database_name ?? null, exportsBucket: exportsBucket?.bucket_name ?? null, domain, appOrigin: `https://app.${domain}` };
}

// --- Commands --------------------------------------------------------------------------

/** A shell rendering of argv, quoted where needed, for printing. */
export function show(argv) {
  return argv.map((part) => (/^[\w./:=@+,-]+$/.test(part) ? part : `'${String(part).replace(/'/g, "'\\''")}'`)).join(" ");
}

export { sqlValue, sqlList } from "./sql.mjs";

const wranglerConfig = (ctx) => (ctx.configPath ? ["--config", ctx.configPath] : []);

/** `wrangler d1 execute <db> --remote --command <sql> --json`. */
export function d1Query(ctx, database, sql, { write = false, what }) {
  return { kind: "run", argv: ["npx", "wrangler", "d1", "execute", database, "--remote", ...wranglerConfig(ctx), "--command", sql, "--json", ...(write ? ["--yes"] : [])], write, what, json: true };
}

/** `wrangler d1 execute <db> --remote --file <file> --yes`. */
export function d1File(ctx, database, file, { what }) {
  return { kind: "run", argv: ["npx", "wrangler", "d1", "execute", database, "--remote", ...wranglerConfig(ctx), "--file", file, "--yes", "--json"], write: true, what, json: true };
}

export function d1Info(ctx, database, { what }) {
  return { kind: "run", argv: ["npx", "wrangler", "d1", "info", database, ...wranglerConfig(ctx), "--json"], write: false, what, json: true, allowFailure: true };
}

export function d1Create(ctx, database, { what }) {
  return { kind: "run", argv: ["npx", "wrangler", "d1", "create", database, ...wranglerConfig(ctx)], write: true, what };
}

export function d1Delete(ctx, database, { what }) {
  return { kind: "run", argv: ["npx", "wrangler", "d1", "delete", database, ...wranglerConfig(ctx), "--skip-confirmation"], write: true, what };
}

export function r2Get(ctx, bucket, key, file, { what }) {
  return { kind: "run", argv: ["npx", "wrangler", "r2", "object", "get", `${bucket}/${key}`, "--file", file, "--remote", ...wranglerConfig(ctx)], write: false, what };
}

/** An HTTPS request the drill makes itself (the health endpoint, Cloudflare's GraphQL API). */
export function httpRequest(url, { method = "GET", body, headers = {}, what, secretHeaders = [] }) {
  return { kind: "http", url, method, body, headers, secretHeaders, write: false, what };
}

// --- Running them ------------------------------------------------------------------------

/** Runs a command and answers its output (the drills always capture). */
export function defaultRunner(argv, { env } = {}) {
  const [cmd, ...args] = argv;
  const result = spawnSync(cmd, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env: env ?? process.env, maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * The executor every drill step goes through. Answers the command's output
 * (parsed when it is JSON), or null when the mode didn't run it. Records
 * every command it was given, run or not, for --print and the tests.
 */
export function makeExecutor({ mode, run = defaultRunner, fetch: fetcher = globalThis.fetch, log = console.log, commands = [] }) {
  const exec = async (cmd) => {
    commands.push(cmd);
    const label = cmd.write ? "change" : "read";
    if (cmd.kind === "http") {
      const shown = Object.entries(cmd.headers).map(([k, v]) => `-H '${k}: ${cmd.secretHeaders.includes(k) ? "<redacted>" : v}'`);
      log(`$ curl -X ${cmd.method}${shown.length ? ` ${shown.join(" ")}` : ""}${cmd.body ? " --data <json>" : ""} ${cmd.url}   # ${label}: ${cmd.what}`);
    } else {
      log(`$ ${show(cmd.argv)}   # ${label}: ${cmd.what}`);
    }
    if (mode === "print" || (mode === "dry-run" && cmd.write)) return null;
    if (cmd.kind === "http") {
      const res = await fetcher(cmd.url, { method: cmd.method, headers: cmd.headers, body: cmd.body });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, json, text };
    }
    const result = run(cmd.argv);
    if (result.status !== 0) {
      if (cmd.allowFailure) return { failed: true, stdout: result.stdout, stderr: result.stderr };
      throw new DrillError(`${cmd.what} failed:\n${(result.stderr || result.stdout).trim().slice(0, 2000)}`);
    }
    return cmd.json ? parseWranglerJson(result.stdout) : result.stdout;
  };
  exec.commands = commands;
  exec.mode = mode;
  /** True when this executor runs read-only commands (live and dry-run). */
  exec.reads = mode !== "print";
  /** True when it runs the ones that change things (live only). */
  exec.writes = mode === "live";
  return exec;
}

/** Wrangler's --json output: the first JSON value in stdout (it may print a banner first). */
export function parseWranglerJson(stdout) {
  const start = stdout.search(/[[{]/);
  if (start === -1) throw new DrillError(`wrangler gave no JSON:\n${stdout.slice(0, 500)}`);
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    throw new DrillError(`wrangler's JSON didn't parse:\n${stdout.slice(0, 500)}`);
  }
}

/** The rows of each statement of a `d1 execute --json` answer. */
export function d1Results(parsed) {
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map((r) => r?.results ?? []);
}

/** The rows of the first (or only) statement. */
export const d1Rows = (parsed) => d1Results(parsed)[0] ?? [];

/** The database id `wrangler d1 info --json` reports. */
export function d1InfoId(parsed) {
  return parsed?.uuid ?? parsed?.database_id ?? parsed?.id ?? null;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Polls `check` (which answers a value when done, or undefined to keep
 * waiting) every `everyMs` until `timeoutMs` has passed.
 */
export async function waitFor(check, { everyMs, timeoutMs, what, now = Date.now, wait = sleep, log = console.log }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (now() >= deadline) throw new DrillError(`timed out after ${Math.round(timeoutMs / 1000)} seconds waiting for ${what}`);
    log(`  ... waiting for ${what}`);
    await wait(everyMs);
  }
}

// --- Small things --------------------------------------------------------------------------

export async function sha256Hex(data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** `length` characters of [a-z0-9], uniformly random (the platform's newTenantId alphabet). */
export function randomId(length) {
  let out = "";
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      if (byte < 252 && out.length < length) out += ID_ALPHABET[byte % 36];
    }
  }
  return out;
}

/** A timestamp for file names: 20261101T120000Z. */
export const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
