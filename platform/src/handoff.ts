/**
 * Minting the sign-in hand-off (contract, section 7): a single-use,
 * 60-second Ed25519 token that a customer's OpenPing verifies with
 * HANDOFF_PUBLIC_KEY and turns into its own session.
 *
 * Built only from the contract's helpers (handoffClaims, signHandoffToken),
 * so the token is exactly what src/worker/routes/hosted-auth.ts verifies.
 */

import {
  HANDOFF_PATH,
  HANDOFF_QUERY_PARAM,
  handoffClaims,
  importHandoffPrivateKey,
  signHandoffToken,
  type HandoffRole,
} from "../../src/shared/hosted-contract";

/** Imported keys per isolate, by secret value (at most the current and the next one). */
const keys = new Map<string, Promise<CryptoKey>>();

function signingKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    if (keys.size >= 2) keys.clear();
    key = importHandoffPrivateKey(secret);
    key.catch(() => keys.delete(secret));
    keys.set(secret, key);
  }
  return key;
}

export interface HandoffInput {
  tenantId: string;
  accountId: string;
  email: string;
  role?: HandoffRole;
  now: number;
}

/** A signed token for `tenantId`. Throws when HANDOFF_SIGNING_KEY isn't a valid key. */
export async function mintHandoffToken(signingSecret: string, input: HandoffInput): Promise<string> {
  const claims = handoffClaims({ tenantId: input.tenantId, accountId: input.accountId, email: input.email, role: input.role ?? "customer", now: input.now });
  return signHandoffToken(claims, await signingKey(signingSecret));
}

/** Where the browser goes: `<tenant origin>/auth/hosted?t=<token>`. */
export function handoffUrl(tenantOrigin: string, token: string): string {
  return `${tenantOrigin}${HANDOFF_PATH}?${HANDOFF_QUERY_PARAM}=${encodeURIComponent(token)}`;
}
