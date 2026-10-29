/**
 * An in-memory CloudflareApi: D1 databases, a dispatch namespace's scripts,
 * and the static assets upload flow, with the same rules the real API
 * enforces where provisioning depends on them (an upload's completion token
 * must cover every asset of its manifest, a d1 binding must name an existing
 * database, main_module must be one of the modules). Every call is recorded,
 * and any operation can be made to fail, so a test can drive provisioning
 * through each failure and retry. Same interface as HttpCloudflareApi.
 */

import {
  CloudflareApiError,
  type AssetManifest,
  type AssetUploadPart,
  type AssetUploadSession,
  type CloudflareApi,
  type D1DatabaseInfo,
  type D1ExportStatus,
  type UploadedScript,
  type WorkerModule,
  type WorkerUploadMetadata,
} from "../src/cloudflare/api";

export type FakeOperation =
  | "createDatabase"
  | "findDatabaseByName"
  | "deleteDatabase"
  | "createAssetUploadSession"
  | "uploadAssets"
  | "putScript"
  | "deleteScript"
  | "exportDatabase"
  | "getScriptMigrationTag";

export interface FakeScript {
  namespace: string;
  metadata: WorkerUploadMetadata;
  modules: WorkerModule[];
  /** The asset paths the script's completion token covered. */
  assetPaths: string[];
  /** Its Durable Object migration tag, and the classes those migrations created. */
  migrationTag: string | null;
  durableClasses: string[];
}

/** How an injected failure behaves. */
export interface FakeFailure {
  /** HTTP status of the error (0 for no answer). Default 503. */
  status?: number;
  /** "before": the call has no effect. "after": it takes effect, then the answer is lost. */
  when?: "before" | "after";
}

interface Session {
  scriptKey: string;
  manifest: AssetManifest;
  pending: Set<string>;
  completion: string;
}

export class FakeCloudflareApi implements CloudflareApi {
  readonly databases = new Map<string, D1DatabaseInfo>();
  readonly scripts = new Map<string, FakeScript>();
  /** Asset hashes Cloudflare already holds (deduplicated across the namespace). */
  readonly storedAssets = new Set<string>();
  readonly calls: { op: FakeOperation; args: unknown[] }[] = [];
  /** Hashes per upload bucket the fake hands out, to exercise more than one bucket. */
  bucketSize = 2;
  /** Polls an export takes before it completes (0: done at once); the dump is at `fake-d1-export:<id>`. */
  exportPolls = 1;
  /** The next export ends in this error instead. */
  exportError: string | null = null;
  private readonly exports = new Map<string, { databaseId: string; polls: number; error: string | null }>();
  /** Called after a script upload or delete takes effect (to register a fake user Worker). */
  onScriptChange?: (scriptName: string, script: FakeScript | null) => void;

  private readonly failures = new Map<FakeOperation, FakeFailure[]>();
  private readonly alwaysFailing = new Map<FakeOperation, FakeFailure>();
  private readonly sessions = new Map<string, Session>();
  private readonly completions = new Map<string, { scriptKey: string; paths: string[] }>();
  private seq = 0;

  /** The next call of `op` fails (repeat to fail several in a row). */
  failNext(op: FakeOperation, failure: FakeFailure = {}): this {
    const list = this.failures.get(op) ?? [];
    list.push(failure);
    this.failures.set(op, list);
    return this;
  }

  /** Every call of `op` fails until `heal(op)`. */
  failAlways(op: FakeOperation, failure: FakeFailure = {}): this {
    this.alwaysFailing.set(op, failure);
    return this;
  }

  heal(op: FakeOperation): this {
    this.alwaysFailing.delete(op);
    this.failures.delete(op);
    return this;
  }

  count(op: FakeOperation): number {
    return this.calls.filter((c) => c.op === op).length;
  }

  scriptIn(namespace: string, scriptName: string): FakeScript | undefined {
    return this.scripts.get(`${namespace}/${scriptName}`);
  }

  private id(prefix: string): string {
    this.seq++;
    return `${prefix}${String(this.seq).padStart(8, "0")}`;
  }

  /** Records the call and runs `effect`, failing before or after it when told to. */
  private async run<T>(op: FakeOperation, args: unknown[], effect: () => T): Promise<T> {
    this.calls.push({ op, args });
    const queued = this.failures.get(op);
    const failure = queued?.shift() ?? this.alwaysFailing.get(op);
    const error = failure ? new CloudflareApiError(`fake.${op}`, failure.status ?? 503, [{ code: 10000, message: "injected" }]) : null;
    if (error && failure?.when !== "after") throw error;
    const result = effect();
    if (error) throw error;
    return result;
  }

  createDatabase(name: string): Promise<D1DatabaseInfo> {
    return this.run("createDatabase", [name], () => {
      if ([...this.databases.values()].some((db) => db.name === name)) {
        throw new CloudflareApiError("fake.createDatabase", 400, [{ code: 7502, message: "A database with that name already exists" }]);
      }
      const db = { id: this.id("d1-"), name };
      this.databases.set(db.id, db);
      return db;
    });
  }

  findDatabaseByName(name: string): Promise<D1DatabaseInfo | null> {
    return this.run("findDatabaseByName", [name], () => [...this.databases.values()].find((db) => db.name === name) ?? null);
  }

  deleteDatabase(id: string): Promise<boolean> {
    return this.run("deleteDatabase", [id], () => this.databases.delete(id));
  }

