import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import pkg from "./package.json";

// The landing's GitHub button shows the repo's star count. The Worker's CSP
// keeps the page to same-origin requests, so the count is read once at build
// time instead of from the browser; null (no number shown) if GitHub can't be
// reached.
async function starCount(): Promise<number | null> {
  try {
    const res = await fetch("https://api.github.com/repos/n8watkins/open-ping", {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { stargazers_count?: number };
    return typeof data.stargazers_count === "number" ? data.stargazers_count : null;
  } catch {
    return null;
  }
}

export default defineConfig(async () => ({
  // `npm run deploy:prod` points the build at the generated production config
  // (scripts/prod-config.mjs); everything else uses wrangler.jsonc.
  plugins: [
    react(),
    tailwindcss(),
    cloudflare({ configPath: process.env.OPENPING_WRANGLER_CONFIG || undefined }),
  ],
  define: {
    __OP_STARS__: JSON.stringify(await starCount()),
    __OP_VERSION__: JSON.stringify(pkg.version),
  },
}));
