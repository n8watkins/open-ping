import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Standalone test config so vitest doesn't pull in the Cloudflare Vite plugin
// from vite.config.ts. Pure unit tests run in Node (Web Crypto is available).
// D1-backed route tests use the separate vitest.integration.config.ts config.
export default defineConfig({
  resolve: {
    alias: {
      // The Workers-only `cloudflare:sockets` built-in has no Node implementation.
      // Alias it to a throw-if-called stub so suites that transitively import the
      // TCP executor still load; suites that actually dial sockets `vi.mock` it.
      "cloudflare:sockets": fileURLToPath(
        new URL("./test/stubs/cloudflare-sockets.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
