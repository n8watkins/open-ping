import type { Env } from "../../types";
import { getSetting } from "../../db/settings";
import { encryptValue } from "../../lib/crypto";
import { getAdminEmail } from "../../lib/admin";
import { generateVapidKeys, type VapidKeys } from "./webpush";

/**
 * VAPID key management. Keys may come from Worker secrets (VAPID_PUBLIC_KEY /
 * VAPID_PRIVATE_KEY) or, if not provided, are generated once and stored in
 * settings (private encrypted when a MASTER_KEY is configured).
 */

async function vapidSubject(env: Env): Promise<string> {
  const configured = env.VAPID_SUBJECT ?? (await getSetting(env, "vapid_subject"));
  if (configured) return configured;
  const email = await getAdminEmail(env);
  return email ? `mailto:${email}` : "mailto:admin@openping.local";
}

/** Resolve a usable VAPID keypair, or null if none is configured. */
export async function getVapid(env: Env): Promise<VapidKeys | null> {
  const publicKey = env.VAPID_PUBLIC_KEY ?? (await getSetting(env, "vapid_public_key"));
  const privateKey =
    env.VAPID_PRIVATE_KEY ?? (await getSetting(env, "vapid_private_key"));
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject: await vapidSubject(env) };
}

/**
 * Atomically persist a freshly generated VAPID keypair, first-writer-wins.
 *
 * The two keys were previously written in two separate awaits, so two concurrent
 * first-time callers (each generating its OWN keypair) could interleave and
 * persist a mismatched public/private pair — silently breaking ALL push. Writing
 * both rows in a single D1 batch (one transaction) with ON CONFLICT DO NOTHING
 * means the first complete pair wins and is never half-overwritten by a racing
 * caller. The private key is encrypted exactly as `setSetting` would; the raw
 * insert is only needed here because `setSetting` can't write two rows atomically.
 */
async function persistVapidPair(
  env: Env,
  publicKey: string,
  privateKey: string,
): Promise<void> {
  const secret = !!env.MASTER_KEY;
  const storedPrivate = secret ? await encryptValue(env, privateKey) : privateKey;
  const now = Date.now();
  const claim = (key: string, value: string, encrypted: number) =>
    env.DB.prepare(
      `INSERT INTO settings (key, value, encrypted, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO NOTHING`,
    ).bind(key, value, encrypted, now);
  await env.DB.batch([
    claim("vapid_public_key", publicKey, 0),
    claim("vapid_private_key", storedPrivate, secret ? 1 : 0),
  ]);
}

/** Return the public key, generating + persisting a keypair if none exists. */
export async function ensureVapidPublicKey(env: Env): Promise<string> {
  const existing = env.VAPID_PUBLIC_KEY ?? (await getSetting(env, "vapid_public_key"));
  if (existing) return existing;
  const { publicKey, privateKey } = await generateVapidKeys();
  await persistVapidPair(env, publicKey, privateKey);
  // Re-read: if a concurrent caller's pair won the first-writer-wins race, return
  // the public key that was actually persisted (and matches the stored private
  // key) rather than the one we generated but did not store.
  return (await getSetting(env, "vapid_public_key")) ?? publicKey;
}

export async function isVapidConfigured(env: Env): Promise<boolean> {
  return !!(env.VAPID_PUBLIC_KEY ?? (await getSetting(env, "vapid_public_key")));
}
