import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../types";
import { requireAuth } from "../middleware/auth";
import { statusPageSchema } from "../../shared/schemas";
import {
  type StatusPageRecord,
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

/** The fields a status page update may set (every key of `statusPageSchema`). */
const STATUS_PAGE_FIELDS = Object.keys(statusPageSchema.shape) as (keyof typeof statusPageSchema.shape)[];

/**
 * A partial status page update: only the fields present change, and null
 * clears an optional text or URL field. The merged page is validated with the
 * same `statusPageSchema` as a full PUT.
 */
export const statusPagePatchSchema = z
  .object(
    Object.fromEntries(STATUS_PAGE_FIELDS.map((k) => [k, z.unknown().optional()])) as Record<
      (typeof STATUS_PAGE_FIELDS)[number],
      z.ZodOptional<z.ZodUnknown>
    >,
  )
  .strict();

/** PURE. A stored page as a full `statusPageSchema` input (nulls become absent). */
export function statusPageToInput(page: StatusPageRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of STATUS_PAGE_FIELDS) {
    const value = (page as unknown as Record<string, unknown>)[key];
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

/** PURE. Apply a validated patch to a stored page, giving a full input body. */
export function mergeStatusPagePatch(
  page: StatusPageRecord,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out = statusPageToInput(page);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return out;
}

/** Outcome of a status page update, mapped to a response by each caller. */
export type StatusPageWriteResult =
  | { ok: true; statusPage: StatusPageRecord }
  | {
      ok: false;
      status: 400 | 404 | 409;
      error: "validation" | "not_found" | "slug_conflict";
      issues?: z.core.$ZodIssue[];
      message?: string;
    };

/** Validate and partially update a page (PATCH /api/status-pages/:id and MCP). */
export async function patchStatusPage(
  env: Env,
  id: string,
  body: unknown,
): Promise<StatusPageWriteResult> {
  const patch = statusPagePatchSchema.safeParse(body);
  if (!patch.success) {
    return { ok: false, status: 400, error: "validation", issues: patch.error.issues };
  }
  const existing = await getStatusPage(env, id);
  if (!existing) return { ok: false, status: 404, error: "not_found" };
  const parsed = statusPageSchema.safeParse(mergeStatusPagePatch(existing, patch.data));
  if (!parsed.success) {
    return { ok: false, status: 400, error: "validation", issues: parsed.error.issues };
  }
  try {
    const statusPage = await updateStatusPage(env, id, parsed.data);
    if (!statusPage) return { ok: false, status: 404, error: "not_found" };
    return { ok: true, statusPage };
  } catch (err) {
    if (err instanceof StatusPageError && err.code === "slug_conflict") {
      return { ok: false, status: 409, error: "slug_conflict", message: err.message };
    }
    throw err;
  }
}

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

/** Partial update: see {@link statusPagePatchSchema}. */
statusPages.patch("/:id", async (c) => {
  const body = await c.req.json().catch(() => undefined);
  const r = await patchStatusPage(c.env, c.req.param("id"), body);
  if (r.ok) return c.json({ statusPage: r.statusPage });
  const { ok: _ok, status, ...error } = r;
  return c.json(error, status);
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
