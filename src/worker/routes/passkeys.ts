import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../types";
import { requireAuth } from "../middleware/auth";
import { createSession, revokeAllSessions } from "../lib/sessions";
import { appUrlFromEnv } from "../lib/app-origin";
import { hitRateLimit } from "../db/rate-limit";
import { getAdminEmail, getAdminGithubLogin } from "../lib/admin";
import { isSetupComplete, isSetupTokenUnspent, spendSetupToken } from "../db/setup";
import {
  countPasskeys,
  deletePasskey,
  getPasskeyByCredentialId,
  getUserHandle,
  listPasskeys,
  recordPasskeyUse,
  summarize,
} from "../db/passkeys";
import {
  authenticationCredentialSchema,
  authenticationOptions,
  ceremonyErrorResponse,
  consumeChallenge,
  finishRegistration,
  issueChallenge,
  originAllowed,
  passkeyNameSchema,
  registrationCredentialSchema,
  relyingParty,
  startRegistration,
} from "../lib/passkey-ceremony";
import { verifyAuthentication, WebAuthnError } from "../lib/webauthn";
import { checkSetupToken } from "./setup";
import { hostedMode } from "../lib/hosted";

/**
 * Passkeys (WebAuthn) for the single administrator.
 *
 * - /api/passkeys (signed in): list, add and remove passkeys from Settings.
 * - /api/auth/passkeys (public): usernameless sign-in, and recovery with a new
 *   SETUP_TOKEN when every passkey is lost.
 *
 * Ceremony details (challenges, relying party, verification) live in
 * lib/passkey-ceremony.ts and lib/webauthn.ts.
 */
export const passkeysAdmin = new Hono<AppEnv>();
export const passkeyAuth = new Hono<AppEnv>();

const LOGIN_PER_IP_LIMIT = 30;
const LOGIN_GLOBAL_LIMIT = 600;
const RECOVERY_PER_IP_LIMIT = 5;
const RECOVERY_GLOBAL_LIMIT = 20;
const UNKNOWN_IP = "unknown";
const SETUP_TOKEN_HEADER = "x-setup-token";

const nameBody = z.object({ name: passkeyNameSchema.optional() });
const registrationBody = z.object({ credential: registrationCredentialSchema });
const authenticationBody = z.object({ credential: authenticationCredentialSchema });

/**
 * Which other ways in actually work: GitHub needs the OAuth app and an admin
 * login, email needs an admin address and Resend to send the link. In hosted
 * mode the platform's sign-in hand-off is always a way in, and the other two
 * don't exist.
 */
export async function otherSignInMethods(
  env: Env,
): Promise<{ github: boolean; email: boolean; hosted?: true }> {
  if (hostedMode(env)) return { github: false, email: false, hosted: true };
  return {
    github: !!env.GITHUB_CLIENT_ID && !!env.GITHUB_CLIENT_SECRET && !!(await getAdminGithubLogin(env)),
    email: !!env.RESEND_API_KEY && !!(await getAdminEmail(env)),
  };
}

/** Fixed-window per-IP and global limits, as the other public sign-in flows have. */
async function limited(
  c: Parameters<typeof ceremonyErrorResponse>[0],
  scope: string,
  perIp: number,
  global: number,
): Promise<Response | null> {
  const ip = c.req.header("cf-connecting-ip") ?? UNKNOWN_IP;
  for (const [key, limit] of [
    [`${scope}:ip:${ip}`, perIp],
    [`${scope}:global`, global],
  ] as const) {
    const hit = await hitRateLimit(c.env, key, limit);
    if (!hit.allowed) {
      c.header("Retry-After", String(hit.retryAfterSeconds));
      return c.json({ error: "rate_limited" }, 429);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Settings: /api/passkeys
// ---------------------------------------------------------------------------

passkeysAdmin.use("*", requireAuth);

passkeysAdmin.get("/", async (c) => {
  const session = c.get("session");
  const rp = await relyingParty(c);
  return c.json({
    passkeys: (await listPasskeys(c.env)).map(summarize),
    rpId: rp.rpId,
    origin: rp.origin,
    // When set, the Installation URL setting can't move passkeys (lib/app-origin.ts).
    appUrlFromEnv: appUrlFromEnv(c.env),
    currentPasskeyId: session?.identity_kind === "passkey" ? session.identity : null,
    otherSignIn: await otherSignInMethods(c.env),
  });
});

passkeysAdmin.post("/register/options", async (c) => {
  // Registration needs a browser session; the API token has no authenticator.
  const session = c.get("session");
  if (!session) return c.json({ error: "session_required" }, 403);
  const parsed = nameBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "validation", issues: parsed.error.issues }, 400);
  const options = await startRegistration(c, "settings", parsed.data.name ?? "Passkey", session.id);
  return c.json({ options });
});

passkeysAdmin.post("/register/verify", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "session_required" }, 403);
  const parsed = registrationBody.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "validation", issues: parsed.error.issues }, 400);
  try {
    const row = await finishRegistration(c, "settings", parsed.data.credential, session.id);
    return c.json({ passkey: summarize(row) }, 201);
  } catch (e) {
    return ceremonyErrorResponse(c, e);
  }
});

