import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { E2E_CSRF, E2E_PORT, E2E_SESSION_TOKEN } from "./env.mjs";

// "Deleted · Undo" (components/ui/UndoToast.tsx): a delete hides the item at once, a toast
// offers Undo for about six seconds, and the server delete is only sent when the toast
// closes. Actions that cannot be undone ask first in the app's own dialog.

const base = `http://localhost:${E2E_PORT}`;
// The test's own API calls (setup and checks) sign in with the same seeded session.
const auth = { cookie: `op_session=${E2E_SESSION_TOKEN}` };
const headers = { ...auth, "x-csrf-token": E2E_CSRF, "content-type": "application/json" };

test.beforeEach(async ({ page, context }) => {
  await context.addCookies([{ name: "op_session", value: E2E_SESSION_TOKEN, url: base, secure: true, httpOnly: true }]);
  page.on("dialog", (dialog) => {
    void dialog.dismiss();
    throw new Error(`a native ${dialog.type()} dialog opened: ${dialog.message()}`);
  });
  // A controllable clock, so the toast can run out without waiting for it.
  await page.clock.install();
});

let seq = 0;
const unique = (name: string) => `${name} ${Date.now().toString(36)}${(seq += 1)}`;

async function create<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(path, { data, headers });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as T;
}

const createMonitor = (request: APIRequestContext, name: string) =>
  create<{ monitor: { id: string } }>(request, "/api/monitors", { name, type: "http", config: { url: "https://example.com" } }).then((r) => r.monitor.id);

const toast = (page: Page, text: string | RegExp) => page.getByRole("region", { name: "Notifications" }).locator("div", { hasText: text }).filter({ has: page.getByRole("button", { name: "Undo" }) }).last();

/** Records DELETE requests, to prove nothing reaches the server before the toast closes. */
function deletesSent(page: Page) {
  const sent: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "DELETE") sent.push(new URL(request.url()).pathname);
  });
  return sent;
}

test("deleting a monitor can be undone, and nothing is deleted on the server", async ({ page, request }) => {
  const name = unique("Checkout API");
  const id = await createMonitor(request, name);
  const sent = deletesSent(page);
  await page.goto(`/monitors/${id}`);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page).toHaveURL(/\/monitors$/);
  await expect(toast(page, `“${name}” deleted`)).toBeVisible();
  const list = page.getByRole("region", { name: "Monitor list" });
  await expect(list.getByText(name)).toHaveCount(0);

  await toast(page, `“${name}” deleted`).getByRole("button", { name: "Undo" }).click();
  await expect(list.getByText(name).filter({ visible: true })).toBeVisible();
  await page.clock.runFor(10_000);
  expect(sent).toEqual([]);
  await page.reload();
  await expect(page.getByRole("region", { name: "Monitor list" }).getByText(name).filter({ visible: true })).toBeVisible();
});

test("a deleted monitor is deleted on the server once the toast runs out", async ({ page, request }) => {
  const name = unique("Old cron");
  const id = await createMonitor(request, name);
  await page.goto("/monitors");
  await page.getByLabel(`Actions for ${name}`).filter({ visible: true }).click();
  await page.locator("details[open]").getByRole("button", { name: "Delete" }).click();
  await expect(toast(page, `“${name}” deleted`)).toBeVisible();
  const deleted = page.waitForResponse((response) => response.request().method() === "DELETE" && response.url().endsWith(`/api/monitors/${id}`));
  await page.clock.runFor(6_500);
  expect((await deleted).ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole("region", { name: "Monitor list" })).toBeVisible();
  await expect(page.getByText(name)).toHaveCount(0);
  expect((await request.get(`/api/monitors/${id}`, { headers: auth })).status()).toBe(404);
});

test("Ctrl+Z undoes a bulk delete of selected monitors", async ({ page, request }) => {
  const names = [unique("Alpha"), unique("Beta")];
  for (const name of names) await createMonitor(request, name);
  const sent = deletesSent(page);
  await page.goto("/monitors");
  for (const name of names) await page.getByLabel(`Select ${name}`).filter({ visible: true }).check();
  await page.getByRole("group", { name: "Bulk monitor actions" }).getByRole("button", { name: "Delete" }).click();
  await expect(toast(page, "2 monitors deleted")).toBeVisible();
  for (const name of names) await expect(page.getByText(name)).toHaveCount(0);
  await page.keyboard.press("Control+z");
  for (const name of names) await expect(page.getByText(name).filter({ visible: true })).toBeVisible();
  await page.clock.runFor(10_000);
  expect(sent).toEqual([]);
});

