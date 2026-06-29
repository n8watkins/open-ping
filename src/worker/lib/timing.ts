/**
 * Constant-time string comparison for secrets (CSRF tokens, heartbeat secrets).
 *
 * Both inputs are SHA-256 hashed and the 32-byte digests are compared with no
 * early exit. Because the digests are always the same length, this leaks neither
 * the secret's content (no short-circuit) nor its length (the old char-by-char
 * loop ran over `max(len(a), len(b))`, disclosing the longer input's length via
 * iteration count). Async because WebCrypto's digest is async; every caller is
 * already in an async request path.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let mismatch = 0;
  for (let i = 0; i < va.length; i++) {
    mismatch |= (va[i] ?? 0) ^ (vb[i] ?? 0);
  }
  return mismatch === 0;
}
