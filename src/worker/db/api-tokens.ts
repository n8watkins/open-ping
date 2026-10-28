import type { Env } from "../types";
import { newId, randomToken, sha256hex } from "../lib/ids";

/**
 * Named admin API tokens (migration 0017), used by the CLI, the MCP server and
 * scripts beside the API_TOKEN Worker secret. Only a SHA-256 hash of a token
 * is stored; the token is returned once, by {@link createApiToken}.
 */

/** Every stored token starts with this, so it is easy to spot in a leak scan. */
export const API_TOKEN_PREFIX = "opk_";
/** How many characters of a token are kept to tell tokens apart. */
const VISIBLE_CHARS = API_TOKEN_PREFIX.length + 4;
/** At most this many tokens; one per client is plenty for one administrator. */
export const MAX_API_TOKENS = 25;
/** last_used_at is written at most this often per token, to spare D1 writes. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

interface ApiTokenRow {
  id: string;
  name: string;
  token_hash: string;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
}

/** What the API returns about a token: never the token or its hash. */
export interface ApiTokenSummary {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}

function summarize(row: ApiTokenRow): ApiTokenSummary {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export async function listApiTokens(env: Env): Promise<ApiTokenSummary[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, name, token_hash, prefix, created_at, last_used_at FROM api_tokens ORDER BY created_at DESC",
  ).all<ApiTokenRow>();
  return results.map(summarize);
}

export async function countApiTokens(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM api_tokens").first<{ n: number }>();
  return row?.n ?? 0;
}

/** Create a token. The returned `token` is the only time it can be read. */
export async function createApiToken(
  env: Env,
  name: string,
  now = Date.now(),
): Promise<{ token: string; summary: ApiTokenSummary }> {
  const token = `${API_TOKEN_PREFIX}${randomToken(32)}`;
  const row: ApiTokenRow = {
    id: newId("tok"),
    name,
    token_hash: await sha256hex(token),
    prefix: token.slice(0, VISIBLE_CHARS),
    created_at: now,
    last_used_at: null,
  };
  await env.DB.prepare(
    "INSERT INTO api_tokens (id, name, token_hash, prefix, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, NULL)",
  )
    .bind(row.id, row.name, row.token_hash, row.prefix, row.created_at)
    .run();
  return { token, summary: summarize(row) };
}

/** Revoke a token. False when no such token exists. */
export async function deleteApiToken(env: Env, id: string): Promise<boolean> {
  const res = await env.DB.prepare("DELETE FROM api_tokens WHERE id = ?").bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * The stored token a bearer value is, or null. Tokens without the prefix are
 * never looked up, so the API_TOKEN secret and junk cost no D1 read. The
 * lookup is by hash, so comparing it leaks nothing about the token.
 */
export async function findApiToken(env: Env, bearer: string, now = Date.now()): Promise<ApiTokenSummary | null> {
  if (!bearer.startsWith(API_TOKEN_PREFIX) || bearer.length > 128) return null;
  const hash = await sha256hex(bearer);
  const row = await env.DB.prepare(
    "SELECT id, name, token_hash, prefix, created_at, last_used_at FROM api_tokens WHERE token_hash = ?",
  )
    .bind(hash)
    .first<ApiTokenRow>();
  if (!row) return null;
  if (row.last_used_at == null || now - row.last_used_at >= TOUCH_INTERVAL_MS) {
    await env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").bind(now, row.id).run();
    row.last_used_at = now;
  }
  return summarize(row);
}
