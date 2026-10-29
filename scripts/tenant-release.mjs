#!/usr/bin/env node
// `npm run tenant-release -- <command>`: ships an OpenPing release to OpenPing
// Hosted (docs/HOSTED_BUILD_PLAN.md, C1; RELEASING.md, "OpenPing Hosted").
//
//   build                 builds OpenPing from wrangler.jsonc and writes the
//                         tenant bundle to .tenant-bundle/releases/<version>/,
//                         refusing migrations that aren't additive
//   upload                puts that bundle in the R2 bucket, bundle.json last,
//                         and refuses to replace a different bundle of the
//                         same version
//   start <version>       asks the platform to roll it out (canary, then
//                         batches of 50); --dry-run only plans it
//   rollback              asks the platform to go back to the version before
//                         (--to <version> for another), --dry-run to plan
//   pause | resume | skip-failed | cancel
//                         changes the release in progress
//   status                shows the latest releases and their progress
//
// The platform does the rollout itself (platform/src/releases/runner.ts): the
// commands that ask for something only add a row to its release_requests
// table with `wrangler d1 execute`, which its every-minute cron picks up. So
// nothing here needs more than the owner's Cloudflare login, and the admin
// console shows the same progress.
//
// Every remote command is printed before it runs; --print prints them and
// runs nothing. Agents never run this against a real account: the owner (or
// the main session, with the owner) does.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LAST_UNCHECKED_MIGRATION, migrationNumber, migrationProblems } from "./check-migrations.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULTS = {
  out: ".tenant-bundle",
  bucket: "openping-tenant-bundles",
  database: "openping-platform",
  config: "platform/wrangler.jsonc",
};

/** Written next to the build by `build`: the commit dist/ was built from. */
export const BUILD_MARKER = "dist/.tenant-release-commit";

/** The same pattern the platform accepts (platform/src/bundle.ts, VERSION_PATTERN). */
export const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const SLUG_PATTERN = /^[a-z0-9-]{1,63}$/;
/** Cloudflare's limit on one static asset. */
const MAX_ASSET_BYTES = 25 * 1024 * 1024;

export class ReleaseError extends Error {}

export function isVersion(value) {
  return typeof value === "string" && VERSION_PATTERN.test(value) && !value.includes("..");
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// --- The worker config ---------------------------------------------------------

const MIGRATION_STEP_KEYS = ["new_sqlite_classes", "new_classes", "renamed_classes", "deleted_classes", "transferred_classes"];

/**
 * The bundle's worker config from the build's wrangler.json, the same rules as
 * the platform's workerConfigFromWrangler (platform/src/bundle.ts; a test
 * keeps the two equal): only what a user Worker in the namespace can carry.
 */
export function workerConfig(config) {
  const str = (v, what) => {
    if (typeof v !== "string" || !v) throw new ReleaseError(`wrangler config: ${what} must be a string`);
    return v;
  };
  const assets = config.assets ?? {};
  const assetsConfig = {};
  for (const key of ["html_handling", "not_found_handling", "run_worker_first"]) if (assets[key] !== undefined) assetsConfig[key] = assets[key];
  const vars = {};
  for (const [name, value] of Object.entries(config.vars ?? {})) vars[name] = typeof value === "string" ? value : JSON.stringify(value);
  const durableObjects = (config.durable_objects?.bindings ?? []).map((b, i) => {
    if (b.script_name !== undefined) throw new ReleaseError(`wrangler config: durable_objects.bindings[${i}] points at another script`);
    return { name: str(b.name, `durable_objects.bindings[${i}].name`), className: str(b.class_name, `durable_objects.bindings[${i}].class_name`) };
  });
  const migrations = (config.migrations ?? []).map((m, i) => {
    const out = { tag: str(m.tag, `migrations[${i}].tag`) };
    for (const key of MIGRATION_STEP_KEYS) if (m[key] !== undefined) out[key] = m[key];
    return out;
  });
  return {
    compatibilityDate: str(config.compatibility_date, "compatibility_date"),
    compatibilityFlags: Array.isArray(config.compatibility_flags) ? config.compatibility_flags.map(String) : [],
    assetsConfig,
    vars,
    durableObjects,
    migrations,
  };
}

// --- Files -----------------------------------------------------------------------

const CONTENT_TYPES = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  webmanifest: "application/manifest+json",
  map: "application/json",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  wasm: "application/wasm",
  pdf: "application/pdf",
};

