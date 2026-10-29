/**
 * Exporting a tenant's database (build plan, B7): D1's own export to SQL,
 * copied to the exports bucket with the steps to run it as a self-hosted
 * OpenPing (docs/BACKUP.md, "Full database dump").
 *
 * An export is a row of tenant_exports moving requested -> exporting ->
 * done, or failed after EXPORT_MAX_ATTEMPTS tries. Each step is written
 * before the next, and every step can run again, so the cron picks up an
 * export wherever the last run stopped:
 *
 *   requested   D1's export is started (POST .../export, output_format "polling")
 *   exporting   polled until it is complete, then the dump is copied from its
 *               signed URL to exports/<tenant>/<export id>/openping.sql, with
 *               README.md beside it                         -> done
 *
 * Two reasons: `deletion`, made before a tenant past its 30 days is deleted
 * (the deletion waits for it), and `self_host`, asked for by the customer
 * from their account page.
 *
 * The dump holds what the tenant's database holds: encrypted values sealed
 * with its MASTER_KEY, which is never written to the bucket. Its escrowed
 * copy (still sealed with PLATFORM_KEY) is kept with the export in
 * export_keys, so it outlives a deleted tenant, and the customer reveals it
 * on their account page after a fresh sign-in, as BACKUP.md says a key is
 * kept: apart from the backups it opens. Both go when the export expires.
 */

import { tenantDatabaseName } from "../../../src/shared/hosted-contract";
import { CloudflareApiError, type CloudflareApi } from "../cloudflare/api";
import { PermanentError } from "../errors";
import { activeEscrowedKey } from "../keys";
import { describeError } from "../provisioning";

/** Failed tries before an export gives up (and a deletion waiting on it starts a new one later). */
export const EXPORT_MAX_ATTEMPTS = 5;
/** Wait before try n+1. */
export const EXPORT_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000] as const;
/** How long one run polls D1 before leaving it for the next (D1 cancels an export nobody polls). */
export const EXPORT_POLL_BUDGET_MS = 60_000;
export const EXPORT_POLL_INTERVAL_MS = 2_000;
/** How long one run holds an export (longer than its poll budget and the copy). */
export const EXPORT_LEASE_MS = 5 * 60_000;
/** How long the files stay in the bucket after they are made. */
export const EXPORT_KEEP_MS = { self_host: 7 * 86_400_000, deletion: 30 * 86_400_000 } as const;

export type ExportReason = keyof typeof EXPORT_KEEP_MS;
export type ExportState = "requested" | "exporting" | "done" | "failed";

export interface TenantExport {
  id: string;
  tenantId: string;
  accountId: string;
  slug: string;
  reason: ExportReason;
  state: ExportState;
  attempts: number;
  r2Prefix: string | null;
  bytes: number | null;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
  expiresAt: number | null;
}

export interface ExportDeps {
  db: D1Database;
  api: CloudflareApi;
  /** EXPORTS: the bucket the dumps go to (openping-tenant-exports). */
  bucket: R2Bucket;
  /** Fetches D1's signed URL (the global fetch in production). */
  fetchDump?: (url: string) => Promise<Response>;
  now?: () => number;
  /** Tests only: waits between polls without sleeping. */
  sleep?: (ms: number) => Promise<void>;
}

const COLUMNS = "id, tenant_id, account_id, slug, reason, state, attempts, r2_prefix, bytes, error, created_at, finished_at, expires_at";

interface Row {
  id: string;
  tenant_id: string;
  account_id: string;
  slug: string;
  reason: ExportReason;
  state: ExportState;
  attempts: number;
  r2_prefix: string | null;
  bytes: number | null;
  error: string | null;
  created_at: number;
  finished_at: number | null;
  expires_at: number | null;
}

function fromRow(r: Row): TenantExport {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    accountId: r.account_id,
    slug: r.slug,
    reason: r.reason,
    state: r.state,
    attempts: r.attempts,
    r2Prefix: r.r2_prefix,
    bytes: r.bytes,
    error: r.error,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    expiresAt: r.expires_at,
  };
}

