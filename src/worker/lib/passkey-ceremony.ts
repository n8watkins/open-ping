import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { AppEnv, Env } from "../types";
import { appOrigin } from "./app-origin";
import { randomToken, sha256hex } from "./ids";
import { timingSafeEqual } from "./timing";
import { getAdminEmail, getAdminGithubLogin } from "./admin";
import {
  challengeOf,
  COSE_ALG_ES256,
  COSE_ALG_RS256,
  verifyRegistration,
  WebAuthnError,
  type RegistrationResponseJSON,
} from "./webauthn";
import {
  getOrCreateUserHandle,
  insertPasskey,
  listPasskeys,
  parseTransports,
  type PasskeyRow,
} from "../db/passkeys";
import { ensureSetupTokenSpendRecorded } from "../db/setup";

/**
 * The server half of the passkey ceremonies, shared by Settings
 * (routes/passkeys.ts), the setup wizard (routes/setup.ts) and recovery.
 *
 * Challenges follow the magic-link pattern: 32 random bytes, stored only as a
 * SHA-256 id in auth_tokens, valid for 5 minutes, and consumed with one atomic
 * DELETE ... RETURNING, so each can be answered once. They are also bound to
 * the browser that asked for them by an HttpOnly, SameSite=Strict cookie that
 * must match, like the GitHub OAuth state.
 *
 * The relying party is the install's configured origin (APP_URL, else the
 * wizard's app_url, else the request's own origin before either exists), and
 * its RP ID is that origin's hostname. A passkey therefore works only on the
 * hostname it was registered on.
 */

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_COOKIE = "op_passkey";
const COOKIE_PATH = "/api";
const RP_NAME = "OpenPing";

type Ctx = Context<AppEnv>;
export type RegisterVia = "settings" | "setup" | "recovery";

export interface RelyingParty {
  rpId: string;
  origin: string;
}

interface ChallengeData extends RelyingParty {
  via?: RegisterVia;
  sessionId?: string | null;
  name?: string;
}

/** A ceremony failure with the HTTP status and error code the API returns. */
export class CeremonyError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 401 | 403 | 404 | 409,
    readonly reason?: string,
  ) {
    super(code);
    this.name = "CeremonyError";
  }
}

export async function relyingParty(c: { env: Env; req: { url: string } }): Promise<RelyingParty> {
  const origin = await appOrigin(c);
  return { origin, rpId: new URL(origin).hostname };
}

/**
 * Browsers always send Origin on a cross-origin or POST fetch. A ceremony POST
 * from anywhere but the install's own origin is refused before any work.
 */
export function originAllowed(c: Ctx, rp: RelyingParty): boolean {
  return c.req.header("origin") === rp.origin;
}

// --- Request bodies -----------------------------------------------------------

const b64url = z.string().max(16384).regex(/^[A-Za-z0-9_-]*$/, "must be base64url");
const KNOWN_TRANSPORTS = new Set(["usb", "nfc", "ble", "internal", "hybrid", "smart-card"]);

export const passkeyNameSchema = z.string().trim().min(1).max(64);

export const registrationCredentialSchema = z.object({
  id: b64url.max(1400),
  rawId: b64url.max(1400),
  type: z.literal("public-key"),
  response: z.object({
    clientDataJSON: b64url,
    attestationObject: b64url,
    transports: z.array(z.string().max(32)).max(10).optional(),
  }),
});

export const authenticationCredentialSchema = z.object({
  id: b64url.max(1400),
  rawId: b64url.max(1400),
  type: z.literal("public-key"),
  response: z.object({
    clientDataJSON: b64url,
    authenticatorData: b64url,
    signature: b64url,
    userHandle: b64url.max(256).nullable().optional(),
  }),
});

// --- Challenges -------------------------------------------------------------

export async function issueChallenge(
  c: Ctx,
  purpose: "register" | "login",
  data: ChallengeData,
): Promise<string> {
  const challenge = randomToken(32);
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO auth_tokens (id, kind, data, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(await sha256hex(challenge), `passkey_${purpose}`, JSON.stringify(data), now, now + CHALLENGE_TTL_MS)
    .run();
  setCookie(c, CHALLENGE_COOKIE, challenge, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: COOKIE_PATH,
    maxAge: CHALLENGE_TTL_MS / 1000,
  });
  return challenge;
}

/**
 * Claim the challenge a response answers. The row is deleted before anything
 * else is checked, so a challenge is spent even by a response that fails.
 */