export function contentTypeOf(path) {
  const ext = basename(path).includes(".") ? basename(path).split(".").pop().toLowerCase() : "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile()) out.push(path);
  }
  return out.sort();
}

const toPosix = (p) => p.split(sep).join("/");

/** A .assetsignore line as a test of a path relative to the assets root ("index.html", "assets/x.js"). */
function ignoreRule(line) {
  const anchored = line.startsWith("/");
  const pattern = line.replace(/^\//, "").replace(/\/$/, "");
  const regex = new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}(/.*)?$`);
  return (rel) => regex.test(rel) || (!anchored && !pattern.includes("/") && rel.split("/").some((part) => regex.test(part)));
}

/** Files that must never leave the machine, whatever an ignore file says. */
const NEVER = (rel) => /(^|\/)\.dev\.vars/.test(rel) || /(^|\/)\.op-token$/.test(rel) || /(^|\/)\.env(\.|$)/.test(rel);

/**
 * The static assets: every file of the client build except the ones Wrangler
 * leaves out (`.assetsignore`, `_headers`, `_redirects`, and what
 * .assetsignore lists), with `_headers` and `_redirects` carried as config.
 */
export function readAssets(clientDir) {
  const ignoreFile = join(clientDir, ".assetsignore");
  const rules = existsSync(ignoreFile)
    ? readFileSync(ignoreFile, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => {
          if (l.startsWith("!")) throw new ReleaseError(`.assetsignore: negated patterns aren't supported (${l})`);
          return ignoreRule(l);
        })
    : [];
  const special = {};
  const assets = [];
  for (const file of walk(clientDir)) {
    const rel = toPosix(relative(clientDir, file));
    if (rel === ".assetsignore") continue;
    if (rel === "_headers" || rel === "_redirects") {
      special[rel] = readFileSync(file, "utf8");
      continue;
    }
    if (NEVER(rel)) continue;
    if (rules.some((rule) => rule(rel))) continue;
    const size = statSync(file).size;
    if (size > MAX_ASSET_BYTES) throw new ReleaseError(`${rel} is over 25 MiB, Cloudflare's limit for one asset`);
    assets.push({ path: `/${rel}`, file, contentType: contentTypeOf(rel) });
  }
  return { assets, headers: special._headers, redirects: special._redirects };
}

/** The Worker's modules: the build's JavaScript and its source maps, nothing else from that folder. */
export function readModules(workerDir, mainModule) {
  const modules = [];
  for (const file of walk(workerDir)) {
    const rel = toPosix(relative(workerDir, file));
    if (rel.split("/").some((part) => part.startsWith("."))) continue; // .vite/, .dev.vars
    if (rel === "wrangler.json") continue;
    if (/\.m?js$/.test(rel)) modules.push({ name: rel, file, contentType: "application/javascript+module" });
    else if (rel.endsWith(".map")) modules.push({ name: rel, file, contentType: "application/source-map" });
    else if (rel.endsWith(".wasm")) modules.push({ name: rel, file, contentType: "application/wasm" });
    else throw new ReleaseError(`${rel} in the Worker build isn't a module the bundle knows how to carry`);
  }
  if (!modules.some((m) => m.name === mainModule)) throw new ReleaseError(`the build has no main module ${mainModule}`);
  return modules;
}

