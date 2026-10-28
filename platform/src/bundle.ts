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

import type { AssetsConfig, WorkerModule } from "./cloudflare/api";

/** One static asset of the SPA. */
export interface BundleAsset {
  /** With a leading slash, as served: "/index.html", "/assets/app-1a2b.js". */
  path: string;
  content: Uint8Array<ArrayBuffer>;
  contentType: string;
}

export interface TenantBundle {
  /** OpenPing's version (package.json), recorded on the tenant row. */
  version: string;
  mainModule: string;
  modules: WorkerModule[];
  assets: BundleAsset[];
  compatibilityDate: string;
  compatibilityFlags: string[];
  /** How the assets are served, from OpenPing's wrangler.jsonc `assets`. */
  assetsConfig: AssetsConfig;
  /**
   * Plain vars the release sets on every tenant (for example WORKERS_PLAN).
   * The platform's own vars (HOSTED_ENV) are added on top and always win.
   */
  vars: Record<string, string>;
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
    if (!object) throw new Error(`tenant bundle: ${key} is missing`);
    return object.text();
  }

  private async bytes(key: string): Promise<Uint8Array<ArrayBuffer>> {
    const object = await this.bucket.get(key);
    if (!object) throw new Error(`tenant bundle: ${key} is missing`);
    return new Uint8Array(await object.arrayBuffer());
  }

  async current(): Promise<TenantBundle> {
    const version = (await this.text("releases/current")).trim();
    if (!VERSION_PATTERN.test(version)) throw new Error("tenant bundle: releases/current is not a version");
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
    if (manifest.version !== version) throw new Error("tenant bundle: bundle.json names another version");
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
    };
  }
}
