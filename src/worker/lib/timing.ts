/**
 * Constant-time string comparison for secrets (CSRF tokens, heartbeat secrets).
 * Avoids the early-exit timing side-channel of `===`/`!==`. Pure; no Node APIs.
 *
 * The loop runs over the longer of the two inputs and folds any length
 * difference into the result, so it neither short-circuits nor leaks length via
 * timing in a way an attacker can exploit for the small secrets used here.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  let mismatch = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}
