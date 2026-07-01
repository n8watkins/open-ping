import { Hono } from "hono";
import type { AppEnv } from "../types";
import { requireAuth } from "../middleware/auth";
import { statusPageSchema } from "../../shared/schemas";
import {
  createStatusPage,
  deleteStatusPage,
  getStatusPage,
  listStatusPages,
  updateStatusPage,
  StatusPageError,
} from "../db/status-pages";

/**
 * Status-page CRUD API mounted at /api/status-pages (PRD §16 — multiple public
 * status pages). All routes require an authenticated session; the auth
 * middleware also enforces CSRF on mutations. Bodies are validated with the
 * shared `statusPageSchema`. The default page's `is_default` flag is managed
 * elsewhere; create never sets it, update never touches it, and the default page
 * cannot be deleted (→ 400). A slug already owned by another page → 409.
 */
export const statusPages = new Hono<AppEnv>();

statusPages.use("*", requireAuth);

statusPages.get("/", async (c) => {
  const list = await listStatusPages(c.env);
  return c.json({ statusPages: list });
});

statusPages.post("/", async (c) => {
  const body = await c.req.json().catch(() => undefined);
  const parsed = statusPageSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation", issues: parsed.error.issues }, 400);
  }
  try {
    const statusPage = await createStatusPage(c.env, parsed.data);
    return c.json({ statusPage }, 201);
  } catch (err) {
    if (err instanceof StatusPageError && err.code === "slug_conflict") {
      return c.json({ error: "slug_conflict", message: err.message }, 409);
    }
    throw err;
  }
});

statusPages.get("/:id", async (c) => {
  const statusPage = await getStatusPage(c.env, c.req.param("id"));
  if (!statusPage) return c.json({ error: "not_found" }, 404);
  return c.json({ statusPage });
});

statusPages.put("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => undefined);
  const parsed = statusPageSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation", issues: parsed.error.issues }, 400);
  }
  try {
    const statusPage = await updateStatusPage(c.env, id, parsed.data);
    if (!statusPage) return c.json({ error: "not_found" }, 404);
    return c.json({ statusPage });
  } catch (err) {
    if (err instanceof StatusPageError && err.code === "slug_conflict") {
      return c.json({ error: "slug_conflict", message: err.message }, 409);
    }
    throw err;
  }
});

statusPages.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await getStatusPage(c.env, id);
  if (!existing) return c.json({ error: "not_found" }, 404);
  try {
    await deleteStatusPage(c.env, id);
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof StatusPageError && err.code === "default_not_deletable") {
      return c.json({ error: "default_not_deletable", message: err.message }, 400);
    }
    throw err;
  }
});
