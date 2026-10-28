import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import pkg from "./package.json";
import { openpingBundle } from "./scripts/bundle-module";

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

// Public pages a signed-in admin's installed app never needs offline.
const PUBLIC_ONLY_PAGE = /\/src\/client\/pages\/(Landing|Install|Embed|tools\/)/;

/**
 * Writes /sw-precache.json, the hashed JS and CSS bundles of the admin app, so
 * the service worker (public/sw.js) can save them all for offline use. Without
 * it a page never opened before (a lazy chunk) can't load offline.
 */
function precacheList(): Plugin {
  return {
    name: "openping-precache-list",
    applyToEnvironment: (environment) => environment.name === "client",
    generateBundle(_options, bundle) {
      const files = Object.values(bundle)
        .filter((file) => /^assets\/.+\.(js|css)$/.test(file.fileName))
        .filter((file) => !(file.type === "chunk" && file.facadeModuleId && PUBLIC_ONLY_PAGE.test(file.facadeModuleId)))
        .map((file) => `/${file.fileName}`)
        .sort();
      this.emitFile({ type: "asset", fileName: "sw-precache.json", source: JSON.stringify({ files }) });
    },
  };
}

export default defineConfig(async () => ({
  // `npm run deploy:prod` points the build at the generated production config
  // (scripts/prod-config.mjs); everything else uses wrangler.jsonc.
  plugins: [
    react(),
    tailwindcss(),
    cloudflare({ configPath: process.env.OPENPING_WRANGLER_CONFIG || undefined }),
    precacheList(),
    openpingBundle(),
  ],
  define: {
    __OP_STARS__: JSON.stringify(await starCount()),
    __OP_VERSION__: JSON.stringify(pkg.version),
  },
}));
