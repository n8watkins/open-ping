import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { requireAuth } from "../middleware/auth";
import {
  countApiTokens,
  createApiToken,
  deleteApiToken,
  listApiTokens,
  MAX_API_TOKENS,
} from "../db/api-tokens";

/**
 * Named admin API tokens, mounted at /api/api-tokens (Developers in the app).
 *
 * Every token grants full admin access, like the API_TOKEN Worker secret. A
 * token is returned once, when it is created; only its hash is stored.
 *
 * Creating and revoking need a browser session (with CSRF, as requireAuth
 * enforces): a token, possibly a leaked one, can neither mint a longer-lived
 * replacement nor revoke the owner's other tokens. Listing works with either.
 */
export const apiTokens = new Hono<AppEnv>();
apiTokens.use("*", requireAuth);

const createBody = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the token a name, like the client that will use it.")
    .max(64, "Keep the name to 64 characters."),
});

apiTokens.get("/", async (c) => {
  return c.json({
    tokens: await listApiTokens(c.env),
    // Whether the API_TOKEN Worker secret is set; its value is never sent.
    secretConfigured: !!c.env.API_TOKEN,
    max: MAX_API_TOKENS,
  });
});

apiTokens.post("/", async (c) => {
  if (!c.get("session")) return c.json({ error: "session_required" }, 403);
  const parsed = createBody.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "validation", issues: parsed.error.issues }, 400);
  if ((await countApiTokens(c.env)) >= MAX_API_TOKENS) {
    return c.json({ error: "too_many_tokens", message: `At most ${MAX_API_TOKENS} tokens; revoke one first.` }, 409);
  }
  const { token, summary } = await createApiToken(c.env, parsed.data.name);
  c.header("Cache-Control", "no-store");
  return c.json({ token, apiToken: summary }, 201);
});

apiTokens.delete("/:id", async (c) => {
  if (!c.get("session")) return c.json({ error: "session_required" }, 403);
  const removed = await deleteApiToken(c.env, c.req.param("id"));
  if (!removed) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});
