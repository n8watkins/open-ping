/**
 * Spaces calls out: each awaited call starts at least `spacingMs` after the
 * previous one started, in the order they were made. One scheduler run uses
 * one for its RDAP lookups, because rdap.org and the registries behind it rate
 * limit bursts (about 16 lookups at once drew HTTP 429s from Cloudflare's
 * network, while lookups a couple of seconds apart all succeeded).
 */
export function pacer(
  spacingMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
  clock: () => number = Date.now,
): () => Promise<void> {
  let nextAt = 0;
  return async () => {
    const now = clock();
    const at = Math.max(now, nextAt);
    nextAt = at + spacingMs;
    if (at > now) await sleep(at - now);
  };
}