test("closing the tab sends a pending delete instead of dropping it", async ({ page, request, context }) => {
  const name = unique("Pager hook");
  await create(request, "/api/channels", { type: "webhook", name, config: { url: "https://example.com/hook" } });
  await page.goto("/integrations");
  await page.getByRole("button", { name: `Delete ${name}` }).click();
  await expect(toast(page, `Channel “${name}” deleted`)).toBeVisible();
  // Closing the tab (pagehide) sends the delete with keepalive, well before the toast would close.
  await page.close({ runBeforeUnload: true });
  const next = await context.newPage();
  await expect.poll(async () => JSON.stringify(await (await next.request.get(`${base}/api/channels`, { headers: auth })).json())).not.toContain(name);
});

test("categories, channels, status pages and maintenance windows each come back with Undo", async ({ page, request }) => {
  const category = unique("Payments");
  await create(request, "/api/categories", { name: category, slug: category.toLowerCase().replace(/\W+/g, "-") });
  const channel = unique("Ops hook");
  await create(request, "/api/channels", { type: "webhook", name: channel, config: { url: "https://example.com/hook" } });
  const statusPage = unique("Customers");
  await create(request, "/api/status-pages", { name: statusPage, slug: statusPage.toLowerCase().replace(/\W+/g, "-") });
  const windowTitle = unique("DB upgrade");
  await create(request, "/api/maintenance", { title: windowTitle, scope: "global", startsAt: Date.now() + 86_400_000, endsAt: Date.now() + 90_000_000 });
  const sent = deletesSent(page);

  for (const [path, label, text, message] of [
    ["/status-page", `Delete ${category}`, category, `Category “${category}” deleted`],
    ["/status-page", `Delete ${statusPage}`, statusPage, `Status page “${statusPage}” deleted`],
    ["/integrations", `Delete ${channel}`, channel, `Channel “${channel}” deleted`],
    ["/maintenance", `Delete ${windowTitle}`, windowTitle, `“${windowTitle}” deleted`],
  ] as const) {
    await page.goto(path);
    await page.getByRole("button", { name: label }).click();
    await expect(toast(page, message)).toBeVisible();
    await expect(page.getByText(text, { exact: true })).toHaveCount(0);
    await toast(page, message).getByRole("button", { name: "Undo" }).click();
    await expect(page.getByText(text, { exact: true }).first()).toBeVisible();
  }
  await page.clock.runFor(10_000);
  expect(sent).toEqual([]);
});

test("the toast is polite, keeps focus, sits above the phone tab bar and passes axe", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const name = unique("Phone check");
  const id = await createMonitor(request, name);
  await page.goto(`/monitors/${id}`);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const region = page.getByRole("region", { name: "Notifications" });
  await expect(region.locator("[aria-live=polite]")).toContainText(`“${name}” deleted`);
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest("[role=region]")))).toBe(false);
  const box = await toast(page, "deleted").boundingBox();
  const tabbar = await page.locator("nav.fixed.bottom-0, .fixed.inset-x-0.bottom-0").first().boundingBox();
  expect(box && box.x >= 16 && box.x + box.width <= 390 - 16).toBe(true);
  expect(box && tabbar && box.y + box.height <= tabbar.y).toBe(true);
  const results = await new AxeBuilder({ page }).include("[aria-label=Notifications]").analyze();
  expect(results.violations).toEqual([]);
  await region.getByRole("button", { name: "Undo" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(name).filter({ visible: true })).toBeVisible();
});

test("revoking an API token asks in an in-app dialog that Cancel and Escape dismiss", async ({ page, request }) => {
  const name = unique("CI deploys");
  await create(request, "/api/api-tokens", { name });
  await page.goto("/developers/tokens");
  const revoke = page.getByRole("button", { name: `Revoke ${name}` });
  await revoke.click();
  const dialog = page.getByRole("dialog", { name: `Revoke “${name}”?` });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("can't be undone");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(revoke).toBeFocused();

  await revoke.click();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await page.reload();
  await expect(page.getByText(name)).toBeVisible();

  await revoke.click();
  await dialog.getByRole("button", { name: "Revoke token" }).click();
  await expect(dialog).toBeHidden();
  await expect(revoke).toHaveCount(0);
  // It moves to the revoked tokens record.
  await page.getByText(/^Revoked tokens \(\d+\)$/).click();
  await expect(page.getByText(name)).toBeVisible();
});

test("signing out everywhere asks first, and Cancel keeps the session", async ({ page }) => {
  await page.goto("/settings/security");
  await page.getByRole("button", { name: "Sign out everywhere" }).click();
  const dialog = page.getByRole("dialog", { name: "Sign out everywhere?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await page.reload();
  await expect(page).toHaveURL(/\/settings\/security$/);
});
