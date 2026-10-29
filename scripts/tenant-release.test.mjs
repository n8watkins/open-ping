import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { R2BundleSource, clearLoadedBundles, workerConfigFromWrangler } from "../platform/src/bundle.ts";
import { FakeR2Bucket } from "../platform/test/fake-r2.ts";
import { ReleaseError, assembleBundle, isMissingObject, main, requestSql, sqlValue, uploadCommands, workerConfig } from "./tenant-release.mjs";

let root;

function write(path, content) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const WRANGLER = (configPath) => ({
  configPath,
  userConfigPath: configPath,
  name: "open-ping",
  main: "index.js",
  compatibility_date: "2024-12-30",
  compatibility_flags: ["nodejs_compat"],
  triggers: { crons: ["*/12 * * * *"] },
  assets: { binding: "ASSETS", not_found_handling: "none", run_worker_first: ["/*", "!/assets/*"], directory: "../client" },
  vars: { WORKERS_PLAN: "free", HOME_PAGE: "status", WAITLIST_ENABLED: "false", NUMBER: 3 },
  durable_objects: { bindings: [{ name: "REGION_PROBE", class_name: "RegionProbe" }] },
  migrations: [{ tag: "v1", new_sqlite_classes: ["RegionProbe"] }],
  ratelimits: [{ name: "EVENT_LIMITER", namespace_id: "4271", simple: { limit: 30, period: 60 } }],
  d1_databases: [{ binding: "DB", database_name: "open-ping", migrations_dir: "../../migrations" }],
});

/** A finished build of a tiny OpenPing, laid out like `npm run build` leaves dist/. */
function fixture() {
  write("package.json", JSON.stringify({ name: "open-ping", version: "0.15.0" }));
  write("wrangler.jsonc", "{}");
  write("dist/open_ping/wrangler.json", JSON.stringify(WRANGLER(join(root, "wrangler.jsonc"))));
  write("dist/open_ping/index.js", "export default { fetch() {} }");
  write("dist/open_ping/index.js.map", "{}");
  write("dist/open_ping/.dev.vars", "MASTER_KEY=secret");
  write("dist/open_ping/.vite/manifest.json", "{}");
  write("dist/client/index.html", "<!doctype html>");
  write("dist/client/assets/app-1a2b.js", "console.log(1)");
  write("dist/client/icon.svg", "<svg/>");
  write("dist/client/_headers", "/*\n  X-Content-Type-Options: nosniff\n");
  write("dist/client/.assetsignore", "wrangler.json\n.dev.vars\n");
  write("dist/client/wrangler.json", "{}");
  write("dist/client/.dev.vars", "MASTER_KEY=secret");
  write("migrations/0001_init.sql", "CREATE TABLE monitors (id TEXT PRIMARY KEY);");
  write("migrations/0021_support.sql", "CREATE TABLE support_activity (id INTEGER PRIMARY KEY);");
  write("dist/.tenant-release-commit", "abc123\n");
}

function files(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(path));
    else out.push(relative(join(root, ".tenant-bundle"), path).split("\\").join("/"));
  }
  return out.sort();
}

