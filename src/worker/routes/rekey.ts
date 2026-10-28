import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { requireAuth } from "../middleware/auth";
import { getKeyring } from "../lib/crypto";
import {
  DEFAULT_ROWS_PER_CALL,
  MAX_ROWS_PER_CALL,
  decodeCursor,
  rekeyPrecondition,
  rekeyStatus,
  runRekeyBatch,
} from "../lib/rekey";

/**
 * MASTER_KEY rotation API, mounted at /api/admin/rekey. Admin-only: a session
 * (with CSRF on the POST) or the API_TOKEN bearer, like every admin route.
 *
 * - `GET /status` counts every protected value by key and says whether
 *   MASTER_KEY_PREVIOUS can be deleted.
 * - `POST /` runs one bounded batch of the re-encryption pass. Call it again
 *   with the returned `cursor` until `done` is true. It is idempotent: running
 *   it twice, or concurrently, only rewrites what is not yet on the current key.
 *
 * Neither ever returns a stored value, plaintext or ciphertext.
 */
export const rekey = new Hono<AppEnv>();

rekey.use("*", requireAuth);

rekey.get("/status", async (c) => {
  return c.json(await rekeyStatus(c.env));
});

const batchSchema = z
  .object({
    cursor: z.string().max(1024).nullable().optional(),
    limit: z.number().int().min(1).max(MAX_ROWS_PER_CALL).optional(),
  })
  .strict();

rekey.post("/", async (c) => {
  const body: unknown = await c.req.json().catch(() => ({}));
  const parsed = batchSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: "validation", issues: parsed.error.issues }, 400);
  }
  let cursor = undefined;
  if (parsed.data.cursor) {
    const decoded = decodeCursor(parsed.data.cursor);
    if (!decoded) return c.json({ error: "invalid_cursor" }, 400);
    cursor = decoded;
  }

  let keyring;
  try {
    keyring = await getKeyring(c.env);
  } catch {
    return c.json({ error: "master_key_invalid" }, 409);
  }
  const blocked = rekeyPrecondition(keyring);
  if (blocked) return c.json({ error: blocked }, 409);

  const result = await runRekeyBatch(
    c.env,
    keyring,
    cursor,
    parsed.data.limit ?? DEFAULT_ROWS_PER_CALL,
  );
  return c.json(result);
});
