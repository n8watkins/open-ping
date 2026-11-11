import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { E2E_PORT, E2E_SERVER_LOG, E2E_SESSION_TOKEN } from "./env.mjs";

// The Hosted waitlist, the way a visitor meets it: the landing page's form (with Turnstile on, using
// Cloudflare's test keys), the confirm email, the confirm and leave pages, in light and dark.
// e2e/serve.mjs plays the canonical install and keeps each email wrangler "sends" as an .eml file.

const base = `http://localhost:${E2E_PORT}`;
const stateDir = path.join(path.dirname(fileURLToPath(import.meta.url)), ".state");

let seq = 0;
const unique = () => `visitor-${Date.now().toString(36)}${(seq += 1)}@example.com`;

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * Waits for the email to `to`, and returns its text and the links in it. Wrangler's local email
 * binding prints each message's recipient and where it saved its text.
 */
async function emailTo(to: string) {
  let body = "";
  await expect
    .poll(
      () => {
        const log = readFileSync(E2E_SERVER_LOG, "utf8").replace(ANSI, "");
        const block = [...log.matchAll(/^To: (\S+)\n(?:.*\n)*?Text: (\S+)$/gm)].findLast((m) => m[1] === to);
        const file = block?.[2];
        return (body = file && existsSync(file) ? readFileSync(file, "utf8") : "");
      },
      { timeout: 15_000 },
    )
    .not.toBe("");
  const link = (kind: "confirm" | "leave") => new RegExp(`${base.replace(/[.]/g, "\\.")}/waitlist/${kind}\\?t=[\\w-]+`).exec(body)![0];
  return { body, confirm: link("confirm"), leave: link("leave") };
}

/** The local database, for the one thing a visitor can't do: let seven days pass. */
function database(): DatabaseSync {
  const dir = path.join(stateDir, "v3", "d1", "miniflare-D1DatabaseObject");
  const file = readdirSync(dir).find((f) => f.endsWith(".sqlite") && !f.startsWith("metadata"))!;
  return new DatabaseSync(path.join(dir, file));
}

/**
 * Every request here comes from one address, and the form allows five sign-ups a minute per
 * address, so each sign-up presents as its own visitor (Cloudflare sets this header in production).
 */
let visitors = 0;
const visitor = () => ({ "cf-connecting-ip": `10.9.${Math.floor((visitors += 1) / 250)}.${visitors % 250}` });

async function asNewVisitor(page: Page) {
  const headers = visitor();
  await page.route(`${base}/api/waitlist`, (route) => route.continue({ headers: { ...route.request().headers(), ...headers } }));
}

