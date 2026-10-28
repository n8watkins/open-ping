/**
 * Passkeys on the platform account, verified by OpenPing's own WebAuthn code
 * (src/worker/lib/webauthn.ts), so both sides share one audited
 * implementation. The relying party is app.<domain>; a customer's OpenPing
 * keeps its own passkeys for its own address (contract, section 2).
 *
 * Sign-in uses discoverable credentials: no email is asked for, the
 * authenticator offers the account's passkey, and its user handle (the
 * account's webauthn_handle) says whose it is.
 */

import { newId } from "../../../src/worker/lib/ids";
import {
  SUPPORTED_ALGS,
  WebAuthnError,
  base64urlEncode,
  verifyAuthentication,
  verifyRegistration,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "../../../src/worker/lib/webauthn";
import type { Account } from "../accounts";

export const RP_NAME = "OpenPing Hosted";
export const MAX_PASSKEYS = 10;
const TIMEOUT_MS = 120_000;

export interface PasskeyExpectation {
  /** The page's origin, `https://app.<domain>`. */
  origin: string;
  /** Its hostname, `app.<domain>`. */
  rpId: string;
}

export interface Passkey {
  id: string;
  credentialId: string;
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  backedUp: boolean;
}

export const newChallenge = () => base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));

/** The account's WebAuthn user handle, made on first use. */
export async function ensureWebauthnHandle(db: D1Database, account: Account): Promise<string> {
  if (account.webauthnHandle) return account.webauthnHandle;
  const handle = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  await db.prepare("UPDATE accounts SET webauthn_handle = ? WHERE id = ? AND webauthn_handle IS NULL").bind(handle, account.id).run();
  const row = await db.prepare("SELECT webauthn_handle FROM accounts WHERE id = ?").bind(account.id).first<{ webauthn_handle: string }>();
  return row!.webauthn_handle;
}

export async function listPasskeys(db: D1Database, accountId: string): Promise<Passkey[]> {
  const rows = await db
    .prepare(
      `SELECT id, subject, label, created_at, last_used_at, backup_state FROM account_identities
       WHERE account_id = ? AND kind = 'passkey' ORDER BY created_at`,
    )
    .bind(accountId)
    .all<{ id: string; subject: string; label: string | null; created_at: number; last_used_at: number | null; backup_state: number }>();
  return rows.results.map((r) => ({
    id: r.id,
    credentialId: r.subject,
    label: r.label,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    backedUp: r.backup_state === 1,
  }));
}

/** Options for navigator.credentials.create(), as JSON. */
export function registrationOptions(input: {
  challenge: string;
  rpId: string;
  handle: string;
  email: string;
  existing: Passkey[];
}) {
  return {
    challenge: input.challenge,
    rp: { id: input.rpId, name: RP_NAME },
    user: { id: input.handle, name: input.email, displayName: input.email },
    pubKeyCredParams: SUPPORTED_ALGS.map((alg) => ({ type: "public-key" as const, alg })),
    timeout: TIMEOUT_MS,
    attestation: "none" as const,
    authenticatorSelection: { residentKey: "required" as const, requireResidentKey: true, userVerification: "preferred" as const },
    excludeCredentials: input.existing.map((p) => ({ type: "public-key" as const, id: p.credentialId })),
  };
}

/** Options for navigator.credentials.get(), as JSON: no list, so the authenticator offers what it has. */
export function signInOptions(input: { challenge: string; rpId: string }) {
  return { challenge: input.challenge, rpId: input.rpId, timeout: TIMEOUT_MS, userVerification: "preferred" as const };
}

/** A short name for a new passkey: what the browser said it is, or a default. */
export function passkeyLabel(input: unknown): string {
  // Printable characters only: control characters never reach a page.
  const text = typeof input === "string" ? [...input].filter((ch) => ch >= " " && ch !== "\u007f").join("").trim().slice(0, 60) : "";
  return text || "Passkey";
}

/** Verifies and stores a new passkey for `account`. Throws WebAuthnError when it doesn't verify. */
export async function addPasskey(
  db: D1Database,
  input: { account: Account; credential: RegistrationResponseJSON; challenge: string; expect: PasskeyExpectation; label: string; now: number },
): Promise<string> {
  const verified = await verifyRegistration(input.credential, { challenge: input.challenge, origin: input.expect.origin, rpId: input.expect.rpId });
  const id = newId("idn");
  const transports = Array.isArray(input.credential.response.transports)
    ? JSON.stringify(input.credential.response.transports.filter((t) => typeof t === "string").slice(0, 8))
    : null;
  const result = await db
    .prepare(
      `INSERT INTO account_identities (id, account_id, kind, subject, label, public_key, alg, sign_count, transports, backup_eligible, backup_state, created_at)
       VALUES (?, ?, 'passkey', ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(kind, subject) DO NOTHING`,
    )
    .bind(
      id,
      input.account.id,
      verified.credentialId,
      input.label,
      verified.publicKey,
      verified.alg,
      verified.signCount,
      transports,
      verified.backupEligible ? 1 : 0,
      verified.backupState ? 1 : 0,
      input.now,
    )
    .run();
  if ((result.meta.changes ?? 0) === 0) throw new WebAuthnError("malformed", "this passkey is already registered");
  return id;
}

/**
 * Verifies a passkey sign-in and answers the account id. Throws
 * WebAuthnError for an unknown passkey or one that doesn't verify.
 */
export async function verifyPasskeySignIn(
  db: D1Database,
  input: { credential: AuthenticationResponseJSON; challenge: string; expect: PasskeyExpectation; now: number },
): Promise<string> {
  const credentialId = typeof input.credential?.rawId === "string" ? input.credential.rawId : "";
  const row = await db
    .prepare(
      `SELECT i.id, i.account_id, i.public_key, i.sign_count, a.webauthn_handle
       FROM account_identities i JOIN accounts a ON a.id = i.account_id
       WHERE i.kind = 'passkey' AND i.subject = ?`,
    )
    .bind(credentialId)
    .first<{ id: string; account_id: string; public_key: string; sign_count: number; webauthn_handle: string | null }>();
  if (!row || !row.webauthn_handle) throw new WebAuthnError("malformed", "unknown passkey");
  const verified = await verifyAuthentication(
    input.credential,
    { challenge: input.challenge, origin: input.expect.origin, rpId: input.expect.rpId, userHandle: row.webauthn_handle },
    { credentialId, publicKey: row.public_key, signCount: row.sign_count },
  );
  await db
    .prepare("UPDATE account_identities SET sign_count = ?, backup_state = ?, last_used_at = ? WHERE id = ?")
    .bind(verified.signCount, verified.backupState ? 1 : 0, input.now, row.id)
    .run();
  return row.account_id;
}

export async function removePasskey(db: D1Database, accountId: string, identityId: string): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM account_identities WHERE id = ? AND account_id = ? AND kind = 'passkey'")
    .bind(identityId, accountId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
