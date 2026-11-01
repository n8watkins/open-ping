// The restore drill end to end against a fake staging account (real SQLite,
// the real migrations, the platform's cron played by the fake): the steps in
// their order, the data and the decrypted values read back, the refusals,
// and a stop after the database is gone picked up with --continue.

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encryptValue } from "./keys.mjs";
import { monitorSeedSql, monitorTargets } from "./seed.mjs";
import { sealConfig } from "./keys.mjs";
import { DrillError } from "./lib.mjs";
import { PLATFORM_KEY_ENV, STEPS, main } from "./restore.mjs";
import { FakeStaging, dumpDatabase } from "./testing/fake-staging.mjs";

const STAGING = {
  name: "openping-platform-staging",
  vars: { HOSTED_DOMAIN: "staging.openping.test", DISPATCH_NAMESPACE: "openping-tenants-staging" },
  d1_databases: [{ binding: "PLATFORM_DB", database_name: "openping-platform-staging" }],
  dispatch_namespaces: [{ binding: "TENANTS", namespace: "openping-tenants-staging" }],
  r2_buckets: [
    { binding: "BUNDLES", bucket_name: "openping-tenant-bundles-staging" },
    { binding: "EXPORTS", bucket_name: "openping-tenant-exports-staging" },
  ],
};

let root;
let configPath;
let fake;
let tenant;
let logs;

async function seedTenantData(t) {
  const sql = await monitorSeedSql({
    targets: monitorTargets("https://echo.example.com", 3),
    seal: (c) => sealConfig(t.masterKey, c),
    now: fake.now(),
    newMonitorId: () => `mon_${crypto.randomUUID()}`,
  });
  t.db.exec(sql);
  t.db.prepare("INSERT INTO settings (key, value, encrypted, updated_at) VALUES ('vapid_private_key', ?, 1, 0)").run(await encryptValue(t.masterKey, "vapid-secret"));
  t.db.prepare("INSERT INTO settings (key, value, encrypted, updated_at) VALUES ('site_name', 'Acme', 0, 0)").run();
}

function drill(extra = [], { env = { [PLATFORM_KEY_ENV]: fake.platformKey } } = {}) {
  return main(["--env", "staging", "--config", configPath, "--tenant", "acme", "--confirm", STAGING.name, ...extra], {
    run: fake.run,
    fetch: fake.fetch,
    log: (line) => logs.push(line),
    env,
    now: fake.now,
    wait: fake.wait,
    root,
  });
}

const writes = () => fake.log.filter((c) => c.kind === "run" && !c.argv.includes("info") && !/--command (SELECT|PRAGMA)/.test(c.argv.join(" ")) && !c.argv.includes("get"));

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "restore-drill-"));
  configPath = join(root, "staging.jsonc");
  writeFileSync(configPath, JSON.stringify(STAGING));
  fake = new FakeStaging({ root });
  tenant = await fakeTenant();
  logs = [];
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

async function fakeTenant() {
  const t = await fake.addReadyTenant({ slug: "acme", tenantId: "acmetenant000001" });
  await seedTenantData(t);
  return t;
}

