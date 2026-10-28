import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The platform Worker's tests, run in workerd with a local D1 (the same
// plugin as the root vitest.integration.config.ts). The dispatch namespace
// and the queue exist only remotely, so tests inject the in-memory
// dispatcher (test/fake-dispatcher.ts) instead of binding them.
const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  plugins: [
    cloudflareTest(async () => ({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-10-15",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["PLATFORM_DB"],
        bindings: {
          HOSTED_DOMAIN: "openping.test",
          TEST_MIGRATIONS: await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url))),
        },
      },
    })),
  ],
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});