passkeysAdmin.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const all = await listPasskeys(c.env);
  const target = all.find((p) => p.id === id);
  if (!target) return c.json({ error: "not_found" }, 404);
  // Never remove the only way in. GitHub or email, or another passkey for this
  // hostname, must still work afterwards; otherwise only SETUP_TOKEN recovery
  // would remain. A passkey for another hostname can't sign in here, so it
  // neither counts as a way in nor is one to protect.
  const { rpId } = await relyingParty(c);
  if (target.rp_id === rpId && !all.some((p) => p.id !== id && p.rp_id === rpId)) {
    const others = await otherSignInMethods(c.env);
    if (!others.github && !others.email && !others.hosted) return c.json({ error: "last_sign_in_method" }, 409);
  }
  await deletePasskey(c.env, id);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Sign-in: /api/auth/passkeys
// ---------------------------------------------------------------------------

passkeyAuth.post("/login/options", async (c) => {
  const blocked = await limited(c, "passkey", LOGIN_PER_IP_LIMIT, LOGIN_GLOBAL_LIMIT);
  if (blocked) return blocked;
  if ((await countPasskeys(c.env)) === 0) return c.json({ error: "no_passkeys" }, 404);
  const rp = await relyingParty(c);
  const challenge = await issueChallenge(c, "login", rp);
  return c.json({ options: authenticationOptions({ challenge, rpId: rp.rpId }) });
});

passkeyAuth.post("/login/verify", async (c) => {
  const blocked = await limited(c, "passkey", LOGIN_PER_IP_LIMIT, LOGIN_GLOBAL_LIMIT);
  if (blocked) return blocked;
  if (!originAllowed(c, await relyingParty(c))) return c.json({ error: "origin_mismatch" }, 403);
  const parsed = authenticationBody.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "validation", issues: parsed.error.issues }, 400);
  const { credential } = parsed.data;

  try {
    const { challenge, data } = await consumeChallenge(c, "login", credential.response.clientDataJSON);
    const row = await getPasskeyByCredentialId(c.env, credential.rawId);
    if (!row || row.rp_id !== data.rpId) return c.json({ error: "unknown_passkey" }, 401);

    let result;
    try {
      result = await verifyAuthentication(
        credential,
        { challenge, origin: data.origin, rpId: data.rpId, userHandle: (await getUserHandle(c.env)) ?? "" },
        { credentialId: row.credential_id, publicKey: row.public_key, signCount: row.sign_count },
      );
    } catch (e) {
      if (e instanceof WebAuthnError) return c.json({ error: "passkey_invalid", reason: e.code }, 401);
      throw e;
    }
    // Compare-and-swap on the counter: a concurrent sign-in that used the
    // same counter value loses.
    if (!(await recordPasskeyUse(c.env, row, result.signCount, result.backupState))) {
      return c.json({ error: "passkey_invalid", reason: "counter_regressed" }, 401);
    }
    // Exactly like GitHub and email: a fresh session (and CSRF secret) per sign-in.
    await createSession(c, row.id, "passkey");
    return c.json({ ok: true });
  } catch (e) {
    return ceremonyErrorResponse(c, e);
  }
});

// --- Recovery with a new SETUP_TOKEN ----------------------------------------

/**
 * Recovery adds a passkey to a finished install with a SETUP_TOKEN that has
 * not been spent yet (db/setup.ts), then signs in with it. The token holder
 * controls the Cloudflare account, which can change everything anyway.
 */
async function guardRecovery(c: Parameters<typeof ceremonyErrorResponse>[0]): Promise<Response | null> {
  const blocked = await limited(c, "passkey-recovery", RECOVERY_PER_IP_LIMIT, RECOVERY_GLOBAL_LIMIT);
  if (blocked) return blocked;
  if (!(await isSetupComplete(c.env))) return c.json({ error: "setup_incomplete" }, 409);
  if (!c.env.SETUP_TOKEN) return c.json({ error: "setup_token_not_configured" }, 503);
  if (!(await checkSetupToken(c.env.SETUP_TOKEN, c.req.header(SETUP_TOKEN_HEADER)))) {
    return c.json({ error: "setup_token_invalid" }, 403);
  }
  if (!(await isSetupTokenUnspent(c.env))) return c.json({ error: "setup_token_spent" }, 403);
  return null;
}

passkeyAuth.post("/recover/options", async (c) => {
  const blocked = await guardRecovery(c);
  if (blocked) return blocked;
  const parsed = nameBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "validation", issues: parsed.error.issues }, 400);
  const options = await startRegistration(c, "recovery", parsed.data.name ?? "Passkey", null);
  return c.json({ options });
});

passkeyAuth.post("/recover/verify", async (c) => {
  if (!originAllowed(c, await relyingParty(c))) return c.json({ error: "origin_mismatch" }, 403);
  const blocked = await guardRecovery(c);
  if (blocked) return blocked;
  const parsed = registrationBody.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "validation", issues: parsed.error.issues }, 400);
  try {
    const row = await finishRegistration(c, "recovery", parsed.data.credential, null);
    await spendSetupToken(c.env);
    // Registering it was this sign-in, so it counts as used.
    await recordPasskeyUse(c.env, row, row.sign_count, row.backup_state === 1);
    // Recovery means control of the account was in doubt: sign out every
    // device, whichever way it signed in, before starting this session.
    await revokeAllSessions(c.env);
    await createSession(c, row.id, "passkey");
    return c.json({ ok: true, passkey: summarize(row) }, 201);
  } catch (e) {
    return ceremonyErrorResponse(c, e);
  }
});
