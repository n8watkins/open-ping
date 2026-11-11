// Shared by e2e/serve.mjs (which seeds this session) and the specs (which sign in with it).
// E2E_PORT overrides it, for running beside another local server.
export const E2E_PORT = Number(process.env.E2E_PORT ?? 8799);
export const E2E_SESSION_TOKEN = "e2e-session-token-for-local-tests-only";
export const E2E_CSRF = "e2e-csrf-secret";
// Wrangler's output, kept by e2e/serve.mjs: it names the file of every email the Worker sent.
export const E2E_SERVER_LOG = new URL("./.state/server.log", import.meta.url).pathname;
// Cloudflare's Turnstile test keys (developers.cloudflare.com/turnstile/troubleshooting/testing/):
// the widget always issues a token and the secret always accepts it, on any host.
export const TURNSTILE_TEST_SITE_KEY = "1x00000000000000000000AA";
export const TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA";
