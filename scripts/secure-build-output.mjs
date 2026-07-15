import { chmodSync, existsSync } from "node:fs";

// The Cloudflare Vite build copies local development bindings beside the
// Worker bundle for local tooling. Keep that ignored artifact readable only by
// its owner so a routine build does not broaden access to development secrets.
const sensitiveBuildFiles = ["dist/open_ping/.dev.vars"];

for (const path of sensitiveBuildFiles) {
  if (existsSync(path)) chmodSync(path, 0o600);
}
