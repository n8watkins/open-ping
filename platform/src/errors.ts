/**
 * A failure that trying again won't fix: a malformed tenant bundle, a
 * PLATFORM_KEY that can't open a tenant's escrowed key. Provisioning pauses
 * the tenant on one (for the owner to look at) instead of retrying it, and
 * so does a Cloudflare API error that isn't retryable (CloudflareApiError).
 */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}
