/**
 * The tenant bundle: one OpenPing release built in hosted mode, ready to be
 * uploaded as a customer's user Worker (its modules, its static assets and
 * how they are served).
 *
 * The release runner (build plan, C1) builds a bundle once per release and
 * stores it; provisioning (./provisioning.ts) uploads the current one to each
 * new tenant. `BundleSource` is how provisioning finds it: `R2BundleSource`
 * in production, a fixed bundle in tests.
 */

import type { AssetsConfig, DurableObjectMigrationStep, WorkerModule } from "./cloudflare/api";
import { PermanentError } from "./errors";

/** One static asset of the SPA. */
export interface BundleAsset {
  /** With a leading slash, as served: "/index.html", "/assets/app-1a2b.js". */
  path: string;
  content: Uint8Array<ArrayBuffer>;
  contentType: string;
}

/** A Durable Object binding of the bundle, to a class its own main module exports. */
export interface BundleDurableObject {
  name: string;
  className: string;
}

/** One entry of the bundle's wrangler `migrations`: a tag and its step. */
export type BundleMigration = { tag: string } & DurableObjectMigrationStep;

/**
 * The parts of a tenant bundle that come from OpenPing's wrangler.jsonc for
 * the release, so a new binding or var in OpenPing reaches every tenant by
 * being in its config, with no platform change (for example the
 * second-region probe: a Durable Object, its migration, and a var).
 */
export interface BundleWorkerConfig {
  compatibilityDate: string;
  compatibilityFlags: string[];
  assetsConfig: AssetsConfig;
  vars: Record<string, string>;
  durableObjects: BundleDurableObject[];
  migrations: BundleMigration[];
}

export interface TenantBundle extends BundleWorkerConfig {
  /** OpenPing's version (package.json), recorded on the tenant row. */
  version: string;
  mainModule: string;
  modules: WorkerModule[];
  assets: BundleAsset[];
}

const MIGRATION_STEP_KEYS = ["new_sqlite_classes", "new_classes", "renamed_classes", "deleted_classes", "transferred_classes"] as const;

/**
 * Reads a bundle's worker config from OpenPing's parsed wrangler config (the
 * release runner calls this on the release's wrangler.jsonc). Only what a
 * user Worker in the namespace can carry is taken: no routes, crons or
 * account-bound bindings, and plain vars as strings. The assets binding and
 * the database are the platform's (provisioning adds them per tenant).
 */
export function workerConfigFromWrangler(config: Record<string, unknown>): BundleWorkerConfig {
  const str = (v: unknown, what: string) => {
    if (typeof v !== "string" || !v) throw new PermanentError(`wrangler config: ${what} must be a string`);
    return v;
  };
  const assets = (config.assets ?? {}) as Record<string, unknown>;
  const assetsConfig: AssetsConfig = {};
  if (assets.html_handling !== undefined) assetsConfig.html_handling = assets.html_handling as AssetsConfig["html_handling"];
  if (assets.not_found_handling !== undefined) assetsConfig.not_found_handling = assets.not_found_handling as AssetsConfig["not_found_handling"];
  if (assets.run_worker_first !== undefined) assetsConfig.run_worker_first = assets.run_worker_first as AssetsConfig["run_worker_first"];
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries((config.vars ?? {}) as Record<string, unknown>)) {
    vars[name] = typeof value === "string" ? value : JSON.stringify(value);
  }
  const durable = ((config.durable_objects as { bindings?: unknown[] } | undefined)?.bindings ?? []).map((b, i) => {
    const binding = b as Record<string, unknown>;
    if (binding.script_name !== undefined) throw new PermanentError(`wrangler config: durable_objects.bindings[${i}] points at another script`);
    return { name: str(binding.name, `durable_objects.bindings[${i}].name`), className: str(binding.class_name, `durable_objects.bindings[${i}].class_name`) };
  });
  const migrations = ((config.migrations ?? []) as Record<string, unknown>[]).map((m, i) => {
    const out: BundleMigration = { tag: str(m.tag, `migrations[${i}].tag`) };
    for (const key of MIGRATION_STEP_KEYS) if (m[key] !== undefined) (out as unknown as Record<string, unknown>)[key] = m[key];
    return out;
  });
  return {
    compatibilityDate: str(config.compatibility_date, "compatibility_date"),
    compatibilityFlags: Array.isArray(config.compatibility_flags) ? config.compatibility_flags.map(String) : [],
    assetsConfig,
    vars,
    durableObjects: durable,
    migrations,
  };
}

