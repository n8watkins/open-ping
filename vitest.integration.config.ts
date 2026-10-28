import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const TEST_MASTER_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: "./src/worker/index.ts",
      miniflare: {
        compatibilityDate: "2024-12-30",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        // Second-region confirmation's re-checkers (wrangler.jsonc durable_objects).
        // CONFIRM_REGIONS stays unset, so only the tests that turn it on use them.
        durableObjects: { REGION_PROBE: { className: "RegionProbe", useSQLite: true } },
        // The landing click counter's per-visitor limit (wrangler.jsonc ratelimits).
        ratelimits: { EVENT_LIMITER: { namespace_id: "4271", simple: { limit: 30, period: 60 } } },
        bindings: {
          API_TOKEN: "integration-api-token",
          APP_URL: "https://openping.test",
          MASTER_KEY: TEST_MASTER_KEY,
          // The integration install plays the canonical one, so the waitlist is on.
          WAITLIST_ENABLED: "true",
          // ...and its home page is the marketing page, so click counts are on.
          HOME_PAGE: "landing",
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        },
      },
    })),
  ],
  test: {
    include: ["test/integration/**/*.test.ts"],
    setupFiles: ["test/integration/setup.ts"],
  },
});
