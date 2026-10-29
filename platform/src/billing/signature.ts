/**
 * Checking a Stripe webhook's signature, exactly as Stripe documents it for
 * verifying by hand (https://docs.stripe.com/webhooks#verify-manually,
 * checked 2026-10-28):
 *
 *   1. split the Stripe-Signature header on "," and each element on "=";
 *      `t` is the timestamp and each `v1` a signature; every other scheme
 *      (the test-only `v0`) is ignored, against downgrade attacks;
 *   2. signed_payload is the timestamp, ".", and the raw request body;
 *   3. the expected signature is HMAC-SHA256 of signed_payload, keyed with the
 *      endpoint's signing secret (the whole `whsec_...` string), in hex;
 *   4. compare it to each v1 in constant time (there are several while a
 *      rolled secret is still live), then check the timestamp is within the
 *      tolerance: Stripe's libraries default to 5 minutes, and 0 must never
 *      be used, since it turns the check off.
 *
 * The body must be exactly the bytes Stripe sent, so the route reads it as
 * text before anything parses it.
 */

/** Stripe's libraries' default. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;
/** A header longer than this is refused unread (a few signatures and a timestamp are under 1 KB). */
const MAX_HEADER_LENGTH = 4096;

export type SignatureCheck = { ok: true; timestamp: number } | { ok: false; reason: "missing" | "malformed" | "no_match" | "too_old" | "in_future" };

export function parseSignatureHeader(header: string): { timestamp: number; signatures: string[] } | null {
  if (header.length > MAX_HEADER_LENGTH) return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const element of header.split(",")) {
    const at = element.indexOf("=");
    if (at < 1) continue;
    const prefix = element.slice(0, at).trim();
    const value = element.slice(at + 1).trim();
    if (prefix === "t") {
      if (!/^\d{1,12}$/.test(value)) return null;
      timestamp = Number(value);
    } else if (prefix === "v1" && /^[0-9a-f]{64}$/.test(value)) {
      signatures.push(value);
    }
  }
  return timestamp === null ? null : { timestamp, signatures };
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Equal-length hex strings compared without an early exit. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyStripeSignature(input: {
  body: string;
  header: string | null;
  secret: string;
  /** Epoch ms. */
  now: number;
  toleranceSeconds?: number;
}): Promise<SignatureCheck> {
  if (!input.header) return { ok: false, reason: "missing" };
  const parsed = parseSignatureHeader(input.header);
  if (!parsed) return { ok: false, reason: "malformed" };
  const expected = await hmacHex(input.secret, `${parsed.timestamp}.${input.body}`);
  // Every signature is compared, so the time taken doesn't say which matched.
  let matched = false;
  for (const signature of parsed.signatures) matched = constantTimeEqual(expected, signature) || matched;
  if (!matched) return { ok: false, reason: "no_match" };
  const tolerance = Math.max(1, input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS);
  const age = Math.floor(input.now / 1000) - parsed.timestamp;
  if (age > tolerance) return { ok: false, reason: "too_old" };
  if (age < -tolerance) return { ok: false, reason: "in_future" };
  return { ok: true, timestamp: parsed.timestamp };
}

/** A Stripe-Signature header for `body` (the fake Stripe in tests, and a local `stripe listen` stand-in). */
export async function signStripePayload(body: string, secret: string, timestampSeconds: number): Promise<string> {
  return `t=${timestampSeconds},v1=${await hmacHex(secret, `${timestampSeconds}.${body}`)}`;
}
