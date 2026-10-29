/**
 * The slice of the Cloudflare API the platform uses to provision a customer's
 * OpenPing: one D1 database and one user Worker in the dispatch namespace per
 * tenant.
 *
 * `CloudflareApi` is the interface; `HttpCloudflareApi` (./http.ts) is the
 * real client and `FakeCloudflareApi` (test/fake-cloudflare.ts) the in-memory
 * one the tests use, so no test ever calls Cloudflare. The provisioner
 * (../provisioning.ts) only ever sees the interface.
 *
 * Shapes checked against Cloudflare's API reference on 2026-10-28; each
 * method cites its page.
 */

/** A D1 database, as the API describes it. */
export interface D1DatabaseInfo {
  /** The database's id (`uuid` in the API), which a `d1` binding names as `database_id`. */
  id: string;
  name: string;
}

/**
 * A file the user Worker's static assets manifest lists. The key of the
 * manifest is the path with a leading slash ("/index.html").
 */
export interface AssetManifestEntry {
  /** 32 hex characters identifying the content (./assets.ts, assetHash). */
  hash: string;
  size: number;
}

export type AssetManifest = Record<string, AssetManifestEntry>;

/** The answer to "start an assets upload session". */
export interface AssetUploadSession {
  /** Upload token (valid one hour), or already the completion token when `buckets` is empty. */
  jwt: string;
  /** Groups of hashes to upload together, one request per group. Files Cloudflare already has are left out. */
  buckets: string[][];
}

/** One bucket's files, keyed by hash, contents base64-encoded. */
export interface AssetUploadPart {
  hash: string;
  base64: string;
  /** Served as the file's Content-Type. */
  contentType: string;
}

/** A binding on the uploaded user Worker (multipart upload metadata, `bindings`). */
export type WorkerBinding =
  | { type: "d1"; name: string; database_id: string }
  | { type: "plain_text"; name: string; text: string }
  | { type: "secret_text"; name: string; text: string }
  | { type: "assets"; name: string }
  /** A Durable Object class the script itself exports (no script_name: this script). */
  | { type: "durable_object_namespace"; name: string; class_name: string };

/**
 * One Durable Object class migration step, as in wrangler's `migrations`.
 * https://developers.cloudflare.com/workers/wrangler/configuration/#migrations
 */
export interface DurableObjectMigrationStep {
  new_sqlite_classes?: string[];
  new_classes?: string[];
  renamed_classes?: { from: string; to: string }[];
  deleted_classes?: string[];
  transferred_classes?: { from: string; from_script: string; to: string }[];
}

/**
 * The `migrations` of a script upload (Script Upload API only): the steps
 * after `old_tag` (the script's current tag; absent for a new script), ending
 * at `new_tag`. Cloudflare refuses the upload when `old_tag` isn't the
 * script's current tag, which is what keeps a migration from running twice.
 */
export interface WorkerMigrations {
  old_tag?: string;
  new_tag: string;
  steps: DurableObjectMigrationStep[];
}

/** `assets.config` of the upload metadata: how the static files are served. */
export interface AssetsConfig {
  html_handling?: "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash" | "none";
  not_found_handling?: "single-page-application" | "404-page" | "none";
  /** true, false, or route patterns that reach the Worker before assets ("!/assets/*" excludes). */
  run_worker_first?: boolean | string[];
  /**
   * The contents of the assets' `_headers` and `_redirects` files, which are
   * sent here rather than uploaded as assets (as Wrangler does).
   * https://developers.cloudflare.com/workers/static-assets/headers/
   */
  _headers?: string;
  _redirects?: string;
}

/**
 * The `metadata` part of a script upload.
 * https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/
 */
export interface WorkerUploadMetadata {
  main_module: string;
  compatibility_date: string;
  compatibility_flags?: string[];
  bindings: WorkerBinding[];
  /** At most eight per script (Workers for Platforms tags). */
  tags?: string[];
  assets?: { jwt: string; config?: AssetsConfig };
  migrations?: WorkerMigrations;
  /**
   * Workers Logs for the user Worker, set per upload (Workers for Platforms
   * observability: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/observability/).
   * Its logs land in the account's `cloudflare-workers` dataset with
   * `$metadata.service` set to the script name (t-<tenant id>).
   */
  observability?: WorkerObservability;
}

export interface WorkerObservability {
  enabled: boolean;
  logs?: {
    enabled: boolean;
    /** One log per invocation (request, cron, queue) besides the console lines. */
    invocation_logs: boolean;
    /** 0 to 1: the share of invocations logged, all of each one's lines or none. */
    head_sampling_rate: number;
  };
}

