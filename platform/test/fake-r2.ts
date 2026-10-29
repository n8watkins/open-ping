/**
 * An in-memory R2 bucket: the part of the R2Bucket binding the platform
 * uses (get, head, put, delete, list with a prefix, a delimiter and pages),
 * so the real R2BundleSource runs against it in tests. Every call is
 * recorded, and reads or writes can be made to fail.
 * https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
 */

interface Stored {
  body: Uint8Array<ArrayBuffer>;
  contentType?: string;
  uploaded: Date;
}

function toBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value === "string") return new Uint8Array(new TextEncoder().encode(value));
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (value === null || value === undefined) return new Uint8Array(0);
  throw new Error("FakeR2Bucket: unsupported body");
}

function objectOf(key: string, stored: Stored, withBody: boolean) {
  const meta = {
    key,
    size: stored.body.byteLength,
    etag: `etag-${key}`,
    httpEtag: `"etag-${key}"`,
    uploaded: stored.uploaded,
    httpMetadata: stored.contentType ? { contentType: stored.contentType } : {},
    customMetadata: {},
  };
  if (!withBody) return meta;
  return {
    ...meta,
    text: async () => new TextDecoder().decode(stored.body),
    json: async () => JSON.parse(new TextDecoder().decode(stored.body)),
    body: new Response(stored.body.slice()).body,
    arrayBuffer: async () => stored.body.slice().buffer,
    bytes: async () => stored.body.slice(),
  };
}

export class FakeR2Bucket {
  readonly objects = new Map<string, Stored>();
  readonly calls: { op: "get" | "head" | "put" | "delete" | "list"; key: string }[] = [];
  /** Keys whose next get fails. */
  readonly failGet = new Set<string>();
  /** Page size of list(), small to exercise the cursor. */
  pageSize = 1000;

  /** The fake as the binding type, for code that takes an R2Bucket. */
  get bucket(): R2Bucket {
    return this as unknown as R2Bucket;
  }

  putText(key: string, text: string, contentType?: string): void {
    this.objects.set(key, { body: toBytes(text), contentType, uploaded: new Date(0) });
  }

  textOf(key: string): string | null {
    const stored = this.objects.get(key);
    return stored ? new TextDecoder().decode(stored.body) : null;
  }

  async get(key: string) {
    this.calls.push({ op: "get", key });
    if (this.failGet.delete(key)) throw new Error(`injected: get ${key}`);
    const stored = this.objects.get(key);
    return stored ? objectOf(key, stored, true) : null;
  }

  async head(key: string) {
    this.calls.push({ op: "head", key });
    const stored = this.objects.get(key);
    return stored ? objectOf(key, stored, false) : null;
  }

  async put(key: string, value: unknown, options?: { httpMetadata?: { contentType?: string } }) {
    this.calls.push({ op: "put", key });
    // A stream is read to the end, as R2 does before it answers.
    const body = value instanceof ReadableStream ? new Uint8Array(await new Response(value).arrayBuffer()) : toBytes(value);
    const stored: Stored = { body, contentType: options?.httpMetadata?.contentType, uploaded: new Date() };
    this.objects.set(key, stored);
    return objectOf(key, stored, false);
  }

  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.calls.push({ op: "delete", key });
      this.objects.delete(key);
    }
  }

  async list(options: { prefix?: string; delimiter?: string; cursor?: string; limit?: number } = {}) {
    this.calls.push({ op: "list", key: options.prefix ?? "" });
    const prefix = options.prefix ?? "";
    const entries: { key: string; prefix: boolean }[] = [];
    const seen = new Set<string>();
    for (const key of [...this.objects.keys()].sort()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const cut = options.delimiter ? rest.indexOf(options.delimiter) : -1;
      if (cut >= 0) {
        const p = prefix + rest.slice(0, cut + options.delimiter!.length);
        if (!seen.has(p)) {
          seen.add(p);
          entries.push({ key: p, prefix: true });
        }
      } else {
        entries.push({ key, prefix: false });
      }
    }
    const start = options.cursor ? Number(options.cursor) : 0;
    const size = Math.min(options.limit ?? this.pageSize, this.pageSize);
    const page = entries.slice(start, start + size);
    const truncated = start + size < entries.length;
    return {
      objects: page.filter((e) => !e.prefix).map((e) => objectOf(e.key, this.objects.get(e.key)!, false)),
      delimitedPrefixes: page.filter((e) => e.prefix).map((e) => e.key),
      truncated,
      ...(truncated ? { cursor: String(start + size) } : {}),
    };
  }
}
