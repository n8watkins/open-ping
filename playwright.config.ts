import { defineConfig, devices } from "@playwright/test";
import { E2E_PORT } from "./e2e/env.mjs";

// Browser tests for the admin app: `npm run build`, then `npm run test:e2e`. e2e/serve.mjs
// runs the built Worker under `wrangler dev` on a throwaway local D1 database with one
// signed-in admin session.
const baseURL = `http://localhost:${E2E_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  workers: 1,
  use: { baseURL, trace: "retain-on-failure" },
  webServer: {
    command: "node e2e/serve.mjs",
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 90_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
