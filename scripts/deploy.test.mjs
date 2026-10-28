import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { databaseBinding, deploySteps, guardPlainDeploy, listIncludes } from "./deploy.mjs";
import { parseJsonc } from "./prod-config.mjs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const template = parseJsonc(readFileSync("wrangler.jsonc", "utf8"));

describe("deploySteps", () => {
  const migrate = ["wrangler", "d1", "migrations", "apply", "DB", "--remote", "-c", "wrangler.jsonc"];

  it("migrates before deploying when the database exists", () => {
    expect(deploySteps({ configPath: "wrangler.jsonc", databaseExists: true })).toEqual([
      ["npm", "run", "build"],
      migrate,
      ["wrangler", "deploy"],
    ]);
  });

  it("deploys first (which creates the database), then migrates, on a first install", () => {
    expect(deploySteps({ configPath: "wrangler.jsonc", databaseExists: false })).toEqual([
      ["npm", "run", "build"],
      ["wrangler", "deploy"],
      migrate,
    ]);
  });

  it("migrates with the config it was given, by binding name", () => {
    const steps = deploySteps({ configPath: ".wrangler.prod.jsonc", databaseExists: true });
    expect(steps[1]).toEqual([...migrate.slice(0, -1), ".wrangler.prod.jsonc"]);
  });
});

describe("listIncludes", () => {
  const list = JSON.stringify([
    { uuid: "11111111-2222-3333-4444-555555555555", name: "other" },
    { uuid: "66666666-7777-8888-9999-000000000000", name: "open-ping" },
  ]);

  it("finds a database by name", () => {
    expect(listIncludes(list, "open-ping")).toBe(true);
    expect(listIncludes(list, "missing")).toBe(false);
    expect(listIncludes("[]", "open-ping")).toBe(false);
  });

  it("skips anything printed before the JSON", () => {
    expect(listIncludes(`npm notice run wrangler\n${list}`, "other")).toBe(true);
  });

  it("fails loudly on output it doesn't understand", () => {
    expect(() => listIncludes("Not logged in", "open-ping")).toThrow(/Unexpected/);
  });
});

describe("guardPlainDeploy", () => {
  it("refuses a plain deploy from a checkout with deploy.local.json", () => {
    expect(() => guardPlainDeploy({ configPath: "wrangler.jsonc", hasOverrides: true })).toThrow(
      /deploy:prod/,
    );
  });

  it("allows deploy:prod there, and a plain deploy everywhere else", () => {
    expect(() =>
      guardPlainDeploy({ configPath: ".wrangler.prod.jsonc", hasOverrides: true }),
    ).not.toThrow();
    expect(() => guardPlainDeploy({ configPath: "wrangler.jsonc", hasOverrides: false })).not.toThrow();
  });
});

describe("the Deploy to Cloudflare button's view of the repository", () => {
  it("finds the DB binding the migrations use", () => {
    expect(databaseBinding(template)).toMatchObject({ binding: "DB", migrations_dir: "migrations" });
    expect(() => databaseBinding({ d1_databases: [] })).toThrow(/"DB"/);
  });

  it("runs the migrating deploy script, and every remote D1 script uses the binding", () => {
    // The button and Workers Builds pre-fill `npm run build` and `npm run deploy`.
    expect(pkg.scripts.deploy).toBe("node scripts/deploy.mjs");
    expect(pkg.scripts.build).toBe("vite build");
    // The button lets people rename the database, so scripts use the binding.
    for (const name of ["db:migrate", "db:migrate:local", "db:migrate:prod"]) {
      expect(pkg.scripts[name]).toMatch(/migrations apply DB /);
    }
  });

  it("prompts only for the required secrets, each with a description", () => {
    // The button asks for every uncommented key in .dev.vars.example; anything
    // optional stays commented out so the deploy form doesn't ask for it.
    const keys = readFileSync(".dev.vars.example", "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split("=")[0]);
    expect(keys).toEqual(["MASTER_KEY", "SETUP_TOKEN"]);
    const described = pkg.cloudflare.bindings;
    for (const key of [...keys, ...Object.keys(template.vars), "DB"]) {
      expect(described[key]?.description, key).toBeTruthy();
    }
    for (const key of Object.keys(described)) {
      expect([...keys, ...Object.keys(template.vars), "DB"], key).toContain(key);
    }
  });
});