describe("the restore drill", () => {
  it("deletes the database, restores it from the export with the escrowed key, and proves it reads back", async () => {
    const oldId = fake.tenant("acme").d1_id;
    const before = dumpDatabase(tenant.db);
    const { state } = await drill();

    expect(state.result).toBe("passed");
    expect(state.completed).toEqual(STEPS);
    // A new database under the same name, with the same contents, bound to the tenant.
    const row = fake.tenant("acme");
    expect(row.provision_state).toBe("ready");
    expect(row.d1_id).not.toBe(oldId);
    expect(row.d1_id).toBe(state.newD1Id);
    expect(fake.databases.get("openping-t-acmetenant000001").uuid).toBe(row.d1_id);
    expect(dumpDatabase(fake.databases.get("openping-t-acmetenant000001").db)).toContain(before.split("\n").find((l) => l.startsWith('INSERT INTO "monitors"')));
    // Uploaded again by provisioning, bound to the new database, with the key that was escrowed.
    expect(fake.uploads.at(-1)).toMatchObject({ tenantId: "acmetenant000001", d1Id: row.d1_id, kid: state.kid });
    // 3 monitor configs and the VAPID key decrypted to the same hashes.
    const monitors = state.before.tables.monitors;
    expect(monitors.decrypted).toBe(3);
    expect(state.before.tables.settings.decrypted).toBe(1);
    expect(state.after.tables).toEqual(state.before.tables);
    expect(state.firstRun.checked).toBe(3);
    // The dump is gone afterwards; the state file has no secret in it.
    expect(readdirSync(join(root, ".hosted-drills")).filter((f) => f.endsWith(".sql"))).toEqual([]);
    const saved = readFileSync(join(root, ".hosted-drills", readdirSync(join(root, ".hosted-drills"))[0]), "utf8");
    expect(saved).not.toContain(tenant.masterKey);
    expect(saved).not.toContain(fake.platformKey);
    expect(saved).not.toContain("vapid-secret");
    expect(logs.join("\n")).not.toContain(fake.platformKey);
  });

  it("changes things in this order, and only these", async () => {
    await drill();
    const kinds = writes().map(({ argv }) => {
      const text = argv.join(" ");
      if (text.includes("SET d1_id")) return "rebind";
      if (text.includes("SET provision_state = 'db_created'")) return "quiesce";
      if (text.includes("INSERT INTO tenant_exports")) return "export";
      if (argv[3] === "delete") return "delete-database";
      if (argv[3] === "create") return "create-database";
      if (argv.includes("--file")) return "import";
      return text;
    });
    expect(kinds).toEqual(["quiesce", "export", "delete-database", "create-database", "import", "rebind"]);
  });

  it("takes the tenant off the air before the export and keeps it off until it is bound again", async () => {
    const seen = [];
    const run = fake.run;
    fake.run = (argv) => {
      const t = fake.tenant("acme");
      seen.push({ cmd: argv[3] === "execute" && argv.includes("--file") ? "import" : argv[3], state: t.provision_state, paused: t.provision_paused_at !== null });
      return run(argv);
    };
    await drill();
    for (const s of seen.filter((x) => ["delete", "create", "import"].includes(x.cmd))) expect(s).toMatchObject({ state: "db_created", paused: true });
  });

  it("refuses a production config, or no confirmation, before running anything", async () => {
    writeFileSync(configPath, JSON.stringify({ ...STAGING, name: "openping-platform" }));
    await expect(drill()).rejects.toThrow(/name is openping-platform, which isn't a staging name/);
    writeFileSync(configPath, JSON.stringify(STAGING));
    await expect(
      main(["--env", "staging", "--config", configPath, "--tenant", "acme"], { run: fake.run, fetch: fake.fetch, log: () => {}, env: {}, now: fake.now, wait: fake.wait, root }),
    ).rejects.toThrow(/--confirm openping-platform-staging/);
    await expect(drill(["--env", "production"])).rejects.toThrow(/--env must be staging/);
    expect(fake.log).toEqual([]);
  });

  it("refuses without PLATFORM_KEY, or with the wrong one, before changing anything", async () => {
    await expect(drill([], { env: {} })).rejects.toThrow(new RegExp(PLATFORM_KEY_ENV));
    await expect(drill([], { env: { [PLATFORM_KEY_ENV]: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" } })).rejects.toThrow(/doesn't open/);
    expect(writes()).toEqual([]);
  });

  it("refuses a tenant that isn't ready, or that has nothing encrypted to prove a restore with", async () => {
    fake.platform.db.prepare("UPDATE tenants SET provision_state = 'migrated' WHERE slug = 'acme'").run();
    await expect(drill()).rejects.toThrow(/isn't ready/);
    fake.platform.db.prepare("UPDATE tenants SET provision_state = 'ready' WHERE slug = 'acme'").run();
    tenant.db.exec("DELETE FROM monitor_state; DELETE FROM monitors; DELETE FROM settings");
    await expect(drill()).rejects.toThrow(/no encrypted values/);
    expect(writes()).toEqual([]);
  });

  it("refuses while a release is rolling out", async () => {
    fake.platform.db.prepare("INSERT INTO releases (id, kind, version, state, batch_size, batch, requested_by, created_at, updated_at) VALUES ('rel_1', 'rollout', '0.19.0', 'rolling', 50, 1, 'cli', 0, 0)").run();
    await expect(drill()).rejects.toThrow(/a release is in progress/);
  });

  it("puts the tenant back when it stops before the database is deleted", async () => {
    // The export reads back wrong: caught before anything is deleted.
    const get = fake.run;
    fake.run = (argv) => {
      const result = get(argv);
      if (argv[2] === "r2") writeFileSync(join(root, argv[argv.indexOf("--file") + 1]), "tampered");
      return result;
    };
    await expect(drill()).rejects.toThrow(/doesn't match the export's size and SHA-256/);
    const row = fake.tenant("acme");
    expect(row).toMatchObject({ provision_state: "ready", provision_paused_at: null, provision_error: null });
    expect(fake.databases.get("openping-t-acmetenant000001").uuid).toBe(row.d1_id);
    expect(writes().some(({ argv }) => argv[3] === "delete")).toBe(false);
  });

  it("stops after the database is gone, keeps the tenant off the air, and finishes with --continue", async () => {
    fake.failures.set((argv) => argv[2] === "d1" && argv.includes("--file"), "D1 import failed: the network went away");
    await expect(drill()).rejects.toThrow(/load the dump into it failed/);
    expect(fake.tenant("acme")).toMatchObject({ provision_state: "db_created" });
    expect(fake.tenant("acme").provision_paused_at).not.toBeNull();
    expect(logs.join("\n")).toMatch(/--continue \.hosted-drills\/restore-acme-.*\.json/);
    const stateFile = join(".hosted-drills", readdirSync(join(root, ".hosted-drills")).find((f) => f.endsWith(".json")));
    // A new run of the same tenant refuses while that one is unfinished.
    await expect(drill()).rejects.toThrow(/didn't finish/);

    const { state } = await main(["--env", "staging", "--config", configPath, "--confirm", STAGING.name, "--continue", stateFile], {
      run: fake.run,
      fetch: fake.fetch,
      log: (line) => logs.push(line),
      env: { [PLATFORM_KEY_ENV]: fake.platformKey },
      now: fake.now,
      wait: fake.wait,
      root,
    });
    expect(state.result).toBe("passed");
    expect(fake.tenant("acme").provision_state).toBe("ready");
    // The database was created once: the continued run found the one made before the stop.
    expect(writes().filter(({ argv }) => argv[3] === "create")).toHaveLength(1);
  });

  it("fails when the restored database doesn't match what was deleted", async () => {
    // The export loses a row on the way (as a broken dump would).
    const run = fake.run;
    fake.run = (argv) => {
      if (argv[2] === "d1" && argv.includes("--file")) {
        const file = join(root, argv[argv.indexOf("--file") + 1]);
        writeFileSync(file, readFileSync(file, "utf8").replace(/^INSERT INTO "settings" VALUES\('site_name'.*$/m, ""));
      }
      return run(argv);
    };
    await expect(drill()).rejects.toThrow(/settings: 2 rows before, 1 after/);
    expect(fake.tenant("acme").provision_state).toBe("db_created");
  });

  it("--print runs nothing and lists every command in order", async () => {
    const { commands } = await drill(["--print"], { env: {} });
    expect(fake.log).toEqual([]);
    expect(commands.filter((c) => c.write).map((c) => c.what)).toEqual([
      "take the tenant off the air: not routed, not scheduled, provisioning paused",
      "ask the platform for an export of the tenant's database (its lifecycle job runs it within 5 minutes)",
      "delete the tenant's database",
      "create the tenant's database again, under the same name",
      "load the dump into it",
      "point the tenant at the new database and let provisioning upload it again (with its escrowed MASTER_KEY)",
    ]);
    expect(logs.join("\n")).toContain("$ npx wrangler d1 delete 'openping-t-<tenant id>'");
  });

  it("--dry-run reads the tenant for real and changes nothing", async () => {
    const { state } = await drill(["--dry-run"]);
    expect(writes()).toEqual([]);
    expect(state.before.tables.monitors.decrypted).toBe(3);
    expect(fake.tenant("acme").provision_state).toBe("ready");
  });

  it("is a DrillError for a missing tenant", async () => {
    await expect(main(["--env", "staging", "--config", configPath, "--tenant", "nobody", "--confirm", STAGING.name], { run: fake.run, fetch: fake.fetch, log: () => {}, env: { [PLATFORM_KEY_ENV]: fake.platformKey }, now: fake.now, wait: fake.wait, root })).rejects.toBeInstanceOf(DrillError);
  });
});
