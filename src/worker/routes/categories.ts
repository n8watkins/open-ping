import { Hono } from "hono";
import type { AppEnv } from "../types";
import { requireAuth } from "../middleware/auth";
import { categorySchema } from "../../shared/schemas";
import {
  createCategory,
  deleteCategory,
  getCategory,
  listCategories,
  updateCategory,
  SlugConflictError,
} from "../db/categories";

/**
 * Category CRUD API mounted at /api/categories. Categories group monitors and
 * back the per-category public status pages. All routes require an authenticated
 * session; the auth middleware also enforces CSRF on mutations.
 *
 * Categories are not secret, so responses are returned verbatim (no redaction).
 * A duplicate `slug` returns 409; validation failures return 400.
 */
export const categories = new Hono<AppEnv>();

categories.use("*", requireAuth);

categories.get("/", async (c) => {
  const list = await listCategories(c.env);
  return c.json({ categories: list });
});

categories.post("/", async (c) => {
  const body = await c.req.json().catch(() => undefined);
  const parsed = categorySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation", issues: parsed.error.issues }, 400);
  }
  try {
    const category = await createCategory(c.env, parsed.data);
    return c.json({ category }, 201);
  } catch (err) {
    if (err instanceof SlugConflictError) {
      return c.json({ error: "slug_conflict", slug: err.slug }, 409);
    }
    throw err;
  }
});

categories.get("/:id", async (c) => {
  const category = await getCategory(c.env, c.req.param("id"));
  if (!category) return c.json({ error: "not_found" }, 404);
  return c.json({ category });
});

categories.put("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => undefined);
  const parsed = categorySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation", issues: parsed.error.issues }, 400);
  }
  const existing = await getCategory(c.env, id);
  if (!existing) return c.json({ error: "not_found" }, 404);
  try {
    const category = await updateCategory(c.env, id, parsed.data);
    if (!category) return c.json({ error: "not_found" }, 404);
    return c.json({ category });
  } catch (err) {
    if (err instanceof SlugConflictError) {
      return c.json({ error: "slug_conflict", slug: err.slug }, 409);
    }
    throw err;
  }
});

categories.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await getCategory(c.env, id);
  if (!existing) return c.json({ error: "not_found" }, 404);
  await deleteCategory(c.env, id);
  return c.json({ ok: true });
});
