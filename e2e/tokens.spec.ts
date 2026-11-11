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
  await page.getByRole("button", { name: "Monitoring sync" }).click();
  await expect(page.getByRole("button", { name: "Monitoring sync" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("checkbox", { name: /^read/ })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /^monitors:write/ })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /^admin/ })).not.toBeChecked();
  await expect(page.getByLabel("Expires after")).toHaveValue("90");

  // Admin implies every other scope and warns.
  await page.getByRole("checkbox", { name: /^admin/ }).check();
  await expect(page.getByRole("checkbox", { name: /^incidents:write/ })).toBeDisabled();
  await expect(page.getByText("Give an AI agent a narrower token.")).toBeVisible();
  await page.getByRole("button", { name: "Monitoring sync" }).click();

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
