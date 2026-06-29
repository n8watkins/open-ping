import { defineConfig } from "vitest/config";

// Standalone test config so vitest doesn't pull in the Cloudflare Vite plugin
// from vite.config.ts. Pure unit tests run in Node (Web Crypto is available);
// D1-backed integration tests will use the workers pool in a later phase.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
