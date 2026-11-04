// Starts the built Worker (`npm run build` first) under `wrangler dev` on a throwaway local
// D1 database, already set up and with one signed-in admin session, for the Playwright specs
// in e2e/. Nothing here touches your own .dev.vars or .wrangler state.
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_CSRF, E2E_PORT, E2E_SESSION_TOKEN } from "./env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const state = path.join(root, "e2e", ".state");
const config = path.join(root, "dist", "open_ping", "wrangler.json");
const wrangler = path.join(root, "node_modules", ".bin", "wrangler");

rmSync(state, { recursive: true, force: true });
mkdirSync(state, { recursive: true });
// Throwaway secrets for this run only.
const vars = path.join(state, "e2e.vars");
writeFileSync(vars, `MASTER_KEY=${randomBytes(32).toString("base64")}\nSETUP_TOKEN=${randomBytes(24).toString("base64url")}\n`);

const d1 = (...args) => execFileSync(wrangler, ["d1", ...args, "--local", "--persist-to", state, "-c", config], { cwd: root, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, CI: "1" } });
d1("migrations", "apply", "DB");
const now = Date.now();
const sessionId = createHash("sha256").update(E2E_SESSION_TOKEN).digest("hex");
d1("execute", "DB", "--command", [
  `INSERT INTO settings (key, value, encrypted, updated_at) VALUES ('setup_complete', 'true', 0, ${now})`,
  `INSERT INTO sessions (id, identity, identity_kind, csrf_secret, created_at, expires_at, last_seen_at) VALUES ('${sessionId}', 'e2e@openping.test', 'email', '${E2E_CSRF}', ${now}, ${now + 86_400_000}, ${now})`,
].join("; "));

const server = spawn(wrangler, ["dev", "-c", config, "--persist-to", state, "--env-file", vars, "--port", String(E2E_PORT), "--ip", "127.0.0.1"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, CI: "1" },
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
server.on("exit", (code) => process.exit(code ?? 0));