export async function getExport(db: D1Database, id: string): Promise<TenantExport | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM tenant_exports WHERE id = ?`).bind(id).first<Row>();
  return row ? fromRow(row) : null;
}

/** The account's exports, newest first (its tenant may be gone). */
export async function accountExports(db: D1Database, accountId: string, limit = 10): Promise<TenantExport[]> {
  const rows = await db.prepare(`SELECT ${COLUMNS} FROM tenant_exports WHERE account_id = ? ORDER BY created_at DESC LIMIT ?`).bind(accountId, limit).all<Row>();
  return rows.results.map(fromRow);
}

/** The newest export of the tenant for `reason` made at or after `since`. */
export async function latestExport(db: D1Database, tenantId: string, reason: ExportReason, since: number): Promise<TenantExport | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM tenant_exports WHERE tenant_id = ? AND reason = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1`)
    .bind(tenantId, reason, since)
    .first<Row>();
  return row ? fromRow(row) : null;
}

export const OPEN_EXPORTS_SQL = `SELECT id FROM tenant_exports WHERE state IN ('requested', 'exporting') AND (next_at IS NULL OR next_at <= ?) ORDER BY created_at LIMIT ?`;

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `exp_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Asks for an export of the tenant's database. */
export async function requestExport(db: D1Database, input: { tenantId: string; accountId: string; slug: string; reason: ExportReason; now: number }): Promise<string> {
  const id = randomId();
  await db
    .prepare(
      `INSERT INTO tenant_exports (id, tenant_id, account_id, slug, reason, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'requested', ?, ?)`,
    )
    .bind(id, input.tenantId, input.accountId, input.slug, input.reason, input.now, input.now)
    .run();
  return id;
}

/** The steps to run an export as a self-hosted OpenPing, as README.md beside the dump. */
export function exportInstructions(input: { slug: string; tenantUrl: string; version: string | null; exportedAt: number; accountUrl: string }): string {
  const when = new Date(input.exportedAt).toISOString().slice(0, 16).replace("T", " ");
  return `# Your OpenPing, exported

This is ${input.tenantUrl}, exported from OpenPing Hosted on ${when} UTC${input.version ? `, running OpenPing ${input.version}` : ""}.
\`openping.sql\` is the whole database: monitors, check history, incidents, status pages, alert channels and settings.

## Keep it safe

Treat \`openping.sql\` as sensitive, like any full OpenPing backup (docs/BACKUP.md).
Passwords, tokens and webhook URLs in it are encrypted with your OpenPing's \`MASTER_KEY\`, which is not in this download.
Reveal it with this export's Key button on your account page (${input.accountUrl}), after signing in again, for as long as the export is kept there, and keep it in your password manager, apart from this file.
Without the key the database still restores, but the encrypted values can't be read, and you add those credentials again.

## Run it as your own OpenPing

You need a Cloudflare account (the free plan works) and Node.js 20 or later.
The steps follow docs/INSTALL.md in https://github.com/n8watkins/open-ping, with this database in place of a new one.

1. Get OpenPing ${input.version ?? "(the same version or a newer one)"} or newer: \`git clone https://github.com/n8watkins/open-ping && cd open-ping && npm ci\`.
2. Sign in to Cloudflare: \`npx wrangler login\`.
3. Make the database and load the export into it, before the first deploy:
   \`npx wrangler d1 create open-ping\`, put the id it prints in \`wrangler.jsonc\` (\`d1_databases\`, \`database_id\`), then
   \`npx wrangler d1 execute open-ping --remote --file openping.sql\`.
   The export carries its own migration history, so the deploy applies only migrations newer than it.
4. Set the secrets: \`npx wrangler secret put MASTER_KEY\` with the key from your account page, and \`npx wrangler secret put SETUP_TOKEN\` with a new random value (\`openssl rand -base64 32\`).
5. Deploy: \`npm run deploy\`.
6. Open your new address. If it shows the setup page, enter the \`SETUP_TOKEN\` and finish it.
   If it shows the sign-in page, open \`/recover\`, enter the \`SETUP_TOKEN\` and make a passkey.
   Passkeys from ${input.slug} on OpenPing Hosted don't work on another address, so remove them in Settings once you are in.
7. Set \`RESEND_API_KEY\` (docs/INSTALL.md) for email alerts, and check your alert channels with a test.
8. Rotate \`MASTER_KEY\` (docs/SECURITY.md, "Rotating MASTER_KEY"): OpenPing Hosted kept a copy of it until your OpenPing there is deleted.

Leftovers from OpenPing Hosted (the sign-in hand-off and support records) are harmless, and a plain install never reads them.

Questions: support@n8builds.dev, within 2 business days.
`;
}

