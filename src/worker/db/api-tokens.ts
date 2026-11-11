import type { Env } from "../types";
import { newId, randomToken, sha256hex } from "../lib/ids";
import { normalizeScopes, parseScopes, type Scope } from "../lib/scopes";

/**
 * Named API tokens (migrations 0017 and 0029), used by the CLI, the MCP server
 * and scripts beside the API_TOKEN Worker secret. Each has scopes
 * (lib/scopes.ts) and an optional expiry. Only a hash of a token is stored;
 * the token is returned once, by {@link createApiToken}. Revoking keeps the
 * row as an audit record and destroys its hash.
 */

/** Every stored token starts with this, so it is easy to spot in a leak scan. */
export const API_TOKEN_PREFIX = "opk_";
/** How many characters of a token are kept to tell tokens apart. */
const VISIBLE_CHARS = API_TOKEN_PREFIX.length + 4;
/** At most this many active tokens; one per client is plenty for one administrator. */
export const MAX_API_TOKENS = 25;
/** How many revoked tokens the Developers page lists. */
const REVOKED_SHOWN = 20;
/** last_used_at is written at most this often per token, to spare D1 writes. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
/** The expiry choices the Developers page offers, in days (null: never). */
export { EXPIRY_DAYS } from "../../shared/scopes";
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Hash prefix for tokens created since migration 0029. An older OpenPing (a
 * rollback) looks up the bare hex hash, so it never matches these and refuses
 * them instead of treating a scoped or expiring token as full admin.
 */
const HASH_V2 = "v2:";

interface ApiTokenRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  created_via: string | null;
  revoked_at: number | null;
}

const COLUMNS = "id, name, prefix, scopes, created_at, last_used_at, expires_at, created_via, revoked_at";

/** What the API returns about a token: never the token or its hash. */
export interface ApiTokenSummary {
  id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  createdVia: string | null;
  revokedAt: number | null;
}

function summarize(row: ApiTokenRow): ApiTokenSummary {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: parseScopes(row.scopes),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    createdVia: row.created_via,
    revokedAt: row.revoked_at,
  };
}

/** Active tokens (expired ones included, so the owner sees them), newest first. */
export async function listApiTokens(env: Env): Promise<ApiTokenSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM api_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC`,
  ).all<ApiTokenRow>();
  return results.map(summarize);
}

/** The most recently revoked tokens: the audit trail. */
export async function listRevokedApiTokens(env: Env): Promise<ApiTokenSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS} FROM api_tokens WHERE revoked_at IS NOT NULL ORDER BY revoked_at DESC LIMIT ?`,
  )
    .bind(REVOKED_SHOWN)
    .all<ApiTokenRow>();
  return results.map(summarize);
}

/** Tokens that are not revoked (what MAX_API_TOKENS counts, and what turns MCP on). */
export async function countApiTokens(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM api_tokens WHERE revoked_at IS NULL").first<{ n: number }>();
  return row?.n ?? 0;
}

export interface CreateApiTokenInput {
  name: string;
  scopes: readonly Scope[];
  /** Days until it expires, or null for never. */
  expiresInDays: number | null;
  /** Who created it, for the audit record. */
  createdVia: string | null;
}

/** Create a token. The returned `token` is the only time it can be read. */
export async function createApiToken(
  env: Env,
  input: CreateApiTokenInput,
  now = Date.now(),
): Promise<{ token: string; summary: ApiTokenSummary }> {
  const token = `${API_TOKEN_PREFIX}${randomToken(32)}`;
  const scopes = normalizeScopes(input.scopes);
  if (scopes.length === 0) throw new Error("a token needs at least one scope");
  const row: ApiTokenRow = {
    id: newId("tok"),
    name: input.name,
    prefix: token.slice(0, VISIBLE_CHARS),
    scopes: scopes.join(" "),
    created_at: now,
    last_used_at: null,
    expires_at: input.expiresInDays == null ? null : now + input.expiresInDays * DAY_MS,
    created_via: input.createdVia,
    revoked_at: null,
  };
  await env.DB.prepare(
    `INSERT INTO api_tokens (id, name, token_hash, prefix, scopes, created_at, last_used_at, expires_at, created_via, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
  )
    .bind(row.id, row.name, HASH_V2 + (await sha256hex(token)), row.prefix, row.scopes, row.created_at, row.expires_at, row.created_via)
    .run();
  return { token, summary: summarize(row) };
}

/**
 * Revoke a token: it stops working at once. The row stays as an audit record
 * (revoked_at); its hash is overwritten, so nothing can ever match it again,
 * not even an older OpenPing after a rollback. False when no active token has
 * that id.
 */
export async function revokeApiToken(env: Env, id: string, now = Date.now()): Promise<boolean> {
  const res = await env.DB.prepare(
    "UPDATE api_tokens SET revoked_at = ?, token_hash = 'revoked:' || id WHERE id = ? AND revoked_at IS NULL",
  )
    .bind(now, id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * The live token a bearer value is, or null: unknown, revoked and expired
 * tokens are all null. Values without the prefix are never looked up, so the
 * API_TOKEN secret and junk cost no D1 read. The lookup is by hash, so
 * comparing it leaks nothing about the token. Rows from before migration 0029
 * store the bare hex hash; newer ones the 'v2:' form.
 */
export async function findApiToken(env: Env, bearer: string, now = Date.now()): Promise<ApiTokenSummary | null> {
  if (!bearer.startsWith(API_TOKEN_PREFIX) || bearer.length > 128) return null;
  const hash = await sha256hex(bearer);
  const row = await env.DB.prepare(`SELECT ${COLUMNS} FROM api_tokens WHERE token_hash IN (?, ?)`)
    .bind(HASH_V2 + hash, hash)
    .first<ApiTokenRow>();
  if (!row || row.revoked_at != null) return null;
  if (row.expires_at != null && now >= row.expires_at) return null;
  if (row.last_used_at == null || now - row.last_used_at >= TOUCH_INTERVAL_MS) {
    await env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").bind(now, row.id).run();
    row.last_used_at = now;
  }
  return summarize(row);
}
