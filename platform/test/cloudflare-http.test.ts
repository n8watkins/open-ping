import { describe, expect, it } from "vitest";

import { CloudflareApiError } from "../src/cloudflare/api";
import { CLOUDFLARE_API_BASE, HttpCloudflareApi } from "../src/cloudflare/http";
import { assetHash, buildAssetManifest, migrationsAfter, uploadUserWorker, userWorkerMetadata, type UserWorkerUpload } from "../src/cloudflare/upload";
import { workerConfigFromWrangler, type TenantBundle } from "../src/bundle";
import { FakeCloudflareApi } from "./fake-cloudflare";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "test-token-never-real";
const ACC = `${CLOUDFLARE_API_BASE}/accounts/${ACCOUNT}`;

interface Recorded {
  url: string;
  method: string;
  headers: Headers;
  request: Request;
}

/** A fetch that records each request and answers from `respond`. */
function recorder(respond: (req: Request) => Response | Promise<Response>) {
  const seen: Recorded[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push({ url: request.url, method: request.method, headers: request.headers, request: request.clone() });
    return respond(request);
  }) as typeof fetch;
  return { seen, api: new HttpCloudflareApi({ accountId: ACCOUNT, apiToken: TOKEN, fetch: fetcher }) };
}

const ok = (result: unknown, status = 200) => Response.json({ success: true, errors: [], messages: [], result }, { status });
const fail = (status: number, code: number, message: string) =>
  Response.json({ success: false, errors: [{ code, message }], messages: [], result: null }, { status });