/** OpenPing's D1 migrations, in order, and what in them isn't additive. */
export function readMigrations(migrationsDir) {
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql") && Number.isFinite(migrationNumber(name)))
    .sort((a, b) => migrationNumber(a) - migrationNumber(b) || a.localeCompare(b));
  const migrations = files.map((name) => {
    const file = join(migrationsDir, name);
    return { name, file, sha256: sha256(readFileSync(file)) };
  });
  const problems = migrations
    .filter((m) => migrationNumber(m.name) > LAST_UNCHECKED_MIGRATION)
    .flatMap((m) => migrationProblems(readFileSync(m.file, "utf8")).map((p) => `${m.name} ${p}`));
  return { migrations, problems };
}

/**
 * A digest of everything the bundle holds except when it was built, so two
 * builds of the same commit compare equal and any other difference doesn't.
 */
export function bundleDigest(manifest, files) {
  const { builtAt: _builtAt, digest: _digest, ...rest } = manifest;
  const lines = files.map((f) => `${f.key} ${sha256(readFileSync(f.file))}`).sort();
  return sha256(JSON.stringify(rest) + "\n" + lines.join("\n"));
}

/**
 * Builds the bundle's folder from a finished OpenPing build: the R2 layout of
 * platform/src/bundle.ts, under `<out>/releases/<version>/`. Returns the
 * manifest and every file with its key.
 */
export function assembleBundle({ root = ROOT, out = join(root, DEFAULTS.out), commit = null, now = new Date() } = {}) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const version = pkg.version;
  if (!isVersion(version)) throw new ReleaseError(`package.json's version ${JSON.stringify(version)} can't name a release`);
  const workerDir = join(root, "dist", "open_ping");
  const clientDir = join(root, "dist", "client");
  const wranglerJson = join(workerDir, "wrangler.json");
  if (!existsSync(wranglerJson) || !existsSync(clientDir)) throw new ReleaseError("No build found in dist/; run the build first");
  const built = JSON.parse(readFileSync(wranglerJson, "utf8"));
  // The canonical install's deploy:prod config sets its own vars (the landing
  // page, the waitlist); a tenant must get the repository's defaults.
  const from = built.userConfigPath ?? built.configPath;
  if (!from || resolve(from) !== resolve(root, "wrangler.jsonc")) {
    throw new ReleaseError(`dist/ was built from ${from ?? "an unknown config"}, not wrangler.jsonc; rebuild with the plain build`);
  }
  const config = workerConfig(built);
  const mainModule = built.main;
  const modules = readModules(workerDir, mainModule);
  const { assets, headers, redirects } = readAssets(clientDir);
  if (headers !== undefined) config.assetsConfig._headers = headers;
  if (redirects !== undefined) config.assetsConfig._redirects = redirects;
  const { migrations, problems } = readMigrations(join(root, "migrations"));
  if (problems.length) throw new ReleaseError(`These migrations aren't additive (RELEASING.md, "Database migrations"):\n  ${problems.join("\n  ")}`);

  const prefix = `releases/${version}`;
  const files = [
    ...modules.map((m) => ({ key: `${prefix}/modules/${m.name}`, file: m.file })),
    ...assets.map((a) => ({ key: `${prefix}/assets${a.path}`, file: a.file })),
    ...migrations.map((m) => ({ key: `${prefix}/migrations/${m.name}`, file: m.file })),
  ];
  const manifest = {
    version,
    mainModule,
    ...config,
    d1Migrations: migrations.map((m) => ({ name: m.name, sha256: m.sha256 })),
    modules: modules.map((m) => ({ name: m.name, contentType: m.contentType })),
    assets: assets.map((a) => ({ path: a.path, contentType: a.contentType })),
    ...(commit ? { commit } : {}),
    builtAt: now.toISOString(),
  };
  manifest.digest = bundleDigest(manifest, files);

  const dir = join(out, prefix);
  rmSync(dir, { recursive: true, force: true });
  for (const f of files) {
    const target = join(out, f.key);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(f.file));
  }
  writeFileSync(join(dir, "bundle.json"), JSON.stringify(manifest, null, 2) + "\n");
  const bytes = files.reduce((n, f) => n + statSync(f.file).size, 0);
  return { version, dir, manifest, files: files.map((f) => ({ key: f.key, file: join(out, f.key) })), bytes };
}

