import { defineConfig } from "vitest/config";

// The picker and offline screen, bundled into the app (webDir "dist").
export default defineConfig({
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  test: { include: ["src/**/*.test.ts"] },
});