describe("HttpCloudflareApi requests", () => {
  it("refuses to start without a real account id or a token", () => {
    expect(() => new HttpCloudflareApi({ accountId: "acme", apiToken: TOKEN })).toThrow(/CF_ACCOUNT_ID/);
    expect(() => new HttpCloudflareApi({ accountId: ACCOUNT, apiToken: "" })).toThrow(/CF_API_TOKEN/);
  });

  it("creates a D1 database with POST /d1/database and maps uuid to id", async () => {
    const { seen, api } = recorder(() => ok({ uuid: "3f0b-uuid", name: "openping-t-x", version: "production" }));
    expect(await api.createDatabase("openping-t-x")).toEqual({ id: "3f0b-uuid", name: "openping-t-x" });
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${ACC}/d1/database`);
    expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]!.headers.get("content-type")).toBe("application/json");
    expect(await seen[0]!.request.json()).toEqual({ name: "openping-t-x" });
  });

  it("finds a database by exact name only (the API's name filter is a search)", async () => {
    const { seen, api } = recorder(() =>
      ok([
        { uuid: "a", name: "openping-t-abc-old" },
        { uuid: "b", name: "openping-t-abc" },
      ]),
    );
    expect(await api.findDatabaseByName("openping-t-abc")).toEqual({ id: "b", name: "openping-t-abc" });
    expect(seen[0]!.url).toBe(`${ACC}/d1/database?name=openping-t-abc&per_page=100`);
    const none = recorder(() => ok([{ uuid: "a", name: "openping-t-abc-old" }]));
    expect(await none.api.findDatabaseByName("openping-t-abc")).toBeNull();
  });

  it("deletes a database, treating 404 as already gone", async () => {
    const gone = recorder(() => fail(404, 7404, "not found"));
    expect(await gone.api.deleteDatabase("db-1")).toBe(false);
    expect(gone.seen[0]!.method).toBe("DELETE");
    expect(gone.seen[0]!.url).toBe(`${ACC}/d1/database/db-1`);
    const done = recorder(() => ok(null));
    expect(await done.api.deleteDatabase("db-1")).toBe(true);
  });

  it("opens an assets upload session on the namespace script with the manifest", async () => {
    const { seen, api } = recorder(() => ok({ jwt: "upload-jwt", buckets: [["h1"]] }));
    const manifest = { "/index.html": { hash: "0".repeat(32), size: 12 } };
    expect(await api.createAssetUploadSession("openping-tenants", "t-abc", manifest)).toEqual({ jwt: "upload-jwt", buckets: [["h1"]] });
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe(`${ACC}/workers/dispatch/namespaces/openping-tenants/scripts/t-abc/assets-upload-session`);
    expect(await seen[0]!.request.json()).toEqual({ manifest });
  });

  it("uploads assets as base64 form fields named by hash, with the upload token as the bearer", async () => {
    const { seen, api } = recorder(() => ok({ jwt: "completion-jwt" }, 201));
    const done = await api.uploadAssets("upload-jwt", [{ hash: "a".repeat(32), base64: "aGk=", contentType: "text/html" }]);
    expect(done).toBe("completion-jwt");
    expect(seen[0]!.url).toBe(`${ACC}/workers/assets/upload?base64=true`);
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer upload-jwt");
    expect(seen[0]!.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
    const form = await seen[0]!.request.formData();
    const part = form.get("a".repeat(32)) as File;
    expect(part.type).toBe("text/html");
    expect(await part.text()).toBe("aGk=");

    // A 200 means more buckets are still to come.
    const partial = recorder(() => ok({}));
    expect(await partial.api.uploadAssets("upload-jwt", [{ hash: "b".repeat(32), base64: "", contentType: "text/css" }])).toBeNull();
  });

  it("uploads a script as multipart: the metadata JSON and each module with its type", async () => {
    const { seen, api } = recorder(() => ok({ id: "t-abc", etag: "e1", has_assets: true }));
    const metadata = {
      main_module: "index.js",
      compatibility_date: "2024-12-30",
      bindings: [{ type: "d1" as const, name: "DB", database_id: "db-1" }],
      tags: ["openping"],
    };
    const result = await api.putScript("openping-tenants", "t-abc", metadata, [
      { name: "index.js", content: "export default {}", contentType: "application/javascript+module" },
      { name: "index.js.map", content: "{}", contentType: "application/source-map" },
    ]);
    expect(result).toEqual({ id: "t-abc", etag: "e1", hasAssets: true });
    expect(seen[0]!.method).toBe("PUT");
    expect(seen[0]!.url).toBe(`${ACC}/workers/dispatch/namespaces/openping-tenants/scripts/t-abc`);
    const form = await seen[0]!.request.formData();
    const meta = form.get("metadata") as File;
    expect(meta.type).toBe("application/json");
    expect(JSON.parse(await meta.text())).toEqual(metadata);
    const main = form.get("index.js") as File;
    expect(main.name).toBe("index.js");
    expect(main.type).toBe("application/javascript+module");
    expect(await main.text()).toBe("export default {}");
    expect((form.get("index.js.map") as File).type).toBe("application/source-map");
  });

  it("refuses a script whose main module isn't uploaded, before calling anything", async () => {
    const { seen, api } = recorder(() => ok({}));
    await expect(
      api.putScript("ns", "t-abc", { main_module: "main.js", compatibility_date: "2024-12-30", bindings: [] }, [
        { name: "index.js", content: "", contentType: "application/javascript+module" },
      ]),
    ).rejects.toThrow(/main_module/);
    expect(seen).toHaveLength(0);
  });

  it("deletes a script with force, treating 404 as already gone", async () => {
    const { seen, api } = recorder(() => fail(404, 10007, "workers.api.error.script_not_found"));
    expect(await api.deleteScript("openping-tenants", "t-abc")).toBe(false);
    expect(seen[0]!.method).toBe("DELETE");
    expect(seen[0]!.url).toBe(`${ACC}/workers/dispatch/namespaces/openping-tenants/scripts/t-abc?force=true`);
  });
});

describe("HttpCloudflareApi errors", () => {
  it("carries the status and Cloudflare's error codes, and knows what is worth retrying", async () => {
    const cases: [number, boolean][] = [
      [400, false],
      [403, false],
      [408, true],
      [429, true],
      [500, true],
      [503, true],
    ];
    for (const [status, retryable] of cases) {
      const { api } = recorder(() => fail(status, 10000, "Authentication error"));
      const error = (await api.createDatabase("x").catch((e) => e)) as CloudflareApiError;
      expect(error).toBeInstanceOf(CloudflareApiError);
      expect(error.status).toBe(status);
      expect(error.errors).toEqual([{ code: 10000, message: "Authentication error" }]);
      expect(error.retryable, String(status)).toBe(retryable);
      expect(error.message).toBe(`Cloudflare API d1.create failed (${status}): 10000 Authentication error`);
    }
  });

  it("treats no answer as retryable, and never puts the token in a message", async () => {
    const { api } = recorder(() => {
      throw new TypeError(`connect failed with ${TOKEN}`);
    });
    const error = (await api.deleteScript("ns", "t-abc").catch((e) => e)) as CloudflareApiError;
    expect(error.status).toBe(0);
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain(TOKEN);
  });

  it("refuses a 200 that says success: false or has no result", async () => {
    const { api } = recorder(() => Response.json({ success: false, errors: [{ code: 7500, message: "bad" }] }));
    await expect(api.createDatabase("x")).rejects.toThrow(/7500 bad/);
    const empty = recorder(() => new Response("not json", { status: 200 }));
    await expect(empty.api.createDatabase("x")).rejects.toBeInstanceOf(CloudflareApiError);
  });
});

const text = (s: string) => new Uint8Array(new TextEncoder().encode(s));

const BUNDLE: TenantBundle = {
  version: "1.2.3",
  mainModule: "index.js",
  modules: [{ name: "index.js", content: "export default {}", contentType: "application/javascript+module" }],
  assets: [
    { path: "/index.html", content: text("<h1>hi</h1>"), contentType: "text/html" },
    { path: "/assets/a.js", content: text("1"), contentType: "text/javascript" },
    { path: "/assets/b.js", content: text("2"), contentType: "text/javascript" },
  ],
  compatibilityDate: "2024-12-30",
  compatibilityFlags: ["nodejs_compat"],
  assetsConfig: { not_found_handling: "none" },
  vars: { WORKERS_PLAN: "paid", HOSTED_MODE: "0" },
  durableObjects: [],
  migrations: [],
};

function upload(overrides: Partial<UserWorkerUpload> = {}): UserWorkerUpload {
  return {
    namespace: "ns",
    scriptName: "t-abc",
    bundle: BUNDLE,
    bindings: [{ type: "d1", name: "DB", database_id: "db-1" }],
    vars: { HOSTED_MODE: "1", TENANT_ID: "abc" },
    secrets: { MASTER_KEY: "secret" },
    tags: ["openping"],
    previousMigrationTag: null,
    ...overrides,
  };
}

describe("uploading a user Worker", () => {
  it("hashes an asset as the docs do: SHA-256 of base64 contents plus extension, 32 hex characters", async () => {
    // sha256("PGgxPmhpPC9oMT4=" + "html"), computed independently.
    const expected = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("PGgxPmhpPC9oMT4=html"))),
      (b) => b.toString(16).padStart(2, "0"),
    )
      .join("")
      .slice(0, 32);
    expect(await assetHash(text("<h1>hi</h1>"), "/index.html")).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{32}$/);
  });

  it("refuses asset paths that could escape the asset root", async () => {
    for (const path of ["index.html", "/a/../b", "/./a", "//a"]) {
      await expect(buildAssetManifest([{ path, content: text(""), contentType: "text/plain" }]), path).rejects.toThrow(/bad asset path/);
    }
  });

  it("puts the platform's vars over the bundle's, and adds assets, database and secret bindings", () => {
    const metadata = userWorkerMetadata(upload(), "completion");
    expect(metadata.bindings).toEqual([
      { type: "assets", name: "ASSETS" },
      { type: "d1", name: "DB", database_id: "db-1" },
      { type: "plain_text", name: "WORKERS_PLAN", text: "paid" },
      { type: "plain_text", name: "HOSTED_MODE", text: "1" },
      { type: "plain_text", name: "TENANT_ID", text: "abc" },
      { type: "secret_text", name: "MASTER_KEY", text: "secret" },
    ]);
    expect(metadata.assets).toEqual({ jwt: "completion", config: { not_found_handling: "none" } });
    expect(metadata.compatibility_flags).toEqual(["nodejs_compat"]);
    expect(metadata.observability).toEqual({ enabled: true });
  });

  it("refuses a binding name used twice, and more than eight tags", () => {
    expect(() => userWorkerMetadata(upload({ secrets: { TENANT_ID: "x" } }), "j")).toThrow(/TENANT_ID is set twice/);
    expect(() => userWorkerMetadata(upload({ tags: Array.from({ length: 9 }, (_, i) => `t${i}`) }), "j")).toThrow(/tags/);
  });

  it("runs the three phases against the fake, bucket by bucket", async () => {
    const api = new FakeCloudflareApi();
    api.databases.set("db-1", { id: "db-1", name: "openping-t-abc" });
    const result = await uploadUserWorker(api, upload());
    expect(result.hasAssets).toBe(true);
    expect(api.calls.map((c) => c.op)).toEqual(["createAssetUploadSession", "uploadAssets", "uploadAssets", "putScript"]);
    // A second upload of the same release sends no files.
    await uploadUserWorker(api, upload());
    expect(api.count("uploadAssets")).toBe(2);
  });
});

describe("Durable Objects in the bundle", () => {
  const MIGRATIONS = [
    { tag: "v1", new_sqlite_classes: ["RegionProbe"] },
    { tag: "v2", new_sqlite_classes: ["Other"] },
  ];

  it("sends every step to a new script, and only the later ones to an updated one", () => {
    expect(migrationsAfter(MIGRATIONS, null)).toEqual({
      new_tag: "v2",
      steps: [{ new_sqlite_classes: ["RegionProbe"] }, { new_sqlite_classes: ["Other"] }],
    });
    expect(migrationsAfter(MIGRATIONS, "v1")).toEqual({ old_tag: "v1", new_tag: "v2", steps: [{ new_sqlite_classes: ["Other"] }] });
    expect(migrationsAfter(MIGRATIONS, "v2")).toBeUndefined();
    expect(migrationsAfter([], null)).toBeUndefined();
    expect(() => migrationsAfter(MIGRATIONS, "v9")).toThrow(/no migration tag v9/);
    expect(() => migrationsAfter([MIGRATIONS[0]!, MIGRATIONS[0]!], null)).toThrow(/duplicate/);
  });

  it("binds the bundle's classes and sends its migrations in the metadata", () => {
    const bundle = { ...BUNDLE, durableObjects: [{ name: "REGION_PROBE", className: "RegionProbe" }], migrations: [MIGRATIONS[0]!] };
    const metadata = userWorkerMetadata(upload({ bundle }), "j");
    expect(metadata.bindings).toContainEqual({ type: "durable_object_namespace", name: "REGION_PROBE", class_name: "RegionProbe" });
    expect(metadata.migrations).toEqual({ new_tag: "v1", steps: [{ new_sqlite_classes: ["RegionProbe"] }] });
    expect(userWorkerMetadata(upload(), "j").migrations).toBeUndefined();
  });

  it("reads the worker config from OpenPing's wrangler config, with or without the probe", () => {
    const base = {
      name: "open-ping",
      main: "src/worker/index.ts",
      compatibility_date: "2024-12-30",
      compatibility_flags: ["nodejs_compat"],
      assets: { binding: "ASSETS", not_found_handling: "none", run_worker_first: ["/*", "!/assets/*"] },
      triggers: { crons: ["*/12 * * * *"] },
      vars: { WORKERS_PLAN: "free", HOME_PAGE: "status" },
      d1_databases: [{ binding: "DB", database_name: "open-ping" }],
    };
    expect(workerConfigFromWrangler(base)).toEqual({
      compatibilityDate: "2024-12-30",
      compatibilityFlags: ["nodejs_compat"],
      assetsConfig: { not_found_handling: "none", run_worker_first: ["/*", "!/assets/*"] },
      vars: { WORKERS_PLAN: "free", HOME_PAGE: "status" },
      durableObjects: [],
      migrations: [],
    });
    const withProbe = workerConfigFromWrangler({
      ...base,
      vars: { ...base.vars, CONFIRM_REGIONS: "wnam,weur" },
      durable_objects: { bindings: [{ name: "REGION_PROBE", class_name: "RegionProbe" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["RegionProbe"] }],
    });
    expect(withProbe.durableObjects).toEqual([{ name: "REGION_PROBE", className: "RegionProbe" }]);
    expect(withProbe.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["RegionProbe"] }]);
    expect(withProbe.vars.CONFIRM_REGIONS).toBe("wnam,weur");
    expect(() =>
      workerConfigFromWrangler({ ...base, durable_objects: { bindings: [{ name: "X", class_name: "X", script_name: "other" }] } }),
    ).toThrow(/another script/);
  });
});