// --- Running commands ------------------------------------------------------------

/** Runs a command, inheriting the terminal; with `capture`, answers its output. */
export function defaultRunner(command, { capture = false, env } = {}) {
  const [cmd, ...args] = command;
  const result = spawnSync(cmd, args, { cwd: ROOT, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", encoding: "utf8", env: env ?? process.env });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function show(command) {
  return command.map((part) => (/^[\w./:=@+-]+$/.test(part) ? part : `'${part.replace(/'/g, "'\\''")}'`)).join(" ");
}

// --- The remote side ---------------------------------------------------------------

/** Quotes a value for SQL; every value here is checked first, this is the second line. */
export function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

export const ACTIONS = { rollout: "rollout", rollback: "rollback", pause: "pause", resume: "resume", "skip-failed": "skip_failed", cancel: "cancel" };

/** The INSERT a request is, checked like the platform checks it (platform/src/releases/runner.ts, requestProblem). */
export function requestSql({ action, version = null, dryRun = false, canary = null, batchSize = null, id = `rrq_${randomBytes(12).toString("hex")}`, now = Date.now() }) {
  if (!Object.values(ACTIONS).includes(action)) throw new ReleaseError(`unknown action ${action}`);
  if (action === "rollout" && !isVersion(version)) throw new ReleaseError("start needs a version, such as 0.15.0");
  if (version !== null && !isVersion(version)) throw new ReleaseError(`${version} isn't a version`);
  if (canary !== null && !SLUG_PATTERN.test(canary)) throw new ReleaseError("--canary takes a slug or a tenant id");
  if (batchSize !== null && (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500)) throw new ReleaseError("--batch-size is 1 to 500");
  const values = [id, action, version, dryRun ? 1 : 0, canary, batchSize, "cli", now].map(sqlValue).join(", ");
  return { id, sql: `INSERT INTO release_requests (id, action, version, dry_run, canary, batch_size, requested_by, created_at) VALUES (${values});` };
}

export const STATUS_SQL = [
  "SELECT id, kind, version, from_version, dry_run, state, batch, note, datetime(created_at / 1000, 'unixepoch') AS created FROM releases ORDER BY created_at DESC LIMIT 5",
  "SELECT r.release_id, r.state, COUNT(*) AS tenants FROM release_tenants r WHERE r.release_id = (SELECT id FROM releases ORDER BY created_at DESC LIMIT 1) GROUP BY r.state",
  "SELECT id, action, version, datetime(created_at / 1000, 'unixepoch') AS created, handled_at IS NOT NULL AS handled, result FROM release_requests ORDER BY created_at DESC LIMIT 5",
].join("; ");

function d1Command(options, sql, json = false) {
  return ["npx", "wrangler", "d1", "execute", options.database, "--remote", "--config", options.config, "--command", sql, ...(json ? ["--json"] : [])];
}

/**
 * The commands an upload runs: is that version already there, then every
 * file in one bulk put, then bundle.json alone, last, so a bundle the
 * platform can see is always complete.
 */
export function uploadCommands({ bucket, version, listFile, manifestFile }) {
  return {
    probe: ["npx", "wrangler", "r2", "object", "get", `${bucket}/releases/${version}/bundle.json`, "--pipe", "--remote"],
    files: ["npx", "wrangler", "r2", "bulk", "put", bucket, "--filename", listFile, "--remote"],
    manifest: ["npx", "wrangler", "r2", "object", "put", `${bucket}/releases/${version}/bundle.json`, "--file", manifestFile, "--content-type", "application/json", "--remote"],
  };
}

/** Whether a failed `r2 object get` means "no such object" rather than a real failure. */
export function isMissingObject(output) {
  return /does not exist|not found|NoSuchKey|10007/i.test(output);
}

// --- Commands ----------------------------------------------------------------------

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split("=", 2);
    if (["dry-run", "print", "skip-build", "allow-dirty", "help"].includes(name)) flags[name] = true;
    else flags[name] = inline ?? argv[++i];
  }
  return { positional, flags };
}

