import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_CSRF, E2E_PORT, E2E_SESSION_TOKEN } from "./env.mjs";

// Monitor cards show the site's icon (kept by the Worker, served by OpenPing) and the real link under the
// name. A monitor without an icon keeps the state avatar. The browser asks no third party for anything.

const base = `http://localhost:${E2E_PORT}`;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const headers = { cookie: `op_session=${E2E_SESSION_TOKEN}`, "x-csrf-token": E2E_CSRF, "content-type": "application/json" };
// A 1x1 PNG.
const PNG_HEX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64").toString("hex");

/** Puts an icon in the local database, as the Worker's own fetch would (there is no internet to fetch from here). */
function storeIcon(id: string, origin: string) {
  const sql = `INSERT INTO monitor_icons (monitor_id, origin, icon, content_type, fetched_at) VALUES ('${id}', '${origin}', X'${PNG_HEX}', 'image/png', ${Date.now()})`;
  execFileSync(
    path.join(root, "node_modules", ".bin", "wrangler"),
    ["d1", "execute", "DB", "--local", "--persist-to", path.join(root, "e2e", ".state"), "-c", path.join(root, "dist", "open_ping", "wrangler.json"), "--command", sql],
    { cwd: root, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, CI: "1" } },
  );
}

async function createMonitor(request: APIRequestContext, name: string, url: string): Promise<string> {
  const response = await request.post("/api/monitors", { data: { name, type: "http", config: { url } }, headers });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { monitor: { id: string } }).monitor.id;
}

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: "op_session", value: E2E_SESSION_TOKEN, url: base, secure: true, httpOnly: true }]);
});

test("the list and the detail page show the site's icon and its real link", async ({ page, request }) => {
  const stamp = Date.now().toString(36);
  const withIcon = await createMonitor(request, `Iconic ${stamp}`, `https://iconic-${stamp}.example.com/status?token=hidden`);
  const without = await createMonitor(request, `Plain ${stamp}`, `https://plain-${stamp}.example.com/`);
  storeIcon(withIcon, `https://iconic-${stamp}.example.com`);

  const outside: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith(base) && !r.url().startsWith("data:")) outside.push(r.url());
  });

  await page.goto("/monitors");
  const list = page.getByRole("region", { name: "Monitor list" });
  const card = (name: string) => list.locator("div.animate-enter", { hasText: name }).filter({ has: page.locator("a") }).last();

  const iconic = card(`Iconic ${stamp}`).filter({ visible: true }).first();
  await expect(iconic.locator(`img[src^="/api/monitors/${withIcon}/icon"]`).first()).toBeVisible();
  const link = iconic.getByRole("link", { name: `iconic-${stamp}.example.com/status` }).filter({ visible: true }).first();
  await expect(link).toHaveAttribute("href", `https://iconic-${stamp}.example.com/status`);
  await expect(link).toHaveAttribute("rel", /noopener/);
  await expect(link).toHaveAttribute("target", "_blank");
  // The query string (it can carry a token) never reaches the list.
  await expect(list).not.toContainText("hidden");

  const plain = card(`Plain ${stamp}`).filter({ visible: true }).first();
  await expect(plain.locator("img")).toHaveCount(0);
  await expect(plain.getByRole("link", { name: `plain-${stamp}.example.com` }).filter({ visible: true }).first()).toBeVisible();

  // The image really is served by OpenPing.
  const res = await request.get(`/api/monitors/${withIcon}/icon`, { headers });
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("image/png");
  expect((await request.get(`/api/monitors/${without}/icon`, { headers })).status()).toBe(404);

  await page.goto(`/monitors/${withIcon}`);
  await expect(page.locator(`img[src^="/api/monitors/${withIcon}/icon"]`)).toBeVisible();
  const full = page.getByRole("link", { name: `https://iconic-${stamp}.example.com/status?token=hidden` }).first();
  await expect(full).toHaveAttribute("rel", "noopener noreferrer");

  const axe = await new AxeBuilder({ page }).include("main").analyze();
  expect(axe.violations).toEqual([]);
  expect(outside).toEqual([]);
});