async function join(page: Page, email: string) {
  await asNewVisitor(page);
  await page.goto("/");
  const form = page.locator("form", { has: page.getByLabel("Email address") }).first();
  await form.scrollIntoViewIfNeeded();
  await form.getByLabel("Email address").fill(email);
  // The invisible check runs on its own; the token field appears when it passes.
  await expect(form.locator('input[name="cf-turnstile-response"]')).not.toHaveValue("", { timeout: 15_000 });
  await form.getByRole("button", { name: "Join the waitlist" }).click();
  await expect(page.getByRole("status")).toContainText("Check your inbox");
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} mode`, () => {
    test.use({ colorScheme: scheme });

    test("joining, confirming from the email, and the pages follow the system theme", async ({ page }) => {
      const email = unique();
      await join(page, email);

      const mail = await emailTo(email);
      expect(mail.body).toContain("Confirm my spot");
      expect(mail.body).toContain(mail.leave);

      // Opening the link alone confirms nothing.
      await page.goto(mail.confirm);
      await expect(page.getByRole("heading", { name: "Confirm your spot" })).toBeVisible();
      await expect(page.locator("body")).toHaveCSS("background-color", scheme === "dark" ? "rgb(11, 18, 32)" : "rgb(246, 248, 251)");
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.getByRole("button", { name: "Confirm my spot" }).click();
      await expect(page.getByRole("heading", { name: "You're on the list" })).toBeVisible();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

      // A second use of the same link is harmless.
      await page.goto(mail.confirm);
      await page.getByRole("button", { name: "Confirm my spot" }).click();
      await expect(page.getByRole("heading", { name: "You're already confirmed" })).toBeVisible();
    });

    test("an expired link says so and confirms nothing", async ({ page }) => {
      const email = unique();
      await join(page, email);
      const { confirm } = await emailTo(email);
      const token = new URL(confirm).searchParams.get("t")!;
      const db = database();
      db.prepare("UPDATE waitlist_tokens SET expires_at = ? WHERE token_hash = ?").run(Date.now() - 1000, createHash("sha256").update(token).digest("hex"));
      db.close();

      await page.goto(confirm);
      await page.getByRole("button", { name: "Confirm my spot" }).click();
      await expect(page.getByRole("heading", { name: "This link has expired" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Sign up again" })).toBeVisible();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      const check = database();
      expect(check.prepare("SELECT confirmed_at FROM waitlist WHERE email = ?").get(email)).toEqual({ confirmed_at: null });
      check.close();
    });

    test("the leave link deletes the address in one click", async ({ page }) => {
      const email = unique();
      await join(page, email);
      const { leave } = await emailTo(email);

      await page.goto(leave);
      await expect(page.getByRole("heading", { name: "You've left the waitlist" })).toBeVisible();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      const db = database();
      expect(db.prepare("SELECT 1 AS found FROM waitlist WHERE email = ?").get(email)).toBeUndefined();
      db.close();

      await page.goto(leave);
      await expect(page.getByRole("heading", { name: "You're not on the waitlist" })).toBeVisible();
    });
  });
}

test("the landing form shows a Turnstile challenge area and no console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  await page.goto("/");
  const form = page.locator("form", { has: page.getByLabel("Email address") }).first();
  await form.scrollIntoViewIfNeeded();
  await expect(form.getByRole("button", { name: "Join the waitlist" })).toBeVisible();
  await expect(form.locator('input[name="cf-turnstile-response"]')).toBeAttached({ timeout: 15_000 });
  expect(errors).toEqual([]);
});

test("a sign-up the human check refuses is turned away and stores nothing", async ({ page, request }) => {
  const email = unique();

  // Straight to the API, with no token and with a made-up one.
  const none = await request.post("/api/waitlist", { data: { email }, headers: visitor() });
  expect(none.status()).toBe(400);
  expect(await none.json()).toEqual({ error: "turnstile_failed" });

  // Through the form, with the token stripped on its way out.
  const headers = visitor();
  await page.route(`${base}/api/waitlist`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    delete body.turnstile;
    await route.continue({ postData: JSON.stringify(body), headers: { ...route.request().headers(), ...headers } });
  });
  await page.goto("/");
  const form = page.locator("form", { has: page.getByLabel("Email address") }).first();
  await form.scrollIntoViewIfNeeded();
  await form.getByLabel("Email address").fill(email);
  await expect(form.locator('input[name="cf-turnstile-response"]')).not.toHaveValue("", { timeout: 15_000 });
  await form.getByRole("button", { name: "Join the waitlist" }).click();
  await expect(page.getByRole("alert")).toContainText("couldn't confirm you're human");

  const db = database();
  expect(db.prepare("SELECT 1 AS found FROM waitlist WHERE email = ?").get(email)).toBeUndefined();
  db.close();
});

test("the settings report counts confirmed people and shows unconfirmed ones apart", async ({ page, context }) => {
  await context.addCookies([{ name: "op_session", value: E2E_SESSION_TOKEN, url: base, secure: true, httpOnly: true }]);
  const waiting = unique();
  const joined = await page.request.post("/api/waitlist", {
    data: { email: waiting, turnstile: "XXXX.DUMMY.TOKEN.XXXX" },
    headers: visitor(),
  });
  expect(joined.status()).toBe(200);
  await emailTo(waiting);

  await page.goto("/settings/reports");
  const card = page.locator("#waitlist");
  await expect(card).toContainText("People waiting");
  await expect(card).toContainText("Not yet confirmed");
  await expect(card).not.toContainText(waiting);
  const list = await page.request.get("/api/waitlist");
  const body = (await list.json()) as { count: number; pending: number; entries: { email: string }[] };
  expect(body.pending).toBeGreaterThanOrEqual(1);
  expect(body.entries.map((e) => e.email)).not.toContain(waiting);
});