function gitCommit(run) {
  const head = run(["git", "rev-parse", "HEAD"], { capture: true });
  const dirty = run(["git", "status", "--porcelain", "--untracked-files=no"], { capture: true });
  return { commit: head.status === 0 ? head.stdout.trim() : null, dirty: dirty.status === 0 && dirty.stdout.trim() !== "" };
}

export async function main(argv, { run = defaultRunner, log = console.log, root = ROOT } = {}) {
  const { positional, flags } = parseArgs(argv);
  const [command, arg] = positional;
  const options = {
    out: resolve(root, flags.out ?? DEFAULTS.out),
    bucket: flags.bucket ?? DEFAULTS.bucket,
    database: flags.database ?? DEFAULTS.database,
    config: flags.config ?? DEFAULTS.config,
  };
  const remote = (cmd, opts = {}) => {
    log(`$ ${show(cmd)}`);
    if (flags.print) return { status: 0, stdout: "", stderr: "" };
    return run(cmd, opts);
  };
  const ask = (input, done) => {
    const { id, sql } = requestSql(input);
    const result = remote(d1Command(options, sql));
    if (flags.print) {
      log("Printed only; nothing was asked.");
      return;
    }
    if (result.status !== 0) throw new ReleaseError("wrangler d1 execute failed; nothing was asked");
    log(`Asked (${id}). ${done} The platform picks it up within a minute: npm run tenant-release -- status, or the admin console's Releases tab.`);
  };

  switch (command) {
    case "build": {
      const git = gitCommit(run);
      if (git.dirty && !flags["allow-dirty"]) throw new ReleaseError("The checkout has uncommitted changes; a release is built from a commit (--allow-dirty to build anyway, for a test)");
      const marker = join(root, BUILD_MARKER);
      if (!flags["skip-build"]) {
        // The plain config, never the canonical install's: drop the override.
        const env = { ...process.env };
        delete env.OPENPING_WRANGLER_CONFIG;
        log("$ npm run build");
        const built = run(["npm", "run", "build"], { env });
        if (built.status !== 0) throw new ReleaseError("The build failed");
        // Which commit this dist/ is, for a later --skip-build to check.
        writeFileSync(marker, `${git.commit ?? "unknown"}\n`);
      } else {
        const builtFrom = existsSync(marker) ? readFileSync(marker, "utf8").trim() : null;
        if (!builtFrom || builtFrom !== git.commit) {
          throw new ReleaseError(
            `dist/ was built from ${builtFrom ?? "an unknown commit"}, not ${git.commit ?? "this checkout"}; run build without --skip-build`,
          );
        }
      }
      const bundle = assembleBundle({ root, out: options.out, commit: git.commit });
      log(
        `Bundle ${bundle.version}: ${bundle.manifest.modules.length} modules, ${bundle.manifest.assets.length} assets, ${bundle.manifest.d1Migrations.length} migrations, ${(bundle.bytes / 1_048_576).toFixed(1)} MiB, in ${relative(root, bundle.dir)}`,
      );
      log(`Next: npm run tenant-release -- upload`);
      return bundle;
    }
    case "upload": {
      const version = arg ?? JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
      if (!isVersion(version)) throw new ReleaseError(`${version} isn't a version`);
      const dir = join(options.out, "releases", version);
      const manifestFile = join(dir, "bundle.json");
      if (!existsSync(manifestFile)) throw new ReleaseError(`No bundle for ${version} in ${relative(root, options.out)}; run build first`);
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
      const files = walk(dir)
        .filter((f) => f !== manifestFile)
        .map((f) => ({ key: `releases/${version}/${toPosix(relative(dir, f))}`, file: f }));
      if (bundleDigest(manifest, files) !== manifest.digest) throw new ReleaseError(`The files in ${relative(root, dir)} don't match its bundle.json; build again`);
      const listFile = join(options.out, `upload-${version}.json`);
      writeFileSync(listFile, JSON.stringify(files, null, 2));
      const commands = uploadCommands({ bucket: options.bucket, version, listFile, manifestFile });
      const probe = remote(commands.probe, { capture: true });
      if (!flags.print) {
        if (probe.status === 0) {
          let remoteDigest;
          try {
            remoteDigest = JSON.parse(probe.stdout).digest ?? null;
          } catch {
            remoteDigest = null;
          }
          if (remoteDigest === manifest.digest) {
            log(`${version} is already in ${options.bucket}, identical; nothing to upload.`);
            return { uploaded: false };
          }
          throw new ReleaseError(`${options.bucket} already has a different ${version}; a version is never replaced. Bump the version and build again.`);
        }
        if (!isMissingObject(probe.stdout + probe.stderr)) throw new ReleaseError(`Couldn't check ${options.bucket} for ${version}:\n${probe.stderr || probe.stdout}`);
      }
      if (remote(commands.files).status !== 0) throw new ReleaseError("The upload of the bundle's files failed; run upload again (it is safe to repeat)");
      if (remote(commands.manifest).status !== 0) throw new ReleaseError("The upload of bundle.json failed; run upload again");
      if (flags.print) {
        log("Printed only; nothing ran.");
        return { uploaded: false };
      }
      log(`Uploaded ${version} (${files.length + 1} objects). Next: npm run tenant-release -- start ${version} --dry-run`);
      return { uploaded: true };
    }
    case "start":
      ask(
        { action: "rollout", version: arg ?? null, dryRun: !!flags["dry-run"], canary: flags.canary ?? null, batchSize: flags["batch-size"] ? Number(flags["batch-size"]) : null },
        flags["dry-run"] ? "A dry run: it plans and changes nothing." : `It ships ${arg} to the canary first.`,
      );
      return;
    case "rollback":
      ask(
        { action: "rollback", version: flags.to ?? null, dryRun: !!flags["dry-run"], batchSize: flags["batch-size"] ? Number(flags["batch-size"]) : null },
        flags["dry-run"] ? "A dry run: it plans and changes nothing." : `New tenants get ${flags.to ?? "the version before"} at once, and every tenant follows.`,
      );
      return;
    case "pause":
    case "resume":
    case "skip-failed":
    case "cancel":
      ask({ action: ACTIONS[command] }, "");
      return;
    case "status": {
      const result = remote(d1Command(options, STATUS_SQL, true), { capture: true });
      if (flags.print) return;
      if (result.status !== 0) throw new ReleaseError(`wrangler d1 execute failed:\n${result.stderr || result.stdout}`);
      const parsed = JSON.parse(result.stdout.slice(result.stdout.indexOf("[")));
      const [releases, counts, requests] = parsed.map((p) => p.results ?? []);
      log("Latest releases:");
      for (const r of releases) log(`  ${r.created}  ${r.id}  ${r.kind} ${r.version}${r.dry_run ? " (dry run)" : ""}  ${r.state}, batch ${r.batch}\n      ${r.note ?? ""}`);
      if (counts.length) log(`Latest release's tenants: ${counts.map((c) => `${c.tenants} ${c.state}`).join(", ")}`);
      log("Latest requests:");
      for (const q of requests) log(`  ${q.created}  ${q.id}  ${q.action} ${q.version ?? ""}  ${q.handled ? q.result : "waiting for the next tick"}`);
      return;
    }
    default:
      log(
        [
          "npm run tenant-release -- <command>",
          "  build [--skip-build] [--allow-dirty]   build the tenant bundle into .tenant-bundle/",
          "  upload [version] [--bucket name]       put it in R2 (bundle.json last)",
          "  start <version> [--dry-run] [--canary slug] [--batch-size n]",
          "  rollback [--to version] [--dry-run]",
          "  pause | resume | skip-failed | cancel",
          "  status",
          "Options for the remote commands: --database openping-platform --config platform/wrangler.jsonc, --print to only print them.",
        ].join("\n"),
      );
      if (command && command !== "help" && !flags.help) throw new ReleaseError(`unknown command ${command}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof ReleaseError ? `tenant-release: ${error.message}` : error);
    process.exit(1);
  });
}
