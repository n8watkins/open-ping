/**
 * Uploading a customer's OpenPing to the dispatch namespace: its static
 * assets first, then the script with its bindings, vars, secret and tags.
 *
 * The three phases are Cloudflare's direct upload flow:
 * https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/static-assets/
 *   1. register a manifest of every asset (path, hash, size);
 *   2. upload the files Cloudflare doesn't already have, bucket by bucket;
 *   3. upload the script with the completion token in `metadata.assets.jwt`.
 * Assets are deduplicated by hash across the namespace, so after the first
 * tenant of a release, step 2 usually uploads nothing.
 */

import { base64urlEncode } from "../../../src/shared/hosted-contract";
import type { BundleAsset, TenantBundle } from "../bundle";
import type { BundleMigration } from "../bundle";
import type {
  AssetManifest,
  AssetUploadPart,
  CloudflareApi,
  DurableObjectMigrationStep,
  UploadedScript,
  WorkerBinding,
  WorkerMigrations,
  WorkerObservability,
  WorkerUploadMetadata,
} from "./api";
import { PermanentError } from "../errors";

/** Cloudflare's limit on one static asset. https://developers.cloudflare.com/workers/platform/limits/#static-assets */
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
/** Workers for Platforms allows eight tags per script. */
export const MAX_SCRIPT_TAGS = 8;

