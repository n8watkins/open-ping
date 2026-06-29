import type { Env } from "../../types";
import { getSetting, setSetting } from "../../db/settings";
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

/** Return the public key, generating + persisting a keypair if none exists. */
export async function ensureVapidPublicKey(env: Env): Promise<string> {
  const existing = env.VAPID_PUBLIC_KEY ?? (await getSetting(env, "vapid_public_key"));
  if (existing) return existing;
  const { publicKey, privateKey } = await generateVapidKeys();
  await setSetting(env, "vapid_public_key", publicKey);
  await setSetting(env, "vapid_private_key", privateKey, { secret: !!env.MASTER_KEY });
  return publicKey;
}

export async function isVapidConfigured(env: Env): Promise<boolean> {
  return !!(env.VAPID_PUBLIC_KEY ?? (await getSetting(env, "vapid_public_key")));
}
