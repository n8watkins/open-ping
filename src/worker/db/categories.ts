import type { Env } from "../types";
import { newId } from "../lib/ids";
import type { CategoryInput } from "../../shared/schemas";

/**
 * Category CRUD data layer. The `categories` table groups monitors and drives
 * per-category public status pages (migration 0006). Rows are mapped to/from a
 * camelCase `CategoryRecord`; timestamps are epoch milliseconds. Categories are
 * not secret, so — unlike channels/monitors — nothing here is encrypted or
 * redacted.
 *
 * `slug` is UNIQUE. Duplicate-slug attempts are surfaced as a typed
 * `SlugConflictError` the route maps to HTTP 409. We pre-check with
 * `getCategoryBySlug` AND catch the D1 UNIQUE violation, so a race that slips
 * past the pre-check is still reported cleanly.
 */

/** Thrown when an insert/update would collide with an existing category slug. */
export class SlugConflictError extends Error {
  constructor(public readonly slug: string) {
    super(`category slug already exists: ${slug}`);
    this.name = "SlugConflictError";
  }
}

/** True when a thrown D1 error is a UNIQUE-constraint violation. */
function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(msg);
}

export interface CategoryRecord {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/** Raw shape of a `categories` row as returned by D1. */
interface CategoryRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  sort_order: number | null;
  created_at: number;
  updated_at: number;
}

/** Map a raw row to a typed record (sort_order is nullable in the schema). */
export function rowToCategory(row: CategoryRow): CategoryRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? null,
    sortOrder: row.sort_order ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listCategories(env: Env): Promise<CategoryRecord[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM categories ORDER BY sort_order, name",
  ).all<CategoryRow>();
  return (res.results ?? []).map(rowToCategory);
}

export async function getCategory(
  env: Env,
  id: string,
): Promise<CategoryRecord | null> {
  const row = await env.DB.prepare("SELECT * FROM categories WHERE id = ?")
    .bind(id)
    .first<CategoryRow>();
  return row ? rowToCategory(row) : null;
}

export async function getCategoryBySlug(
  env: Env,
  slug: string,
): Promise<CategoryRecord | null> {
  const row = await env.DB.prepare("SELECT * FROM categories WHERE slug = ?")
    .bind(slug)
    .first<CategoryRow>();
  return row ? rowToCategory(row) : null;
}

export async function createCategory(
  env: Env,
  input: CategoryInput,
): Promise<CategoryRecord> {
  // Pre-check for a friendly 409 before spending an id/insert.
  if (await getCategoryBySlug(env, input.slug)) {
    throw new SlugConflictError(input.slug);
  }

  const id = newId("cat");
  const now = Date.now();
  try {
    await env.DB.prepare(
      `INSERT INTO categories (
         id, slug, name, description, sort_order, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        input.slug,
        input.name,
        input.description ?? null,
        input.sortOrder,
        now,
        now,
      )
      .run();
  } catch (err) {
    // Belt-and-suspenders: a concurrent insert can win between the pre-check
    // and here — the UNIQUE index still protects us, so map it to a 409 too.
    if (isUniqueViolation(err)) throw new SlugConflictError(input.slug);
    throw err;
  }

  const created = await getCategory(env, id);
  if (!created) {
    throw new Error("createCategory: failed to read back inserted row");
  }
  return created;
}

export async function updateCategory(
  env: Env,
  id: string,
  input: CategoryInput,
): Promise<CategoryRecord | null> {
  const existing = await getCategory(env, id);
  if (!existing) return null;

  // Slug uniqueness, allowing the row to keep its own slug.
  if (input.slug !== existing.slug) {
    const clash = await getCategoryBySlug(env, input.slug);
    if (clash && clash.id !== id) throw new SlugConflictError(input.slug);
  }

  // Full replace of mutable fields; id and created_at are preserved.
  const now = Date.now();
  try {
    await env.DB.prepare(
      `UPDATE categories SET
         slug = ?, name = ?, description = ?, sort_order = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        input.slug,
        input.name,
        input.description ?? null,
        input.sortOrder,
        now,
        id,
      )
      .run();
  } catch (err) {
    if (isUniqueViolation(err)) throw new SlugConflictError(input.slug);
    throw err;
  }

  return getCategory(env, id);
}

export async function deleteCategory(env: Env, id: string): Promise<void> {
  // Explicit cleanup mirroring deleteMonitor: null out the FK on any monitors
  // that reference this category, then delete the row - batched as one
  // transaction so it works regardless of whether FK enforcement is active.
  await env.DB.batch([
    env.DB.prepare("UPDATE monitors SET category_id = NULL WHERE category_id = ?").bind(id),
    env.DB.prepare("DELETE FROM categories WHERE id = ?").bind(id),
  ]);

  // Also scrub the deleted id from any status page's category_ids JSON array.
  // Filtering happens on live monitor.categoryId so a stale id already fails
  // closed (no leak), but leaving dead ids around is untidy and could silently
  // shrink a page. Read-modify-write only the affected pages.
  const affected = await env.DB.prepare(
    "SELECT id, category_ids FROM status_pages WHERE category_ids LIKE ?",
  )
    .bind(`%${id}%`)
    .all<{ id: string; category_ids: string | null }>();
  const now = Date.now();
  for (const page of affected.results ?? []) {
    let ids: string[];
    try {
      ids = JSON.parse(page.category_ids ?? "[]") as string[];
    } catch {
      continue;
    }
    if (!Array.isArray(ids) || !ids.includes(id)) continue;
    const next = ids.filter((c) => c !== id);
    await env.DB.prepare(
      "UPDATE status_pages SET category_ids = ?, updated_at = ? WHERE id = ?",
    )
      .bind(JSON.stringify(next), now, page.id)
      .run();
  }
}
