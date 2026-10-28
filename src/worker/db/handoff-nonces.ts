import { HANDOFF_NONCE_RETENTION_SECONDS } from "../../shared/hosted-contract";
import type { Env } from "../types";

/**
 * Single use for OpenPing Hosted sign-in hand-offs (docs/hosted/CONTRACT.md,
 * section 7; migration 0018). Called only after a token's signature, audience
 * and times have been verified, so nothing unsigned ever reaches the table.
 */

/** When a nonce from a token expiring at `expSeconds` may be forgotten (epoch ms). */
export function nonceExpiresAt(expSeconds: number): number {
  return (expSeconds + HANDOFF_NONCE_RETENTION_SECONDS) * 1000;
}

/**
 * Records `nonce` as used. True when this call recorded it; false when it was
 * already there (a replay). One statement, so two requests racing with the
 * same token can't both win: the primary key lets exactly one insert happen.
 */
export async function recordHandoffNonce(
  env: Env,
  nonce: string,
  expSeconds: number,
  now: number = Date.now(),
): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT INTO used_handoff_nonces (nonce, used_at, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(nonce) DO NOTHING`,
  )
    .bind(nonce, now, nonceExpiresAt(expSeconds))
    .run();
  return result.meta.changes === 1;
}