/** A runner that records commands and answers from `answers` (by a word in the command). */
function recorder(answers = {}) {
  const calls = [];
  const run = (command, opts = {}) => {
    calls.push({ command, opts });
    const key = Object.keys(answers).find((k) => command.join(" ").includes(k));
    if (key) return typeof answers[key] === "function" ? answers[key](command) : answers[key];
    if (command[0] === "git") return { status: 0, stdout: command.includes("rev-parse") ? "abc123\n" : "", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  return { run, calls, commands: () => calls.map((c) => c.command.join(" ")) };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tenant-release-"));
  fixture();
  clearLoadedBundles();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("building the bundle", () => {
  it("writes the R2 layout, without anything secret or Wrangler's own files", () => {
    const bundle = assembleBundle({ root, out: join(root, ".tenant-bundle"), commit: "abc123" });
    expect(files(join(root, ".tenant-bundle"))).toEqual([
      "releases/0.15.0/assets/assets/app-1a2b.js",
      "releases/0.15.0/assets/icon.svg",
      "releases/0.15.0/assets/index.html",
      "releases/0.15.0/bundle.json",
      "releases/0.15.0/migrations/0001_init.sql",
      "releases/0.15.0/migrations/0021_support.sql",
      "releases/0.15.0/modules/index.js",
      "releases/0.15.0/modules/index.js.map",
    ]);
    const manifest = JSON.parse(readFileSync(join(bundle.dir, "bundle.json"), "utf8"));
    expect(manifest).toMatchObject({
      version: "0.15.0",
      mainModule: "index.js",
      commit: "abc123",
      vars: { WORKERS_PLAN: "free", HOME_PAGE: "status", WAITLIST_ENABLED: "false", NUMBER: "3" },
      assetsConfig: { not_found_handling: "none", run_worker_first: ["/*", "!/assets/*"], _headers: "/*\n  X-Content-Type-Options: nosniff\n" },
      modules: [
        { name: "index.js", contentType: "application/javascript+module" },
        { name: "index.js.map", contentType: "application/source-map" },
      ],
      assets: [
        { path: "/assets/app-1a2b.js", contentType: "text/javascript; charset=utf-8" },
        { path: "/icon.svg", contentType: "image/svg+xml" },
        { path: "/index.html", contentType: "text/html; charset=utf-8" },
      ],
    });
    expect(manifest.d1Migrations.map((m) => m.name)).toEqual(["0001_init.sql", "0021_support.sql"]);
    expect(manifest.d1Migrations[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(manifest)).not.toContain("secret");
  });

  it("reads its worker config exactly as the platform does", () => {
    const built = WRANGLER("/x/wrangler.jsonc");
    expect(workerConfig(built)).toEqual(workerConfigFromWrangler(built));
  });

  it("gives two builds of the same tree the same digest, and a changed file another", () => {
    const first = assembleBundle({ root, out: join(root, "a"), now: new Date(1) });
    const second = assembleBundle({ root, out: join(root, "b"), now: new Date(2) });
    expect(second.manifest.builtAt).not.toBe(first.manifest.builtAt);
    expect(second.manifest.digest).toBe(first.manifest.digest);
    write("dist/client/index.html", "<!doctype html><p>changed");
    expect(assembleBundle({ root, out: join(root, "c") }).manifest.digest).not.toBe(first.manifest.digest);
  });

  it("refuses a build from the canonical install's config, and a migration that isn't additive", () => {
    write("dist/open_ping/wrangler.json", JSON.stringify(WRANGLER(join(root, ".wrangler.prod.jsonc"))));
    expect(() => assembleBundle({ root })).toThrow(/not wrangler.jsonc/);
    write("dist/open_ping/wrangler.json", JSON.stringify(WRANGLER(join(root, "wrangler.jsonc"))));
    write("migrations/0022_drop.sql", "ALTER TABLE monitors DROP COLUMN name;");
    expect(() => assembleBundle({ root })).toThrow(/0022_drop.sql drops something/);
  });

  it("refuses a Worker build file it can't carry, and a missing build", () => {
    write("dist/open_ping/data.bin", "x");
    expect(() => assembleBundle({ root })).toThrow(/data.bin/);
    rmSync(join(root, "dist"), { recursive: true });
    expect(() => assembleBundle({ root })).toThrow(/No build found/);
  });

  it("is read back by the platform byte for byte", async () => {
    const bundle = assembleBundle({ root, out: join(root, ".tenant-bundle") });
    const r2 = new FakeR2Bucket();
    for (const f of [...bundle.files, { key: "releases/0.15.0/bundle.json", file: join(bundle.dir, "bundle.json") }]) {
      r2.objects.set(f.key, { body: new Uint8Array(readFileSync(f.file)), uploaded: new Date(0) });
    }
    r2.putText("releases/current", "0.15.0");
    const loaded = await new R2BundleSource(r2.bucket).current();
    expect(loaded.version).toBe("0.15.0");
    expect(loaded.modules.map((m) => [m.name, new TextDecoder().decode(m.content)])).toEqual([
      ["index.js", "export default { fetch() {} }"],
      ["index.js.map", "{}"],
    ]);
    expect(loaded.assets.find((a) => a.path === "/index.html")?.content.byteLength).toBe(statSync(join(root, "dist/client/index.html")).size);
    expect(loaded.durableObjects).toEqual([{ name: "REGION_PROBE", className: "RegionProbe" }]);
    expect(loaded.d1Migrations).toHaveLength(2);
    expect(await new R2BundleSource(r2.bucket).migrationSql("0.15.0", "0021_support.sql")).toContain("support_activity");
  });
});

describe("the commands", () => {
  it("build runs the plain build, never the canonical install's config", async () => {
    process.env.OPENPING_WRANGLER_CONFIG = ".wrangler.prod.jsonc";
    try {
      const r = recorder();
      const lines = [];
      await main(["build"], { run: r.run, root, log: (l) => lines.push(l) });
      const build = r.calls.find((c) => c.command.join(" ") === "npm run build");
      expect(build.opts.env.OPENPING_WRANGLER_CONFIG).toBeUndefined();
      expect(lines.at(-2)).toMatch(/^Bundle 0.15.0: 2 modules, 3 assets, 2 migrations/);
    } finally {
      delete process.env.OPENPING_WRANGLER_CONFIG;
    }
  });

  it("build records the commit it built, and --skip-build refuses a dist/ from another one", async () => {
    await main(["build"], { run: recorder().run, root, log: () => {} });
    expect(readFileSync(join(root, "dist/.tenant-release-commit"), "utf8")).toBe("abc123\n");
    const moved = recorder({ "rev-parse": { status: 0, stdout: "def456\n", stderr: "" } });
    await expect(main(["build", "--skip-build"], { run: moved.run, root, log: () => {} })).rejects.toThrow(/built from abc123, not def456/);
    rmSync(join(root, "dist/.tenant-release-commit"));
    await expect(main(["build", "--skip-build"], { run: recorder().run, root, log: () => {} })).rejects.toThrow(/an unknown commit/);
  });

  it("build refuses a dirty checkout unless told", async () => {
    const r = recorder({ "status --porcelain": { status: 0, stdout: " M src/x.ts\n", stderr: "" } });
    await expect(main(["build", "--skip-build"], { run: r.run, root, log: () => {} })).rejects.toThrow(/uncommitted changes/);
    await expect(main(["build", "--skip-build", "--allow-dirty"], { run: r.run, root, log: () => {} })).resolves.toMatchObject({ version: "0.15.0" });
  });

  it("upload puts every file, then bundle.json last, into a bucket without that version", async () => {
    await main(["build", "--skip-build"], { run: recorder().run, root, log: () => {} });
    const r = recorder({ "object get": { status: 1, stdout: "", stderr: "The specified key does not exist." } });
    await expect(main(["upload", "--bucket", "openping-tenant-bundles-staging"], { run: r.run, root, log: () => {} })).resolves.toEqual({ uploaded: true });
    expect(r.commands()).toEqual([
      "npx wrangler r2 object get openping-tenant-bundles-staging/releases/0.15.0/bundle.json --pipe --remote",
      `npx wrangler r2 bulk put openping-tenant-bundles-staging --filename ${join(root, ".tenant-bundle", "upload-0.15.0.json")} --remote`,
      `npx wrangler r2 object put openping-tenant-bundles-staging/releases/0.15.0/bundle.json --file ${join(root, ".tenant-bundle/releases/0.15.0/bundle.json")} --content-type application/json --remote`,
    ]);
    const list = JSON.parse(readFileSync(join(root, ".tenant-bundle", "upload-0.15.0.json"), "utf8"));
    expect(list.map((e) => e.key)).not.toContain("releases/0.15.0/bundle.json");
    expect(list).toHaveLength(7);
  });

  it("upload skips an identical version and refuses to replace a different one", async () => {
    const bundle = await main(["build", "--skip-build"], { run: recorder().run, root, log: () => {} });
    const same = recorder({ "object get": { status: 0, stdout: JSON.stringify({ ...bundle.manifest, builtAt: "earlier" }), stderr: "" } });
    await expect(main(["upload"], { run: same.run, root, log: () => {} })).resolves.toEqual({ uploaded: false });
    expect(same.calls).toHaveLength(1);
    const other = recorder({ "object get": { status: 0, stdout: JSON.stringify({ ...bundle.manifest, digest: "other" }), stderr: "" } });
    await expect(main(["upload"], { run: other.run, root, log: () => {} })).rejects.toThrow(/already has a different 0.15.0/);
    const broken = recorder({ "object get": { status: 1, stdout: "", stderr: "Authentication error" } });
    await expect(main(["upload"], { run: broken.run, root, log: () => {} })).rejects.toThrow(/Couldn't check/);
  });

  it("upload refuses a bundle folder that was changed after it was built", async () => {
    await main(["build", "--skip-build"], { run: recorder().run, root, log: () => {} });
    writeFileSync(join(root, ".tenant-bundle/releases/0.15.0/assets/index.html"), "tampered");
    await expect(main(["upload"], { run: recorder().run, root, log: () => {} })).rejects.toThrow(/don't match its bundle.json/);
  });

  it("start, rollback and the rest add one request row, and --print runs nothing", async () => {
    const r = recorder();
    await main(["start", "0.15.0", "--dry-run", "--canary", "owner-test", "--batch-size", "10"], { run: r.run, root, log: () => {} });
    await main(["rollback", "--to", "0.14.0"], { run: r.run, root, log: () => {} });
    await main(["skip-failed", "--database", "openping-platform-staging", "--config", "platform/wrangler.staging.jsonc"], { run: r.run, root, log: () => {} });
    const sql = r.calls.map((c) => c.command[c.command.indexOf("--command") + 1]);
    expect(sql[0]).toMatch(/VALUES \('rrq_[0-9a-f]{24}', 'rollout', '0.15.0', 1, 'owner-test', 10, 'cli', \d+\);$/);
    expect(sql[1]).toMatch(/'rollback', '0.14.0', 0, NULL, NULL, 'cli'/);
    expect(sql[2]).toMatch(/'skip_failed', NULL, 0, NULL, NULL, 'cli'/);
    expect(r.calls[2].command.slice(0, 8)).toEqual(["npx", "wrangler", "d1", "execute", "openping-platform-staging", "--remote", "--config", "platform/wrangler.staging.jsonc"]);

    const quiet = recorder();
    const lines = [];
    await main(["rollback", "--print"], { run: quiet.run, root, log: (l) => lines.push(l) });
    expect(quiet.calls).toHaveLength(0);
    expect(lines[0]).toMatch(/^\$ npx wrangler d1 execute openping-platform --remote --config platform\/wrangler.jsonc --command 'INSERT INTO release_requests/);
    expect(lines[1]).toBe("Printed only; nothing was asked.");
  });

  it("checks what it asks for, as the platform does", () => {
    expect(() => requestSql({ action: "rollout" })).toThrow(ReleaseError);
    expect(() => requestSql({ action: "rollout", version: "0.15.0'; DROP TABLE tenants; --" })).toThrow(/a version/);
    expect(() => requestSql({ action: "rollout", version: "0.15.0", canary: "Bad Slug" })).toThrow(/--canary/);
    expect(() => requestSql({ action: "rollout", version: "0.15.0", batchSize: 0 })).toThrow(/batch-size/);
    expect(() => requestSql({ action: "drop" })).toThrow(/unknown action/);
    expect(sqlValue("it's")).toBe("'it''s'");
  });

  it("status reads the release tables as JSON", async () => {
    const answer = JSON.stringify([
      { results: [{ id: "rel_1", kind: "rollout", version: "0.15.0", dry_run: 0, state: "rolling", batch: 2, note: "rolling out", created: "2026-10-28 18:00:00" }] },
      { results: [{ state: "healthy", tenants: 51 }, { state: "pending", tenants: 49 }] },
      { results: [] },
    ]);
    const lines = [];
    await main(["status"], { run: recorder({ "d1 execute": { status: 0, stdout: answer, stderr: "" } }).run, root, log: (l) => lines.push(l) });
    expect(lines.join("\n")).toContain("rel_1  rollout 0.15.0  rolling, batch 2");
    expect(lines.join("\n")).toContain("51 healthy, 49 pending");
  });

  it("knows what a missing object looks like, and what the upload runs", () => {
    expect(isMissingObject("✘ [ERROR] The specified key does not exist.")).toBe(true);
    expect(isMissingObject("Authentication error [code: 10000]")).toBe(false);
    expect(uploadCommands({ bucket: "b", version: "1.0.0", listFile: "l.json", manifestFile: "m.json" }).manifest.at(-1)).toBe("--remote");
  });

  it("refuses an unknown command", async () => {
    await expect(main(["deploy"], { run: recorder().run, root, log: () => {} })).rejects.toThrow(/unknown command deploy/);
  });
});