export async function consumeChallenge(
  c: Ctx,
  purpose: "register" | "login",
  clientDataJSON: string,
): Promise<{ challenge: string; data: ChallengeData }> {
  const cookie = getCookie(c, CHALLENGE_COOKIE);
  deleteCookie(c, CHALLENGE_COOKIE, { path: COOKIE_PATH, secure: true });

  let challenge: string;
  try {
    challenge = challengeOf(clientDataJSON);
  } catch {
    throw new CeremonyError("passkey_invalid", 400, "malformed");
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(challenge)) throw new CeremonyError("challenge_invalid", 400);

  const row = await c.env.DB.prepare(
    `DELETE FROM auth_tokens WHERE id = ? AND kind = ? RETURNING data, expires_at`,
  )
    .bind(await sha256hex(challenge), `passkey_${purpose}`)
    .first<{ data: string | null; expires_at: number }>();

  if (!cookie || !(await timingSafeEqual(cookie, challenge))) throw new CeremonyError("challenge_invalid", 400);
  if (!row || row.expires_at <= Date.now()) throw new CeremonyError("challenge_invalid", 400);
  let data: ChallengeData;
  try {
    data = JSON.parse(row.data ?? "") as ChallengeData;
  } catch {
    throw new CeremonyError("challenge_invalid", 400);
  }
  if (typeof data?.rpId !== "string" || typeof data.origin !== "string") {
    throw new CeremonyError("challenge_invalid", 400);
  }
  return { challenge, data };
}

// --- Options ----------------------------------------------------------------

/** PublicKeyCredentialCreationOptions, base64url-encoded (the JSON form). */
export function registrationOptions(p: {
  challenge: string;
  rpId: string;
  userHandle: string;
  userName: string;
  exclude: { id: string; transports: string[] }[];
}) {
  return {
    challenge: p.challenge,
    rp: { id: p.rpId, name: RP_NAME },
    user: { id: p.userHandle, name: p.userName, displayName: `${RP_NAME} admin` },
    pubKeyCredParams: [
      { type: "public-key", alg: COSE_ALG_ES256 },
      { type: "public-key", alg: COSE_ALG_RS256 },
    ],
    timeout: CHALLENGE_TTL_MS,
    attestation: "none",
    authenticatorSelection: {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    },
    excludeCredentials: p.exclude.map((e) => ({ type: "public-key", id: e.id, transports: e.transports })),
    extensions: { credProps: true },
  };
}

/** PublicKeyCredentialRequestOptions for a usernameless (discoverable) sign-in. */
export function authenticationOptions(p: { challenge: string; rpId: string }) {
  return {
    challenge: p.challenge,
    rpId: p.rpId,
    timeout: CHALLENGE_TTL_MS,
    userVerification: "required",
    allowCredentials: [],
  };
}

/** The account name a password manager files the passkey under. */
async function adminUserName(env: Env, rpId: string): Promise<string> {
  return (await getAdminEmail(env)) ?? (await getAdminGithubLogin(env)) ?? `admin@${rpId}`;
}

// --- Registration -------------------------------------------------------------

export async function startRegistration(
  c: Ctx,
  via: RegisterVia,
  name: string,
  sessionId: string | null,
) {
  const rp = await relyingParty(c);
  const userHandle = await getOrCreateUserHandle(c.env);
  const exclude = (await listPasskeys(c.env))
    .filter((p) => p.rp_id === rp.rpId)
    .map((p) => ({ id: p.credential_id, transports: parseTransports(p.transports) }));
  const challenge = await issueChallenge(c, "register", { ...rp, via, sessionId, name });
  return registrationOptions({
    challenge,
    rpId: rp.rpId,
    userHandle,
    userName: await adminUserName(c.env, rp.rpId),
    exclude,
  });
}

export async function finishRegistration(
  c: Ctx,
  via: RegisterVia,
  credential: RegistrationResponseJSON,
  sessionId: string | null,
): Promise<PasskeyRow> {
  const { challenge, data } = await consumeChallenge(c, "register", credential.response.clientDataJSON);
  if (data.via !== via || (via === "settings" && data.sessionId !== sessionId)) {
    throw new CeremonyError("challenge_invalid", 400);
  }
  let verified;
  try {
    verified = await verifyRegistration(credential, { challenge, origin: data.origin, rpId: data.rpId });
  } catch (e) {
    if (e instanceof WebAuthnError) throw new CeremonyError("passkey_invalid", 400, e.code);
    throw e;
  }
  // Before the first passkey exists, pin down which SETUP_TOKEN is already
  // spent, so recovery later needs a new one (db/setup.ts).
  if (via !== "recovery") await ensureSetupTokenSpendRecorded(c.env);
  const transports = (credential.response.transports ?? []).filter((t) => KNOWN_TRANSPORTS.has(t));
  const row = await insertPasskey(c.env, verified, {
    name: data.name ?? "Passkey",
    rpId: data.rpId,
    transports,
  });
  if (!row) throw new CeremonyError("passkey_exists", 409);
  return row;
}

/** JSON error response for a CeremonyError, or rethrow anything else. */
export function ceremonyErrorResponse(c: Ctx, e: unknown): Response {
  if (e instanceof CeremonyError) {
    return c.json({ error: e.code, ...(e.reason ? { reason: e.reason } : {}) }, e.status);
  }
  throw e;
}
