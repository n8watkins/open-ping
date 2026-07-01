import type { Env } from "../types";
import type { StatusPageInput } from "../../shared/schemas";
import { newId } from "../lib/ids";

/**
 * Status-page CRUD data layer (PRD §16 — multiple, per-category public pages).
 * Each `status_pages` row is one published public page with its own slug,
 * branding, kill switch, ordering, and monitor selection. `category_ids` and
 * `monitor_ids` are stored as JSON TEXT arrays (mirroring
 * `maintenance_windows.monitor_ids`); `enabled`/`is_default`/`attribution` are
 * 0/1 integers. This module maps rows to/from a camelCase `StatusPageRecord`.
 * Timestamps are epoch milliseconds.
 *
 * The default page (`is_default = 1`, at most one, enforced by a partial unique
 * index) is served at /status with no slug. The default flag is NOT managed
 * through create/update here — new pages are never default, updates never touch
 * the flag, and the default page cannot be deleted.
 */

/**
 * Typed error surfaced to the route layer so it can map to the right status:
 *   - "slug_conflict"        → 409 (another page already owns the slug)
 *   - "default_not_deletable" → 400 (the default page is not deletable)
 */
export class StatusPageError extends Error {
  constructor(
    public readonly code: "slug_conflict" | "default_not_deletable",
    message: string,
  ) {
    super(message);
    this.name = "StatusPageError";
  }
}

/** True when a thrown D1 error is a UNIQUE-constraint violation. */
function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(msg);
}

export type IncludeMode = "all" | "categories" | "monitors";

export interface StatusPageRecord {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  enabled: boolean;
  isDefault: boolean;
  includeMode: IncludeMode;
  /** Selected category ids when includeMode === "categories" (else advisory). */
  categoryIds: string[];
  /** Selected monitor ids when includeMode === "monitors" (else advisory). */
  monitorIds: string[];
  theme: string | null;
  accent: string | null;
  logo: string | null;
  homepage: string | null;
  footer: string | null;
  attribution: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/** Raw shape of a `status_pages` row as returned by D1. */
interface StatusPageRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  enabled: number;
  is_default: number;
  include_mode: string;
  category_ids: string | null;
  monitor_ids: string | null;
  theme: string | null;
  accent: string | null;
  logo: string | null;
  homepage: string | null;
  footer: string | null;
  attribution: number;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

/** Parse a JSON id-array column, falling back to [] on null/corrupt/non-array. */
function parseIdArray(raw: string | null): string[] {
  if (raw == null) return [];
  try {
    const val = JSON.parse(raw);
    return Array.isArray(val) ? (val as string[]) : [];
  } catch {
    return [];
  }
}

/** Narrow an arbitrary string to a valid IncludeMode, defaulting to "all". */
function toIncludeMode(mode: string): IncludeMode {
  return mode === "categories" || mode === "monitors" ? mode : "all";
}

/** Map a raw row to a typed record, parsing JSON arrays and coercing 0/1. */
function rowToStatusPage(row: StatusPageRow): StatusPageRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    enabled: row.enabled !== 0,
    isDefault: row.is_default !== 0,
    includeMode: toIncludeMode(row.include_mode),
    categoryIds: parseIdArray(row.category_ids),
    monitorIds: parseIdArray(row.monitor_ids),
    theme: row.theme,
    accent: row.accent,
    logo: row.logo,
    homepage: row.homepage,
    footer: row.footer,
    attribution: row.attribution !== 0,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listStatusPages(env: Env): Promise<StatusPageRecord[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM status_pages ORDER BY sort_order, name",
  ).all<StatusPageRow>();
  return (res.results ?? []).map(rowToStatusPage);
}

export async function getStatusPage(
  env: Env,
  id: string,
): Promise<StatusPageRecord | null> {
  const row = await env.DB.prepare("SELECT * FROM status_pages WHERE id = ?")
    .bind(id)
    .first<StatusPageRow>();
  return row ? rowToStatusPage(row) : null;
}

export async function getStatusPageBySlug(
  env: Env,
  slug: string,
): Promise<StatusPageRecord | null> {
  const row = await env.DB.prepare("SELECT * FROM status_pages WHERE slug = ?")
    .bind(slug)
    .first<StatusPageRow>();
  return row ? rowToStatusPage(row) : null;
}

/** The single default page (served at /status with no slug), or null. */
export async function getDefaultPage(env: Env): Promise<StatusPageRecord | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM status_pages WHERE is_default = 1",
  ).first<StatusPageRow>();
  return row ? rowToStatusPage(row) : null;
}