  createAssetUploadSession(namespace: string, scriptName: string, manifest: AssetManifest): Promise<AssetUploadSession> {
    return this.run("createAssetUploadSession", [namespace, scriptName, manifest], () => {
      for (const entry of Object.values(manifest)) {
        if (!/^[0-9a-f]{32}$/.test(entry.hash)) throw new CloudflareApiError("fake.session", 400, [{ code: 1, message: "bad hash" }]);
      }
      const scriptKey = `${namespace}/${scriptName}`;
      const missing = [...new Set(Object.values(manifest).map((e) => e.hash))].filter((h) => !this.storedAssets.has(h));
      const completion = this.id("complete-");
      const jwt = missing.length ? this.id("upload-") : completion;
      this.sessions.set(jwt, { scriptKey, manifest, pending: new Set(missing), completion });
      this.completions.set(completion, { scriptKey, paths: Object.keys(manifest) });
      const buckets: string[][] = [];
      for (let i = 0; i < missing.length; i += this.bucketSize) buckets.push(missing.slice(i, i + this.bucketSize));
      return { jwt, buckets };
    });
  }

  uploadAssets(uploadJwt: string, files: AssetUploadPart[]): Promise<string | null> {
    return this.run("uploadAssets", [uploadJwt, files.map((f) => f.hash)], () => {
      const session = this.sessions.get(uploadJwt);
      if (!session) throw new CloudflareApiError("fake.upload", 401, [{ code: 10001, message: "bad upload token" }]);
      for (const file of files) {
        if (!session.pending.has(file.hash)) throw new CloudflareApiError("fake.upload", 400, [{ code: 1, message: "unexpected hash" }]);
        atob(file.base64); // throws for anything that isn't base64
        session.pending.delete(file.hash);
        this.storedAssets.add(file.hash);
      }
      return session.pending.size === 0 ? session.completion : null;
    });
  }

  putScript(namespace: string, scriptName: string, metadata: WorkerUploadMetadata, modules: WorkerModule[]): Promise<UploadedScript> {
    return this.run("putScript", [namespace, scriptName, metadata, modules.map((m) => m.name)], () => {
      const key = `${namespace}/${scriptName}`;
      const refuse = (message: string) => {
        throw new CloudflareApiError("fake.putScript", 400, [{ code: 10021, message }]);
      };
      if (!modules.some((m) => m.name === metadata.main_module)) refuse("main_module not uploaded");
      for (const binding of metadata.bindings) {
        if (binding.type === "d1" && !this.databases.has(binding.database_id)) refuse(`no database ${binding.database_id}`);
      }
      if ((metadata.tags?.length ?? 0) > 8) refuse("too many tags");
      let assetPaths: string[] = [];
      if (metadata.assets) {
        const completion = this.completions.get(metadata.assets.jwt);
        if (!completion || completion.scriptKey !== key) refuse("assets jwt is not a completion token for this script");
        assetPaths = completion!.paths;
      }
      // Durable Object migrations, as Cloudflare checks them: old_tag must be
      // the script's current tag, and every bound class must exist after them.
      const existing = this.scripts.get(key);
      const currentTag = existing?.migrationTag ?? null;
      let migrationTag = currentTag;
      const classes = new Set(existing?.durableClasses ?? []);
      if (metadata.migrations) {
        if ((metadata.migrations.old_tag ?? null) !== currentTag) refuse(`migration precondition failed: script is at ${currentTag}`);
        for (const step of metadata.migrations.steps) {
          for (const c of step.new_sqlite_classes ?? []) classes.add(c);
          for (const c of step.deleted_classes ?? []) classes.delete(c);
        }
        migrationTag = metadata.migrations.new_tag;
      }
      for (const binding of metadata.bindings) {
        if (binding.type === "durable_object_namespace" && !classes.has(binding.class_name)) refuse(`no Durable Object class ${binding.class_name}`);
      }
      const script: FakeScript = { namespace, metadata, modules, assetPaths, migrationTag, durableClasses: [...classes] };
      this.scripts.set(key, script);
      this.onScriptChange?.(scriptName, script);
      return { id: scriptName, etag: this.id("etag-"), hasAssets: assetPaths.length > 0 };
    });
  }

  getScriptMigrationTag(namespace: string, scriptName: string): Promise<string | null> {
    return this.run("getScriptMigrationTag", [namespace, scriptName], () => {
      const script = this.scripts.get(`${namespace}/${scriptName}`);
      if (!script) throw new CloudflareApiError("fake.getScript", 404, [{ code: 10007, message: "script not found" }]);
      return script.migrationTag;
    });
  }

  exportDatabase(databaseId: string, bookmark?: string): Promise<D1ExportStatus> {
    return this.run("exportDatabase", [databaseId, bookmark ?? null], (): D1ExportStatus => {
      if (!this.databases.has(databaseId)) throw new CloudflareApiError("fake.export", 404, [{ code: 7404, message: "database not found" }]);
      if (!bookmark) {
        const id = this.id("bm-");
        this.exports.set(id, { databaseId, polls: 0, error: this.exportError });
        this.exportError = null;
        return { status: "active", bookmark: id };
      }
      const job = this.exports.get(bookmark);
      if (!job || job.databaseId !== databaseId) throw new CloudflareApiError("fake.export", 400, [{ code: 7500, message: "unknown bookmark" }]);
      if (job.error) return { status: "error", bookmark, error: job.error };
      if (job.polls++ < this.exportPolls - 1) return { status: "active", bookmark };
      return { status: "complete", bookmark, signedUrl: `https://fake-d1-export.invalid/${databaseId}/${bookmark}.sql`, filename: `${databaseId}.sql` };
    });
  }

  deleteScript(namespace: string, scriptName: string): Promise<boolean> {
    return this.run("deleteScript", [namespace, scriptName], () => {
      const existed = this.scripts.delete(`${namespace}/${scriptName}`);
      if (existed) this.onScriptChange?.(scriptName, null);
      return existed;
    });
  }
}
