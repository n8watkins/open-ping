import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { E2E_PORT, E2E_SESSION_TOKEN } from "./env.mjs";

// Developers > API tokens: permissions picked like a cloud console. Categories with a granted/total counter, one row per
// resource with a checkbox per action, nothing ticked to start, a live plain-language summary, and Full access apart.

const base = `http://localhost:${E2E_PORT}`;

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: "op_session", value: E2E_SESSION_TOKEN, url: base, secure: true, httpOnly: true }]);
});

test("starts with nothing ticked; Edit ticks Read; the token gets exactly what is ticked", async ({ page, request }) => {
  const name = `Agent ${Date.now().toString(36)}`;
  await page.goto("/developers/tokens");
  await page.getByLabel("Name").fill(name);
  await expect(page.getByLabel("Expires after")).toHaveValue("90");
  await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create token" })).toBeDisabled();
  await expect(page.getByText("Tick at least one permission.")).toBeVisible();
  await expect(page.getByText("Nothing yet. Tick at least one permission above.")).toBeVisible();

  const monitoring = page.getByRole("button", { name: "Monitoring", exact: true });
  await expect(monitoring).toHaveAccessibleDescription("0 of 5 granted");
  await expect(monitoring).toHaveAttribute("aria-expanded", "false");
  await monitoring.click();
  await page.getByRole("checkbox", { name: "Monitors: Edit" }).check();
  // Edit includes Read, shown ticked and locked.
  await expect(page.getByRole("checkbox", { name: "Monitors: Read (included with Edit)" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Monitors: Read (included with Edit)" })).toBeDisabled();
  await expect(monitoring).toHaveAccessibleDescription("2 of 5 granted");
  const summary = page.getByRole("region", { name: "What this token can do" });
  await expect(summary).toContainText("Add, change, pause, resume, test and delete monitors");
  await expect(summary).toContainText("See monitors, their settings and their current status");
  await expect(summary).toContainText("Everything else is refused.");

  const axe = await new AxeBuilder({ page }).include("main").analyze();
  expect(axe.violations).toEqual([]);

  await page.getByRole("button", { name: "Create token" }).click();
  const status = page.getByRole("status").filter({ hasText: "is ready" });
  await expect(status).toBeVisible();
  const token = (await status.locator("code").textContent())!.trim();
  expect(token).toMatch(/^opk_/);
  // The form resets, so the next token starts from nothing again.
  await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(0);

  const row = page.getByRole("listitem").filter({ hasText: name });
  await expect(row).toContainText("Monitors: edit");
  await expect(row).toContainText("Never used");
  await expect(row).toContainText(/Expires in (89|90)d/);
  await expect(row).not.toContainText("Full access");

  const bearer = { authorization: `Bearer ${token}` };
  expect((await request.get("/api/monitors", { headers: bearer })).status()).toBe(200);
  const refused = await request.get("/api/overview", { headers: bearer });
  expect(refused.status()).toBe(403);
  expect(await refused.json()).toMatchObject({ error: "insufficient_scope", required: "uptime:read" });
  expect(await (await request.get("/api/api-tokens/self", { headers: bearer })).json()).toMatchObject({
    name,
    scopes: ["monitors:read", "monitors:edit"],
  });
});

test("Bulk select ticks visible boxes; search narrows the list; a long access line opens in full", async ({ page }) => {
  const name = `Bulk ${Date.now().toString(36)}`;
  await page.goto("/developers/tokens");
  await page.getByRole("button", { name: "Bulk select" }).click();
  await page.getByRole("menuitem", { name: /Monitoring sync/ }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Monitoring", exact: true })).toHaveAccessibleDescription("4 of 5 granted");
  await expect(page.getByRole("region", { name: "What this token can do" })).toContainText("Add, change, pause, resume, test and delete monitors");

  await page.getByRole("searchbox", { name: "Search permissions" }).fill("alert");
  await expect(page.getByRole("checkbox", { name: "Alert channels: Read" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Alert channels: Edit" })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: /^Monitors:/ })).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Search permissions" }).fill("");

  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create token" }).click();
  const row = page.getByRole("listitem").filter({ hasText: name });
  await expect(row).toContainText("Monitors: edit");
  await row.getByRole("button", { name: /more permissions/ }).click();
  await expect(row).toContainText("Diagnostics: read");
  await expect(row.getByRole("button", { name: "Show less" })).toBeVisible();

  await page.getByRole("button", { name: "Bulk select" }).click();
  await page.getByRole("menuitem", { name: "Clear all" }).click();
  await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(0);
});

test("Full access is a separate, warned checkbox; an expiry and revoke work from the list", async ({ page }) => {
  const name = `Admin ${Date.now().toString(36)}`;
  await page.goto("/developers/tokens");
  const full = page.getByRole("checkbox", { name: /^Full access/ });
  await expect(full).not.toBeChecked();
  await full.check();
  await expect(page.getByRole("searchbox", { name: "Search permissions" })).toBeDisabled();
  await expect(page.getByRole("region", { name: "What this token can do" })).toContainText("Everything");
  await page.getByLabel("Expires after").selectOption("never");
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create token" }).click();
  const row = page.getByRole("listitem").filter({ hasText: name });
  await expect(row).toContainText("Full access");
  await expect(row).toContainText("Never expires");

  await page.getByRole("button", { name: `Revoke ${name}` }).click();
  await page.getByRole("button", { name: "Revoke token" }).click();
  await expect(row).toHaveCount(0);
  await page.getByText(/Revoked tokens \(/).click();
  await expect(page.getByRole("listitem").filter({ hasText: name })).toContainText("Revoked");
});

test("on a phone the Developers sections are one dropdown", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/developers/tokens");
  const menu = page.getByLabel("Developers sections").locator("select");
  await expect(menu).toHaveValue("/developers/tokens");
  for (const path of ["/developers/mcp", "/developers/cli", "/developers/webhooks", "/developers/embeds"]) {
    await menu.selectOption(path);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(menu).toHaveValue(path);
  }
});
