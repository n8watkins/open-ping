// Shared by e2e/serve.mjs (which seeds this session) and the specs (which sign in with it).
// E2E_PORT overrides it, for running beside another local server.
export const E2E_PORT = Number(process.env.E2E_PORT ?? 8799);
export const E2E_SESSION_TOKEN = "e2e-session-token-for-local-tests-only";
export const E2E_CSRF = "e2e-csrf-secret";
