import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { E2E_PORT, E2E_SESSION_TOKEN } from "./env.mjs";

// Developers > API tokens: a scoped, expiring token made from a vertical list of plain-language
// choices (an accordion of radios), shown once, listed with plain permission names, and limited to them when used.

const base = `http://localhost:${E2E_PORT}`;

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: "op_session", value: E2E_SESSION_TOKEN, url: base, secure: true, httpOnly: true }]);
});

test("creates a Monitoring sync token that expires in 90 days and can only do what it says", async ({ page, request }) => {
  const name = `Agent ${Date.now().toString(36)}`;
  await page.goto("/developers/tokens");
  await page.getByLabel("Name").fill(name);
  const group = page.getByRole("radiogroup", { name: "What can this token do?" });
  await expect(group.getByRole("radio")).toHaveCount(5);
  await expect(group.getByRole("radio", { name: /Read-only/ })).toBeChecked();
  await expect(page.getByLabel("Expires after")).toHaveValue("90");
  await expect(page.getByText("Look, but never change anything")).toBeVisible();

  // Only the open card shows its details, in plain words.
  await group.getByText("Monitoring sync").click();
  await expect(group.getByRole("radio", { name: /Monitoring sync/ })).toBeChecked();
  await expect(page.getByText("Add, change, pause and resume monitors")).toBeVisible();
  await expect(page.getByText("Remove monitors")).toBeVisible();
  await expect(page.getByText("See monitors, incidents, uptime and reports")).toHaveCount(1);
  await expect(page.getByRole("checkbox")).toHaveCount(0);

  const axe = await new AxeBuilder({ page }).include("main").analyze();
  expect(axe.violations).toEqual([]);

  await page.getByRole("button", { name: "Create token" }).click();
  const status = page.getByRole("status").filter({ hasText: "is ready" });
  await expect(status).toBeVisible();
  const token = (await status.locator("code").textContent())!.trim();
  expect(token).toMatch(/^opk_/);

  const row = page.getByRole("listitem").filter({ hasText: name });
  await expect(row).toContainText("See everything");
  await expect(row).toContainText("Manage monitors");
  await expect(row).not.toContainText("monitors:write");
  await expect(row).toContainText("Never used");
  await expect(row).toContainText(/Expires in (89|90)d/);
  await expect(row).not.toContainText("Full control");

  const bearer = { authorization: `Bearer ${token}` };
  expect((await request.get("/api/monitors", { headers: bearer })).status()).toBe(200);
  const refused = await request.get("/api/settings", { headers: bearer });
  expect(refused.status()).toBe(403);
  expect(await refused.json()).toMatchObject({ error: "insufficient_scope", required: "admin" });
  expect(await (await request.get("/api/api-tokens/self", { headers: bearer })).json()).toMatchObject({
    name,
    scopes: ["read", "monitors:write"],
  });
});

test("Full admin is one clear line and a warning, not ticked boxes; Custom has the only checkboxes", async ({ page }) => {
  await page.goto("/developers/tokens");
  const group = page.getByRole("radiogroup", { name: "What can this token do?" });
  await group.getByText("Full admin").click();
  await expect(page.getByText("Everything, including settings, exports and other tokens. Only for your own CLI.")).toBeVisible();
  await expect(page.getByText(/Give an AI\s+agent a narrower one/)).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);

  await group.getByText("Custom").click();
  await expect(page.getByRole("checkbox")).toHaveCount(4);
  await expect(page.getByRole("checkbox", { name: /^See everything/ })).not.toBeChecked();
  await page.getByLabel("Name").fill("Custom mix");
  await expect(page.getByRole("button", { name: "Create token" })).toBeDisabled();
  await expect(page.getByText("Tick at least one permission.")).toBeVisible();
  await page.getByRole("checkbox", { name: /^Manage incidents/ }).check();
  await page.getByRole("checkbox", { name: /^See everything/ }).check();
  await page.getByRole("button", { name: "Create token" }).click();
  const row = page.getByRole("listitem").filter({ hasText: "Custom mix" });
  await expect(row).toContainText("See everything");
  await expect(row).toContainText("Manage incidents");
  await expect(row).not.toContainText("Full control");
});

test("the choices work from the keyboard; an expiry and revoke work from the list", async ({ page }) => {
  const name = `Preset ${Date.now().toString(36)}`;
  await page.goto("/developers/tokens");
  const group = page.getByRole("radiogroup", { name: "What can this token do?" });
  await group.getByRole("radio", { name: /Read-only/ }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(group.getByRole("radio", { name: /Monitoring sync/ })).toBeChecked();
  await expect(group.getByRole("radio", { name: /Monitoring sync/ })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(group.getByRole("radio", { name: /^Maintenance/ })).toBeChecked();
  await expect(page.getByText("Start, change and end maintenance windows")).toBeVisible();
  await page.getByLabel("Expires after").selectOption("never");
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create token" }).click();
  const row = page.getByRole("listitem").filter({ hasText: name });
  await expect(row).toContainText("Manage maintenance");
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
