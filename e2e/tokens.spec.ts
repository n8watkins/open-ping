import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { E2E_PORT, E2E_SESSION_TOKEN } from "./env.mjs";

// Developers > API tokens: a scoped, expiring token made from a preset, shown once,
// listed with its scopes and expiry, and limited to them when used.

const base = `http://localhost:${E2E_PORT}`;

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: "op_session", value: E2E_SESSION_TOKEN, url: base, secure: true, httpOnly: true }]);
});

test("creates a Monitoring sync token that expires in 90 days and can only do what it says", async ({ page, request }) => {
  const name = `Agent ${Date.now().toString(36)}`;
  await page.goto("/developers/tokens");
  await page.getByLabel("Name").fill(name);
  const preset = page.getByLabel("Preset");
  await expect(preset).toHaveValue("read-only");
  await preset.selectOption({ label: "Monitoring sync" });
  await expect(preset).toHaveValue("monitoring-sync");
  await expect(page.getByRole("checkbox", { name: /^read/ })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /^monitors:write/ })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /^admin/ })).not.toBeChecked();
  await expect(page.getByLabel("Expires after")).toHaveValue("90");

  // Admin implies every other scope and warns.
  await page.getByRole("checkbox", { name: /^admin/ }).check();
  await expect(page.getByRole("checkbox", { name: /^incidents:write/ })).toBeDisabled();
  await expect(page.getByText("Give an AI agent a narrower token.")).toBeVisible();
  await expect(preset).toHaveValue("custom");
  await preset.selectOption({ label: "Monitoring sync" });
  await expect(page.getByRole("checkbox", { name: /^admin/ })).not.toBeChecked();

  // A hand-picked mix reads as Custom, and the full scope list stays visible whatever the preset.
  await page.getByRole("checkbox", { name: /^incidents:write/ }).check();
  await expect(preset).toHaveValue("custom");
  await expect(page.getByRole("checkbox")).toHaveCount(5);
  await page.getByRole("checkbox", { name: /^incidents:write/ }).uncheck();
  await expect(preset).toHaveValue("monitoring-sync");

  const axe = await new AxeBuilder({ page }).include("main").analyze();
  expect(axe.violations).toEqual([]);

  await page.getByRole("button", { name: "Create token" }).click();
  const status = page.getByRole("status").filter({ hasText: "is ready" });
  await expect(status).toBeVisible();
  const token = (await status.locator("code").textContent())!.trim();
  expect(token).toMatch(/^opk_/);

  const row = page.getByRole("listitem").filter({ hasText: name });
  await expect(row).toContainText("monitors:write");
  await expect(row).toContainText("Never used");
  await expect(row).toContainText(/Expires in (89|90)d/);
  await expect(row).not.toContainText("Full admin");

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

test("every preset fills its scopes, and an expiry and revoke work from the list", async ({ page }) => {
  const name = `Preset ${Date.now().toString(36)}`;
  await page.goto("/developers/tokens");
  const preset = page.getByLabel("Preset");
  const expected: Record<string, string[]> = {
    "read-only": ["read"],
    "monitoring-sync": ["read", "monitors:write"],
    maintenance: ["read", "maintenance:write"],
    admin: ["admin"],
  };
  for (const [id, scopes] of Object.entries(expected)) {
    await preset.selectOption(id);
    for (const s of ["read", "monitors:write", "incidents:write", "maintenance:write", "admin"]) {
      const box = page.getByRole("checkbox", { name: new RegExp(`^${s}`) });
      if (scopes.includes(s) || (id === "admin" && s !== "admin")) await expect(box).toBeChecked();
      else await expect(box).not.toBeChecked();
    }
  }
  await preset.selectOption("maintenance");
  await page.getByLabel("Expires after").selectOption("never");
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create token" }).click();
  const row = page.getByRole("listitem").filter({ hasText: name });
  await expect(row).toContainText("maintenance:write");
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