export interface BundleSource {
  /** The bundle new tenants get: the current release. */
  current(): Promise<TenantBundle>;
}

/** A source that always answers the same bundle (tests, and local experiments). */
export class StaticBundleSource implements BundleSource {
  constructor(private readonly bundle: TenantBundle) {}
  async current(): Promise<TenantBundle> {
    return this.bundle;
  }
}

/**
 * The R2 layout the release runner writes (C1) and provisioning reads:
 *
 *   releases/current                       the current version, as plain text
 *   releases/<version>/bundle.json         BundleManifest below
 *   releases/<version>/modules/<name>      each Worker module
 *   releases/<version>/assets/<path>       each static asset (path without its leading slash)
 */
export interface BundleManifest {
  version: string;
  mainModule: string;
  compatibilityDate: string;
  compatibilityFlags: string[];
  assetsConfig: AssetsConfig;
  vars: Record<string, string>;
  /** Absent in a bundle written before Durable Objects: none. */
  durableObjects?: BundleDurableObject[];
  migrations?: BundleMigration[];
  modules: { name: string; contentType: string }[];
  assets: { path: string; contentType: string }[];
}

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

/**
 * Loaded bundles, per isolate and by version: a release is immutable, so it
 * is safe to keep, and an R2BundleSource is made per request. At most two
 * (the current release and the one before) stay in memory.
 */
const loaded = new Map<string, Promise<TenantBundle>>();

export class R2BundleSource implements BundleSource {
  constructor(private readonly bucket: R2Bucket) {}

  private async text(key: string): Promise<string> {
    const object = await this.bucket.get(key);
    if (!object) throw new PermanentError(`tenant bundle: ${key} is missing`);
    return object.text();
  }

  private async bytes(key: string): Promise<Uint8Array<ArrayBuffer>> {
    const object = await this.bucket.get(key);
    if (!object) throw new PermanentError(`tenant bundle: ${key} is missing`);
    return new Uint8Array(await object.arrayBuffer());
  }

  async current(): Promise<TenantBundle> {
    const version = (await this.text("releases/current")).trim();
    if (!VERSION_PATTERN.test(version)) throw new PermanentError("tenant bundle: releases/current is not a version");
    let bundle = loaded.get(version);
    if (!bundle) {
      if (loaded.size >= 2) loaded.delete(loaded.keys().next().value!);
      bundle = this.load(version);
      // Never keep a failure: the next sign-up tries R2 again.
      bundle.catch(() => loaded.delete(version));
      loaded.set(version, bundle);
    }
    return bundle;
  }

  private async load(version: string): Promise<TenantBundle> {
    const prefix = `releases/${version}`;
    const manifest = JSON.parse(await this.text(`${prefix}/bundle.json`)) as BundleManifest;
    if (manifest.version !== version) throw new PermanentError("tenant bundle: bundle.json names another version");
    const modules = await Promise.all(
      manifest.modules.map(async (m) => ({
        name: m.name,
        contentType: m.contentType,
        content: await this.bytes(`${prefix}/modules/${m.name}`),
      })),
    );
    const assets = await Promise.all(
      manifest.assets.map(async (a) => ({
        path: a.path,
        contentType: a.contentType,
        content: await this.bytes(`${prefix}/assets${a.path}`),
      })),
    );
    return {
      version,
      mainModule: manifest.mainModule,
      modules,
      assets,
      compatibilityDate: manifest.compatibilityDate,
      compatibilityFlags: manifest.compatibilityFlags,
      assetsConfig: manifest.assetsConfig,
      vars: manifest.vars ?? {},
      durableObjects: manifest.durableObjects ?? [],
      migrations: manifest.migrations ?? [],
    };
  }
}
