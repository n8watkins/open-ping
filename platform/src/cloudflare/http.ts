/**
 * The real Cloudflare API client (`CloudflareApi` over HTTPS).
 *
 * Every call goes through one `fetch` the caller can inject, so the tests
 * check the exact requests this client builds without any network; in
 * production it is the Worker's global fetch. The token is sent only to
 * api.cloudflare.com and never appears in an error or a log line.
 */

import {
  CloudflareApiError,
  type AssetManifest,
  type AssetUploadPart,
  type AssetUploadSession,
  type CloudflareApi,
  type CloudflareErrorDetail,
  type D1DatabaseInfo,
  type UploadedScript,
  type WorkerModule,
  type WorkerUploadMetadata,
} from "./api";

export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

export interface HttpCloudflareApiOptions {
  accountId: string;
  /** CF_API_TOKEN: Workers Scripts Write and D1 Write on this account (README, owner setup). */
  apiToken: string;
  fetch?: typeof fetch;
  /** Per-request timeout; a timeout counts as "no answer" (retryable). */
  timeoutMs?: number;
}

/** The API's envelope: `{ success, errors, messages, result }`. */
interface Envelope<T> {
  success?: boolean;
  errors?: CloudflareErrorDetail[];
  result?: T;
}

interface D1Result {
  uuid: string;
  name: string;
}

function errorDetails(body: unknown): CloudflareErrorDetail[] {
  const errors = (body as Envelope<unknown> | null)?.errors;
  if (!Array.isArray(errors)) return [];
  return errors
    .filter((e): e is CloudflareErrorDetail => !!e && typeof e === "object")
    .map((e) => ({ code: Number(e.code) || 0, message: String(e.message ?? "").slice(0, 200) }));
}

export class HttpCloudflareApi implements CloudflareApi {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpCloudflareApiOptions) {
    if (!/^[0-9a-f]{32}$/.test(options.accountId)) throw new Error("CF_ACCOUNT_ID must be the 32 hex character account id");
    if (!options.apiToken) throw new Error("CF_API_TOKEN is not set");
    // Called unbound: a bare reference to the global fetch throws "Illegal invocation" in workerd.
    const f = options.fetch ?? fetch;
    this.fetcher = (input, init) => f(input, init);
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private account(path: string): string {
    return `${CLOUDFLARE_API_BASE}/accounts/${this.options.accountId}${path}`;
  }

  private script(namespace: string, scriptName: string, suffix = ""): string {
    return this.account(
      `/workers/dispatch/namespaces/${encodeURIComponent(namespace)}/scripts/${encodeURIComponent(scriptName)}${suffix}`,
    );
  }

  /**
   * One API call. Resolves the parsed body and status; rejects with
   * CloudflareApiError for no answer or for a status outside `ok` (by default
   * 2xx), with the API's error codes.
   */
  private async call<T>(
    operation: string,
    url: string,
    init: { method: string; body?: BodyInit; json?: unknown; bearer?: string },
    ok: (status: number) => boolean = (s) => s >= 200 && s < 300,
  ): Promise<{ status: number; body: Envelope<T> | null }> {
    const headers = new Headers({ authorization: `Bearer ${init.bearer ?? this.options.apiToken}` });
    let body = init.body;
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    let res: Response;
    try {
      res = await this.fetcher(url, { method: init.method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      // Network failure or timeout: nothing about the request is worth logging.
      throw new CloudflareApiError(operation, 0);
    }
    let parsed: Envelope<T> | null = null;
    const text = await res.text();
    if (text) {
      try {
        parsed = JSON.parse(text) as Envelope<T>;
      } catch {
        parsed = null;
      }
    }
    if (!ok(res.status)) throw new CloudflareApiError(operation, res.status, errorDetails(parsed));
    return { status: res.status, body: parsed };
  }

  private static result<T>(operation: string, status: number, body: Envelope<T> | null): T {
    if (!body || body.success === false || body.result === undefined || body.result === null) {
      throw new CloudflareApiError(operation, status, errorDetails(body));
    }
    return body.result;
  }

  async createDatabase(name: string): Promise<D1DatabaseInfo> {
    const op = "d1.create";
    const { status, body } = await this.call<D1Result>(op, this.account("/d1/database"), { method: "POST", json: { name } });
    const db = HttpCloudflareApi.result(op, status, body);
    return { id: db.uuid, name: db.name };
  }

  async findDatabaseByName(name: string): Promise<D1DatabaseInfo | null> {
    const op = "d1.list";
    const url = `${this.account("/d1/database")}?name=${encodeURIComponent(name)}&per_page=100`;
    const { status, body } = await this.call<D1Result[]>(op, url, { method: "GET" });
    const list = HttpCloudflareApi.result(op, status, body);
    const match = Array.isArray(list) ? list.find((db) => db.name === name) : undefined;
    return match ? { id: match.uuid, name: match.name } : null;
  }

  async deleteDatabase(id: string): Promise<boolean> {
    const { status } = await this.call(
      "d1.delete",
      this.account(`/d1/database/${encodeURIComponent(id)}`),
      { method: "DELETE" },
      (s) => (s >= 200 && s < 300) || s === 404,
    );
    return status !== 404;
  }

  async createAssetUploadSession(namespace: string, scriptName: string, manifest: AssetManifest): Promise<AssetUploadSession> {
    const op = "assets.session";
    const { status, body } = await this.call<{ jwt?: string; buckets?: string[][] }>(
      op,
      this.script(namespace, scriptName, "/assets-upload-session"),
      { method: "POST", json: { manifest } },
    );
    const result = HttpCloudflareApi.result(op, status, body);
    if (typeof result.jwt !== "string") throw new CloudflareApiError(op, status);
    return { jwt: result.jwt, buckets: Array.isArray(result.buckets) ? result.buckets : [] };
  }

  async uploadAssets(uploadJwt: string, files: AssetUploadPart[]): Promise<string | null> {
    const op = "assets.upload";
    // One form field per file, named by its hash, holding the base64 contents;
    // the part's type is served as the file's Content-Type (direct upload docs).
    const form = new FormData();
    for (const file of files) form.append(file.hash, new File([file.base64], file.hash, { type: file.contentType }));
    const { status, body } = await this.call<{ jwt?: string }>(
      op,
      this.account("/workers/assets/upload?base64=true"),
      { method: "POST", body: form, bearer: uploadJwt },
    );
    // 201 with a jwt once every file of the manifest has arrived; 200 before that.
    const jwt = body?.result?.jwt;
    return status === 201 && typeof jwt === "string" ? jwt : null;
  }

  async putScript(
    namespace: string,
    scriptName: string,
    metadata: WorkerUploadMetadata,
    modules: WorkerModule[],
  ): Promise<UploadedScript> {
    const op = "script.upload";
    if (!modules.some((m) => m.name === metadata.main_module)) throw new Error("main_module is not one of the modules");
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    for (const m of modules) form.append(m.name, new File([m.content], m.name, { type: m.contentType }));
    const { status, body } = await this.call<{ id?: string; etag?: string; has_assets?: boolean }>(
      op,
      this.script(namespace, scriptName),
      { method: "PUT", body: form },
    );
    const result = HttpCloudflareApi.result(op, status, body);
    return { id: result.id ?? scriptName, etag: result.etag ?? null, hasAssets: result.has_assets === true };
  }

  async deleteScript(namespace: string, scriptName: string): Promise<boolean> {
    const { status } = await this.call(
      "script.delete",
      this.script(namespace, scriptName, "?force=true"),
      { method: "DELETE" },
      (s) => (s >= 200 && s < 300) || s === 404,
    );
    return status !== 404;
  }
}