export async function createStatusPage(
  env: Env,
  input: StatusPageInput,
): Promise<StatusPageRecord> {
  // Guard the UNIQUE(slug) constraint up front so callers get a typed 409 rather
  // than an opaque D1 constraint error.
  const slugOwner = await getStatusPageBySlug(env, input.slug);
  if (slugOwner) {
    throw new StatusPageError(
      "slug_conflict",
      `slug "${input.slug}" is already in use`,
    );
  }

  const id = newId("sp");
  const now = Date.now();

  try {
    await env.DB.prepare(
      `INSERT INTO status_pages (
       id, slug, name, description, enabled, is_default, include_mode,
       category_ids, monitor_ids, theme, accent, logo, homepage, footer,
       attribution, sort_order, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        input.slug,
        input.name,
        input.description ?? null,
        input.enabled ? 1 : 0,
        0, // is_default: new pages are never the default.
        input.includeMode,
        JSON.stringify(input.categoryIds),
        JSON.stringify(input.monitorIds),
        input.theme,
        input.accent,
        input.logo || null,
        input.homepage || null,
        input.footer ?? null,
        input.attribution ? 1 : 0,
        input.sortOrder,
        now,
        now,
      )
      .run();
  } catch (err) {
    // A concurrent create can win the slug between the pre-check and here; the
    // UNIQUE(slug) index still protects us, so map it to a typed 409 (mirrors
    // db/categories.ts) rather than letting a raw D1 error surface as a 500.
    if (isUniqueViolation(err)) {
      throw new StatusPageError("slug_conflict", `slug "${input.slug}" is already in use`);
    }
    throw err;
  }

  const created = await getStatusPage(env, id);
  if (!created) {
    throw new Error("createStatusPage: failed to read back inserted row");
  }
  return created;
}

/**
 * Full update of an existing page. Returns null if `id` doesn't exist. The
 * `is_default` flag and `created_at` are intentionally NOT written (the default
 * flag is managed separately); `updated_at` always bumps. Slug uniqueness is
 * guarded, allowing the page to keep its own slug.
 */
export async function updateStatusPage(
  env: Env,
  id: string,
  input: StatusPageInput,
): Promise<StatusPageRecord | null> {
  const existing = await getStatusPage(env, id);
  if (!existing) return null;

  const slugOwner = await getStatusPageBySlug(env, input.slug);
  if (slugOwner && slugOwner.id !== id) {
    throw new StatusPageError(
      "slug_conflict",
      `slug "${input.slug}" is already in use`,
    );
  }

  try {
    await env.DB.prepare(
      `UPDATE status_pages SET
       slug = ?, name = ?, description = ?, enabled = ?, include_mode = ?,
       category_ids = ?, monitor_ids = ?, theme = ?, accent = ?, logo = ?,
       homepage = ?, footer = ?, attribution = ?, sort_order = ?, updated_at = ?
     WHERE id = ?`,
    )
      .bind(
        input.slug,
        input.name,
        input.description ?? null,
        input.enabled ? 1 : 0,
        input.includeMode,
        JSON.stringify(input.categoryIds),
        JSON.stringify(input.monitorIds),
        input.theme,
        input.accent,
        input.logo || null,
        input.homepage || null,
        input.footer ?? null,
        input.attribution ? 1 : 0,
        input.sortOrder,
        Date.now(),
        id,
      )
      .run();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new StatusPageError("slug_conflict", `slug "${input.slug}" is already in use`);
    }
    throw err;
  }

  return getStatusPage(env, id);
}

/**
 * Delete a page. Refuses to delete the default page (throws a StatusPageError
 * the route maps to 400). No-op if the id doesn't exist.
 */
export async function deleteStatusPage(env: Env, id: string): Promise<void> {
  const existing = await getStatusPage(env, id);
  if (!existing) return;
  if (existing.isDefault) {
    throw new StatusPageError(
      "default_not_deletable",
      "the default status page cannot be deleted",
    );
  }
  await env.DB.prepare("DELETE FROM status_pages WHERE id = ?").bind(id).run();
}

/**
 * PURE monitor selection for a page — the heart of per-page filtering. Given a
 * page's include configuration and the set of monitors already deemed visible,
 * return the subset that belongs on this page:
 *   - "all"        → every visible monitor
 *   - "categories" → visible monitors whose categoryId is in page.categoryIds
 *   - "monitors"   → visible monitors whose id is in page.monitorIds
 *
 * Standalone and side-effect-free so the public-API layer can import it and it
 * stays trivially unit-testable without D1.
 */
export function selectPageMonitors<
  T extends { id: string; categoryId: string | null },
>(
  page: Pick<StatusPageRecord, "includeMode" | "categoryIds" | "monitorIds">,
  visibleMonitors: T[],
): T[] {
  switch (page.includeMode) {
    case "categories": {
      const wanted = new Set(page.categoryIds);
      return visibleMonitors.filter(
        (m) => m.categoryId != null && wanted.has(m.categoryId),
      );
    }
    case "monitors": {
      const wanted = new Set(page.monitorIds);
      return visibleMonitors.filter((m) => wanted.has(m.id));
    }
    case "all":
    default:
      return visibleMonitors;
  }
}