function toBase64(bytes: Uint8Array): string {
  // Standard base64 (with padding), which `?base64=true` expects.
  const url = base64urlEncode(bytes).replace(/-/g, "+").replace(/_/g, "/");
  return url + "=".repeat((4 - (url.length % 4)) % 4);
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

/**
 * The manifest hash of one asset: 32 hex characters of SHA-256 over its
 * base64 contents followed by its extension, as in Cloudflare's direct
 * upload example. Any stable 32-hex hash works; this one matches the docs so
 * a file uploaded by another tool deduplicates the same way.
 */
export async function assetHash(content: Uint8Array, path: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(toBase64(content) + extensionOf(path)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** Refuses an asset path Cloudflare would reject or that could escape the asset root. */
function checkAssetPath(path: string): void {
  if (!path.startsWith("/") || path.includes("//") || path.split("/").some((s) => s === ".." || s === ".")) {
    throw new PermanentError(`tenant bundle: bad asset path ${JSON.stringify(path)}`);
  }
}

export async function buildAssetManifest(
  assets: BundleAsset[],
): Promise<{ manifest: AssetManifest; byHash: Map<string, BundleAsset> }> {
  const manifest: AssetManifest = {};
  const byHash = new Map<string, BundleAsset>();
  for (const asset of assets) {
    checkAssetPath(asset.path);
    if (asset.content.byteLength > MAX_ASSET_BYTES) throw new PermanentError(`tenant bundle: ${asset.path} is over 25 MiB`);
    const hash = await assetHash(asset.content, asset.path);
    manifest[asset.path] = { hash, size: asset.content.byteLength };
    byHash.set(hash, asset);
  }
  return { manifest, byHash };
}

/** Phases 1 and 2: resolves the completion token for the script upload. */
export async function uploadAssets(
  api: CloudflareApi,
  namespace: string,
  scriptName: string,
  assets: BundleAsset[],
): Promise<string> {
  const { manifest, byHash } = await buildAssetManifest(assets);
  const session = await api.createAssetUploadSession(namespace, scriptName, manifest);
  // Nothing new to send: the session token is already the completion token.
  if (session.buckets.length === 0) return session.jwt;
  let completion: string | null = null;
  for (const bucket of session.buckets) {
    const parts: AssetUploadPart[] = bucket.map((hash) => {
      const asset = byHash.get(hash);
      if (!asset) throw new Error(`Cloudflare asked for an asset that isn't in the manifest (${hash})`);
      return { hash, base64: toBase64(asset.content), contentType: asset.contentType };
    });
    completion = (await api.uploadAssets(session.jwt, parts)) ?? completion;
  }
  if (!completion) throw new Error("asset upload finished without a completion token");
  return completion;
}

export interface UserWorkerUpload {
  namespace: string;
  scriptName: string;
  bundle: TenantBundle;
  /** The tenant's own bindings (its D1 database), added after the assets binding. */
  bindings: WorkerBinding[];
  /** Plain vars: the bundle's own, then these on top. */
  vars: Record<string, string>;
  /** Secrets (the tenant's MASTER_KEY). Sent as `secret_text` bindings, never logged. */
  secrets: Record<string, string>;
  tags: string[];
  /**
   * The Durable Object migration tag the script already has: null for a new
   * script (provisioning), the recorded tag for an update (the release runner).
   */
  previousMigrationTag: string | null;
  /** Workers Logs' head sampling for this user Worker, 0 to 1 (TENANT_LOG_SAMPLING); 1 when absent. */
  logSampling?: number;
}

/**
 * The user Worker's observability: Workers Logs on for what the Worker
 * writes (console lines and uncaught exceptions), with invocation logs OFF
 * and query strings redacted. An invocation log records the request (its
 * URL and headers), and a customer's OpenPing gets secrets there: heartbeat
 * ping paths (/hb/<token>), magic-link and recipient tokens in query
 * strings, and Bearer API tokens in headers. Head sampling keeps or drops a
 * whole invocation, errors included, so 1 (everything) is the default and a
 * lower rate is a cost lever for later (docs/hosted/OBSERVABILITY.md).
 */
export function tenantObservability(sampling = 1): WorkerObservability {
  const rate = Number.isFinite(sampling) ? Math.min(1, Math.max(0, sampling)) : 1;
  return { enabled: true, redact_query_string: true, logs: { enabled: true, invocation_logs: false, head_sampling_rate: rate } };
}

/**
 * The migrations to send: the bundle's steps after `previousTag`, or none
 * when the script is already at the bundle's last tag.
 */
export function migrationsAfter(migrations: BundleMigration[], previousTag: string | null): WorkerMigrations | undefined {
  const tags = migrations.map((m) => m.tag);
  if (new Set(tags).size !== tags.length) throw new PermanentError("tenant bundle: duplicate migration tags");
  const from = previousTag === null ? 0 : tags.indexOf(previousTag) + 1;
  if (previousTag !== null && from === 0) throw new PermanentError(`tenant bundle: has no migration tag ${previousTag}`);
  const pending = migrations.slice(from);
  if (pending.length === 0) return undefined;
  const steps = pending.map(({ tag: _tag, ...step }): DurableObjectMigrationStep => step);
  return { ...(previousTag === null ? {} : { old_tag: previousTag }), new_tag: pending[pending.length - 1]!.tag, steps };
}

/** The script upload's metadata, built separately so it is testable without uploading. */
export function userWorkerMetadata(input: UserWorkerUpload, assetsJwt: string): WorkerUploadMetadata {
  if (input.tags.length > MAX_SCRIPT_TAGS) throw new PermanentError("too many tags for one script");
  const vars = { ...input.bundle.vars, ...input.vars };
  const names = new Set<string>(["ASSETS"]);
  const bindings: WorkerBinding[] = [{ type: "assets", name: "ASSETS" }];
  const add = (binding: WorkerBinding) => {
    if (names.has(binding.name)) throw new PermanentError(`binding ${binding.name} is set twice`);
    names.add(binding.name);
    bindings.push(binding);
  };
  for (const binding of input.bindings) add(binding);
  for (const durable of input.bundle.durableObjects) add({ type: "durable_object_namespace", name: durable.name, class_name: durable.className });
  for (const [name, text] of Object.entries(vars)) add({ type: "plain_text", name, text });
  for (const [name, text] of Object.entries(input.secrets)) add({ type: "secret_text", name, text });
  const migrations = migrationsAfter(input.bundle.migrations, input.previousMigrationTag);
  return {
    main_module: input.bundle.mainModule,
    compatibility_date: input.bundle.compatibilityDate,
    compatibility_flags: input.bundle.compatibilityFlags,
    bindings,
    tags: input.tags,
    assets: { jwt: assetsJwt, config: input.bundle.assetsConfig },
    ...(migrations ? { migrations } : {}),
    observability: tenantObservability(input.logSampling),
  };
}

/** All three phases. Idempotent: uploading the same bundle again replaces the script with an identical one. */
export async function uploadUserWorker(api: CloudflareApi, input: UserWorkerUpload): Promise<UploadedScript> {
  const jwt = await uploadAssets(api, input.namespace, input.scriptName, input.bundle.assets);
  return api.putScript(input.namespace, input.scriptName, userWorkerMetadata(input, jwt), input.bundle.modules);
}