/** Larger than this, a tenant's dump is refused here (a Hosted tenant's is a few MB at most) and the owner exports it by hand. */
export const EXPORT_MAX_BYTES = 64 * 1024 * 1024;
/** Tables every OpenPing database has; a dump without them isn't one. */
export const REQUIRED_TABLES = ["d1_migrations", "monitors"] as const;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The tables a SQL dump creates, in order. */
export function dumpTables(sql: string): string[] {
  const names: string[] = [];
  for (const m of sql.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["'`[]?([A-Za-z0-9_]+)/gi)) names.push(m[1]!);
  return names;
}

/** Why `bytes` isn't a usable OpenPing dump, or null. */
export function dumpProblem(bytes: Uint8Array): string | null {
  if (bytes.byteLength === 0) return "the dump is empty";
  const head = new TextDecoder().decode(bytes.subarray(0, 4096)).trimStart();
  if (!/^(PRAGMA|CREATE|BEGIN|INSERT|--)/i.test(head)) return "the dump doesn't look like SQL";
  const tables = dumpTables(new TextDecoder().decode(bytes));
  const missing = REQUIRED_TABLES.filter((t) => !tables.includes(t));
  return missing.length ? `the dump has no ${missing.join(" or ")} table` : null;
}

/** Reads the dump whole (bounded), checks it is an OpenPing dump, and stores it. */
async function storeDump(bucket: R2Bucket, key: string, res: Response): Promise<{ bytes: number; sha256: string; tables: string[] }> {
  const length = Number(res.headers.get("content-length") ?? "");
  if (Number.isSafeInteger(length) && length > EXPORT_MAX_BYTES) throw new PermanentError(`the dump is ${length} bytes, over ${EXPORT_MAX_BYTES}`);
  const body = new Uint8Array(await res.arrayBuffer());
  if (body.byteLength > EXPORT_MAX_BYTES) throw new PermanentError(`the dump is over ${EXPORT_MAX_BYTES} bytes`);
  const problem = dumpProblem(body);
  if (problem) throw new Error(problem);
  const sha256 = await sha256Hex(body);
  await bucket.put(key, body, { httpMetadata: { contentType: "application/sql" }, sha256 });
  return { bytes: body.byteLength, sha256, tables: dumpTables(new TextDecoder().decode(body)) };
}

export type ExportOutcome = { kind: "done" | "waiting" | "retry" | "failed" | "missing"; exportId: string; error?: string };

/**
 * Takes one export as far as it goes now: starts it, polls it for up to
 * EXPORT_POLL_BUDGET_MS, and copies the dump once it is ready.
 */
export async function advanceExport(
  deps: ExportDeps,
  exportId: string,
  context: { tenantUrl: string; accountUrl: string },
): Promise<ExportOutcome> {
  const now = deps.now ?? Date.now;
  const row = await deps.db
    .prepare(`SELECT ${COLUMNS}, bookmark FROM tenant_exports WHERE id = ?`)
    .bind(exportId)
    .first<Row & { bookmark: string | null }>();
  if (!row || (row.state !== "requested" && row.state !== "exporting")) return { kind: "missing", exportId };
  // One run per export (the cron and the account page's push), so two can't write the same files.
  const token = crypto.randomUUID();
  const leased = await deps.db
    .prepare("UPDATE tenant_exports SET lease_until = ?, lease_token = ? WHERE id = ? AND (lease_until IS NULL OR lease_until <= ?)")
    .bind(now() + EXPORT_LEASE_MS, token, exportId, now())
    .run();
  if ((leased.meta.changes ?? 0) === 0) return { kind: "waiting", exportId };
  try {
    return await advanceLeased(deps, row, token, context);
  } finally {
    await deps.db.prepare("UPDATE tenant_exports SET lease_until = NULL, lease_token = NULL WHERE id = ? AND lease_token = ?").bind(exportId, token).run();
  }
}

async function advanceLeased(
  deps: ExportDeps,
  row: Row & { bookmark: string | null },
  token: string,
  context: { tenantUrl: string; accountUrl: string },
): Promise<ExportOutcome> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const exportId = row.id;
  const tenant = await deps.db.prepare("SELECT d1_id, version FROM tenants WHERE id = ?").bind(row.tenant_id).first<{ d1_id: string | null; version: string | null }>();
  const set = (columns: Record<string, string | number | null>) => {
    const names = Object.keys(columns);
    return deps.db
      .prepare(`UPDATE tenant_exports SET ${names.map((n) => `${n} = ?`).join(", ")}, updated_at = ? WHERE id = ? AND state = ? AND lease_token = ?`)
      .bind(...names.map((n) => columns[n]!), now(), exportId, row.state, token)
      .run();
  };
  const fail = async (error: unknown): Promise<ExportOutcome> => {
    const attempts = row.attempts + 1;
    const message = describeError(error).slice(0, 300);
    const failed = attempts >= EXPORT_MAX_ATTEMPTS;
    // A new try starts a new D1 export: a failed one can't be polled again.
    await set({
      state: failed ? "failed" : "requested",
      attempts,
      error: message,
      bookmark: null,
      next_at: failed ? null : now() + EXPORT_BACKOFF_MS[Math.min(attempts, EXPORT_BACKOFF_MS.length) - 1]!,
      finished_at: failed ? now() : null,
      // A failed export has no files; its row is kept a while as history.
      expires_at: failed ? now() + EXPORT_KEEP_MS.deletion : null,
    });
    console.error("[export] failed", { export: exportId, tenant: row.tenant_id, attempts, error: message });
    return { kind: failed ? "failed" : "retry", exportId, error: message };
  };
  try {
    // The database may never have been recorded on the row: look it up by name, as removal does.
    const d1Id = tenant?.d1_id ?? (await deps.api.findDatabaseByName(tenantDatabaseName(row.tenant_id)))?.id ?? null;
    if (!d1Id) return await fail(new Error("the tenant has no database"));
    let bookmark = row.bookmark;
    if (!bookmark || row.state === "requested") {
      const started = await deps.api.exportDatabase(d1Id);
      if (started.status === "error") return await fail(new Error(`D1 export: ${started.error}`));
      if (!started.bookmark) return await fail(new Error("D1 export gave no bookmark"));
      bookmark = started.bookmark;
      await set({ state: "exporting", bookmark });
      row.state = "exporting";
    }
    const deadline = now() + EXPORT_POLL_BUDGET_MS;
    for (;;) {
      const poll = await deps.api.exportDatabase(d1Id, bookmark!);
      if (poll.status === "error") return await fail(new Error(`D1 export: ${poll.error}`));
      if (poll.status === "complete") {
        const res = await (deps.fetchDump ?? ((url: string) => fetch(url)))(poll.signedUrl);
        if (!res.ok) return await fail(new Error(`the dump's download answered ${res.status}`));
        const prefix = `exports/${row.tenant_id}/${row.id}/`;
        const stored = await storeDump(deps.bucket, `${prefix}openping.sql`, res);
        // The key the dump's encrypted values are sealed with, kept with the
        // export: it outlives the tenant's own escrowed key (decision D12).
        const escrowed = await activeEscrowedKey(deps.db, row.tenant_id);
        if (!escrowed) throw new PermanentError("the tenant has no escrowed MASTER_KEY to keep with its export");
        await deps.db
          .prepare("INSERT INTO export_keys (export_id, tenant_id, kid, ciphertext) VALUES (?, ?, ?, ?) ON CONFLICT(export_id) DO UPDATE SET kid = excluded.kid, ciphertext = excluded.ciphertext")
          .bind(exportId, row.tenant_id, escrowed.kid, escrowed.ciphertext)
          .run();
        await deps.bucket.put(
          `${prefix}README.md`,
          exportInstructions({ slug: row.slug, tenantUrl: context.tenantUrl, version: tenant?.version ?? null, exportedAt: now(), accountUrl: context.accountUrl }),
          { httpMetadata: { contentType: "text/markdown; charset=utf-8" } },
        );
        await set({
          state: "done",
          r2_prefix: prefix,
          bytes: stored.bytes,
          sha256: stored.sha256,
          tables: JSON.stringify(stored.tables),
          error: null,
          bookmark: null,
          next_at: null,
          finished_at: now(),
          expires_at: now() + EXPORT_KEEP_MS[row.reason],
        });
        return { kind: "done", exportId };
      }
      if (now() >= deadline) return { kind: "waiting", exportId };
      await sleep(EXPORT_POLL_INTERVAL_MS);
    }
  } catch (error) {
    // A database that is gone can't be exported, ever: say so at once.
    if (error instanceof CloudflareApiError && error.notFound) {
      await set({ state: "failed", attempts: EXPORT_MAX_ATTEMPTS, error: "the tenant's database is gone", finished_at: now(), next_at: null, expires_at: now() + EXPORT_KEEP_MS.deletion });
      return { kind: "failed", exportId, error: "the tenant's database is gone" };
    }
    return fail(error);
  }
}

/**
 * Why the export isn't safe to delete its tenant behind, or null when it is:
 * both files read back from the bucket, the dump the same bytes as when it
 * was made (its SHA-256), still an OpenPing dump with the same tables, and
 * its key kept with it.
 */
export async function exportVerificationProblem(db: D1Database, bucket: R2Bucket, exp: TenantExport): Promise<string | null> {
  if (exp.state !== "done" || !exp.r2Prefix) return "it isn't done";
  const row = await db.prepare("SELECT sha256, tables FROM tenant_exports WHERE id = ?").bind(exp.id).first<{ sha256: string | null; tables: string | null }>();
  if (!row?.sha256 || !row.tables) return "it has no checksum";
  const [dump, readme, key] = await Promise.all([
    bucket.get(`${exp.r2Prefix}openping.sql`),
    bucket.head(`${exp.r2Prefix}README.md`),
    db.prepare("SELECT 1 AS x FROM export_keys WHERE export_id = ?").bind(exp.id).first(),
  ]);
  if (!dump || !readme) return "its files are missing from the bucket";
  if (!key) return "its key wasn't kept";
  const bytes = new Uint8Array(await dump.arrayBuffer());
  if (exp.bytes !== null && bytes.byteLength !== exp.bytes) return "its dump changed size";
  if ((await sha256Hex(bytes)) !== row.sha256) return "its dump doesn't match its checksum";
  const problem = dumpProblem(bytes);
  if (problem) return problem;
  if (JSON.stringify(dumpTables(new TextDecoder().decode(bytes))) !== row.tables) return "its dump's tables changed";
  return null;
}

/** Deletes the files and rows of exports past their keep time. */
export async function expireExports(deps: Pick<ExportDeps, "db" | "bucket" | "now">, limit = 20): Promise<number> {
  const now = (deps.now ?? Date.now)();
  const rows = await deps.db
    .prepare("SELECT id, r2_prefix FROM tenant_exports WHERE expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at LIMIT ?")
    .bind(now, limit)
    .all<{ id: string; r2_prefix: string | null }>();
  for (const r of rows.results) {
    if (r.r2_prefix) await deps.bucket.delete([`${r.r2_prefix}openping.sql`, `${r.r2_prefix}README.md`]);
    // The files, the key kept for them, and the row go together.
    await deps.db.batch([
      deps.db.prepare("DELETE FROM export_keys WHERE export_id = ?").bind(r.id),
      deps.db.prepare("DELETE FROM tenant_exports WHERE id = ?").bind(r.id),
    ]);
  }
  return rows.results.length;
}