/** One module part of a script upload. */
export interface WorkerModule {
  /** The part's name and filename; `main_module` names one of these. */
  name: string;
  content: string | Uint8Array<ArrayBuffer>;
  /** "application/javascript+module" for an ES module; "application/source-map", "application/wasm", "text/plain", ... */
  contentType: string;
}

export interface UploadedScript {
  /** The script name. */
  id: string;
  etag: string | null;
  hasAssets: boolean;
}

/**
 * One poll of a D1 export. `active` while it runs (poll again with the
 * bookmark); `complete` with a signed URL to the SQL dump, valid one hour;
 * `error` with D1's reason.
 */
export type D1ExportStatus =
  | { status: "active"; bookmark: string }
  | { status: "complete"; bookmark: string; signedUrl: string; filename: string }
  | { status: "error"; bookmark: string | null; error: string };

export interface CloudflareApi {
  /**
   * POST /accounts/{account_id}/d1/database/{database_id}/export with
   * output_format "polling": starts an export (no bookmark) or polls one
   * (the bookmark the start answered). An export nobody polls is cancelled.
   * https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/
   */
  exportDatabase(databaseId: string, bookmark?: string): Promise<D1ExportStatus>;

  /**
   * POST /accounts/{account_id}/d1/database
   * https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/create/
   */
  createDatabase(name: string): Promise<D1DatabaseInfo>;

  /**
   * GET /accounts/{account_id}/d1/database?name=..., filtered to an exact match
   * (the API's `name` is a search). Null when there is none.
   * https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/list/
   */
  findDatabaseByName(name: string): Promise<D1DatabaseInfo | null>;

  /**
   * DELETE /accounts/{account_id}/d1/database/{database_id}. Resolves false
   * when the database was already gone, so a rollback can run twice.
   */
  deleteDatabase(id: string): Promise<boolean>;

  /**
   * POST /accounts/{account_id}/workers/dispatch/namespaces/{namespace}/scripts/{script}/assets-upload-session
   * https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/static-assets/
   */
  createAssetUploadSession(namespace: string, scriptName: string, manifest: AssetManifest): Promise<AssetUploadSession>;

  /**
   * POST /accounts/{account_id}/workers/assets/upload?base64=true with the
   * session's upload token as the bearer. Resolves the completion token once
   * the last bucket is in (HTTP 201), otherwise null.
   * https://developers.cloudflare.com/workers/static-assets/direct-upload/
   */
  uploadAssets(uploadJwt: string, files: AssetUploadPart[]): Promise<string | null>;

  /**
   * PUT /accounts/{account_id}/workers/dispatch/namespaces/{namespace}/scripts/{script}
   * as multipart/form-data: the `metadata` JSON part and one part per module.
   * A first upload is live when this resolves (synchronous uploads, 2025-02-20).
   * https://developers.cloudflare.com/api/resources/workers_for_platforms/subresources/dispatch/subresources/namespaces/subresources/scripts/methods/update/
   */
  putScript(namespace: string, scriptName: string, metadata: WorkerUploadMetadata, modules: WorkerModule[]): Promise<UploadedScript>;

  /**
   * DELETE /accounts/{account_id}/workers/dispatch/namespaces/{namespace}/scripts/{script}?force=true.
   * Resolves false when the script was already gone.
   * https://developers.cloudflare.com/api/resources/workers_for_platforms/subresources/dispatch/subresources/namespaces/subresources/scripts/methods/delete/
   */
  deleteScript(namespace: string, scriptName: string): Promise<boolean>;

  /**
   * GET /accounts/{account_id}/workers/dispatch/namespaces/{namespace}/scripts/{script}:
   * the Durable Object migration tag most recently applied to the script
   * (`result.script.migration_tag`), or null for none.
   * https://developers.cloudflare.com/api/resources/workers_for_platforms/subresources/dispatch/subresources/namespaces/subresources/scripts/methods/get/
   */
  getScriptMigrationTag(namespace: string, scriptName: string): Promise<string | null>;
}

/** One entry of the API's `errors` array. */
export interface CloudflareErrorDetail {
  code: number;
  message: string;
}

/**
 * A failed Cloudflare API call. The message names the operation and the
 * API's error codes, never a token, a secret or a request body.
 */
export class CloudflareApiError extends Error {
  constructor(
    readonly operation: string,
    /** HTTP status, or 0 when the request never got an answer. */
    readonly status: number,
    readonly errors: CloudflareErrorDetail[] = [],
  ) {
    const detail = errors.length ? errors.map((e) => `${e.code} ${e.message}`).join("; ") : "no details";
    super(`Cloudflare API ${operation} failed (${status || "network"}): ${detail}`);
    this.name = "CloudflareApiError";
  }

  /** Worth trying again later: no answer, rate limited, or Cloudflare's own failure. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }

  get notFound(): boolean {
    return this.status === 404;
  }
}
