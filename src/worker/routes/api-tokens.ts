import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { requireAuth } from "../middleware/auth";
import {
  countApiTokens,
  createApiToken,
  EXPIRY_DAYS,
  listApiTokens,
  listRevokedApiTokens,
  MAX_API_TOKENS,
  revokeApiToken,
} from "../db/api-tokens";
import { SCOPES } from "../lib/scopes";

/**
 * Named API tokens, mounted at /api/api-tokens (Developers in the app).
 *
 * Each token has scopes (lib/scopes.ts) and an optional expiry. A token is
 * returned once, when it is created; only its hash is stored. Revoking keeps
 * the row (revoked_at) as an audit record.
 *
 * Listing, creating and revoking need a browser session (with CSRF on changes,
 * as requireAuth enforces): no token, not even an admin one or the API_TOKEN
 * secret, can see the others, mint a longer-lived or broader replacement, or
 * revoke the owner's other tokens. ROUTE_SCOPES marks these routes "session",
 * so requireScope refuses a token before a handler runs. A token may only ask
 * about itself (GET /self, for `op token whoami`).
 */
export const apiTokens = new Hono<AppEnv>();
apiTokens.use("*", requireAuth);

const createBody = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the token a name, like the client that will use it.")
    .max(64, "Keep the name to 64 characters."),
  // Absent means admin, what every token could do before scopes existed.
  scopes: z.array(z.enum(SCOPES)).min(1, "Choose at least one scope.").max(SCOPES.length).optional(),
  expiresInDays: z
    .union([z.literal(7), z.literal(30), z.literal(90), z.null()])
    .optional()
    .describe(`One of ${EXPIRY_DAYS.join(", ")} (null: never).`),
});

apiTokens.get("/self", async (c) => {
  const token = c.get("token");
  if (!token) return c.json({ kind: "session", scopes: ["admin"] });
  if (token.kind === "secret") return c.json({ kind: "secret", name: "API_TOKEN secret", scopes: token.scopes, expiresAt: null });
  return c.json({ kind: "token", id: token.id, name: token.name, scopes: token.scopes, expiresAt: token.expiresAt });
});

apiTokens.get("/", async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({
    tokens: await listApiTokens(c.env),
    revoked: await listRevokedApiTokens(c.env),
    // Whether the API_TOKEN Worker secret is set; its value is never sent.
    secretConfigured: !!c.env.API_TOKEN,
    max: MAX_API_TOKENS,
  });
});

apiTokens.post("/", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "session_required" }, 403);
  const parsed = createBody.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "validation", issues: parsed.error.issues }, 400);
  if ((await countApiTokens(c.env)) >= MAX_API_TOKENS) {
    return c.json({ error: "too_many_tokens", message: `At most ${MAX_API_TOKENS} tokens; revoke one first.` }, 409);
  }
  const { token, summary } = await createApiToken(c.env, {
    name: parsed.data.name,
    scopes: parsed.data.scopes ?? ["admin"],
    expiresInDays: parsed.data.expiresInDays ?? null,
    createdVia: `${session.identity_kind}:${session.identity}`.slice(0, 200),
  });
  c.header("Cache-Control", "no-store");
  return c.json({ token, apiToken: summary }, 201);
});

apiTokens.delete("/:id", async (c) => {
  if (!c.get("session")) return c.json({ error: "session_required" }, 403);
  const revoked = await revokeApiToken(c.env, c.req.param("id"));
  if (!revoked) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});
