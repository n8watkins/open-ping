/**
 * A random secret for MASTER_KEY or SETUP_TOKEN: 32 bytes from the browser's
 * cryptographic generator, base64-encoded, the same as `openssl rand -base64 32`.
 * Made in the page and never sent anywhere (the /install generator).
 */
export function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The Deploy to Cloudflare button for this repository (docs/INSTALL.md). */
export const DEPLOY_BUTTON_URL =
  "https://deploy.workers.cloudflare.com/?url=https://github.com/n8watkins/open-ping";
