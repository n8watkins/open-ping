import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import "../../src/worker/index";
import { WAITLIST_PER_ADDRESS_DAILY_LIMIT, WAITLIST_PER_IP_LIMIT } from "../../src/worker/routes/waitlist";
import { RATE_LIMIT_WINDOW_MS } from "../../src/worker/db/rate-limit";
import { PENDING_DAYS, expiredWaitlistCleanupStatements } from "../../src/worker/db/waitlist";
import { sha256hex } from "../../src/worker/lib/ids";
import type { EmailBinding } from "../../src/worker/notifications/mail";

const ORIGIN = "https://openping.test";
const API_TOKEN = "integration-api-token";
const DAY_MS = 24 * 60 * 60 * 1000;

let sent: Array<Parameters<EmailBinding["send"]>[0]> = [];
const mailbox: EmailBinding = {
  async send(m) {
    sent.push(m);
    return { messageId: `m${sent.length}` };
  },
};

function join(email: string, ip: string, extra: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(`${ORIGIN}/api/waitlist`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, origin: "https://someone-else.example" },
    body: JSON.stringify({ email, ...extra }),
  });
}

function admin(path: string): Promise<Response> {
  return exports.default.fetch(`${ORIGIN}${path}`, { headers: { authorization: `Bearer ${API_TOKEN}` } });
}

function page(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(`${ORIGIN}${path}`, init);
}

/** The sign-up's work runs after the answer; waits until `check` holds. */
async function until<T>(check: () => Promise<T | null | undefined | false> | T | null | undefined | false): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out waiting");
}

const mailsTo = (to: string) => sent.filter((m) => m.to === to).length;

const row = (email: string) =>
  env.DB.prepare("SELECT id, confirmed_at, expires_at FROM waitlist WHERE email = ?")
    .bind(email)
    .first<{ id: string; confirmed_at: number | null; expires_at: number | null }>();

/** The confirm and leave tokens in the last email sent to `to`. */
function linksIn(to: string): { confirm: string; leave: string } {
  const mail = [...sent].reverse().find((m) => m.to === to);
  if (!mail) throw new Error(`no email to ${to}`);
  const text = mail.text ?? "";
  return {
    confirm: /\/waitlist\/confirm\?t=([\w-]+)/.exec(text)![1]!,
    leave: /\/waitlist\/leave\?t=([\w-]+)/.exec(text)![1]!,
  };
}

const confirmPost = (token: string) => page(`/waitlist/confirm?t=${token}`, { method: "POST" });
const setKeys = (site?: string, secret?: string) => {
  const e = env as { TURNSTILE_SITE_KEY?: string; TURNSTILE_SECRET_KEY?: string };
  e.TURNSTILE_SITE_KEY = site;
  e.TURNSTILE_SECRET_KEY = secret;
};

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  (env as { EMAIL?: EmailBinding }).EMAIL = mailbox;
});

beforeEach(async () => {
  sent = [];
  await env.DB.prepare("DELETE FROM rate_limits").run();
});

afterEach(() => {
  vi.restoreAllMocks();
  setKeys();
});

describe("the Hosted waitlist: joining", () => {
  it("has its tables after migrations", async () => {
    const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'waitlist%' ORDER BY name").all<{ name: string }>();
    expect(tables.results.map((t) => t.name)).toEqual(["waitlist", "waitlist_tokens"]);
  });

  it("stores a pending row, lowercased, and emails the confirm link with the leave link and headers", async () => {
    const res = await join("  Person@Example.COM ", "10.0.0.1");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual({ ok: true });

    await until(() => mailsTo("person@example.com"));
    const stored = await row("person@example.com");
    expect(stored?.confirmed_at).toBeNull();
    expect(stored?.expires_at).toBeGreaterThan(Date.now() + (PENDING_DAYS - 1) * DAY_MS);

    expect(mailsTo("person@example.com")).toBe(1);
    const mail = sent.find((m) => m.to === "person@example.com")!;
    expect(mail.to).toBe("person@example.com");
    expect(mail.subject).toContain("Confirm");
    expect(mail.html).toContain("/waitlist/confirm?t=");
    expect(mail.html).toContain("/waitlist/leave?t=");
    const { leave } = linksIn("person@example.com");
    expect(mail.headers).toEqual({
      "List-Unsubscribe": `<${ORIGIN}/waitlist/leave?t=${leave}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });

    // Only hashes are stored.
    const tokens = await env.DB.prepare("SELECT token_hash, purpose FROM waitlist_tokens WHERE waitlist_id = ?")
      .bind(stored!.id)
      .all<{ token_hash: string; purpose: string }>();
    expect(tokens.results.map((t) => t.purpose).sort()).toEqual(["confirm", "leave"]);
    expect(tokens.results.map((t) => t.token_hash)).toContain(await sha256hex(leave));
  });

  it("answers the same for a new, a pending and a confirmed address", async () => {
    const fresh = await join("same@example.com", "10.0.1.1");
    const freshBody = await fresh.text();
    await until(() => mailsTo("same@example.com"));
    expect(await join("same@example.com", "10.0.1.1").then((r) => r.text())).toBe(freshBody);
    await confirmPost(linksIn("same@example.com").confirm);
    const confirmed = await join("same@example.com", "10.0.1.1");
    expect(confirmed.status).toBe(fresh.status);
    expect(await confirmed.text()).toBe(freshBody);
  });

  it("sends a confirmed address nothing more, and a pending one a fresh link that replaces the old", async () => {
    await join("again@example.com", "10.0.2.1");
    await until(() => mailsTo("again@example.com") === 1);
    const first = linksIn("again@example.com");
    await join("again@example.com", "10.0.2.1");
    await until(() => mailsTo("again@example.com") === 2);
    const second = linksIn("again@example.com");
    expect(second.confirm).not.toBe(first.confirm);
    expect(await (await confirmPost(first.confirm)).text()).toContain("This link doesn't work");
    expect(await (await confirmPost(second.confirm)).text()).toContain("You're on the list");

    sent = [];
    await join("again@example.com", "10.0.2.1");
    await new Promise((r) => setTimeout(r, 150));
    expect(mailsTo("again@example.com")).toBe(0);
  });

  it("caps the confirm emails to one address a day", async () => {
    for (let i = 0; i < WAITLIST_PER_ADDRESS_DAILY_LIMIT + 2; i++) {
      await join("flood@example.com", `10.0.3.${i}`);
      await new Promise((r) => setTimeout(r, 60));
    }
    await until(() => mailsTo("flood@example.com") >= WAITLIST_PER_ADDRESS_DAILY_LIMIT);
    await new Promise((r) => setTimeout(r, 150));
    expect(sent.filter((m) => m.to === "flood@example.com")).toHaveLength(WAITLIST_PER_ADDRESS_DAILY_LIMIT);
  });

  it("answers a cross-origin preflight", async () => {
    const res = await exports.default.fetch(`${ORIGIN}/api/waitlist`, {
      method: "OPTIONS",
      headers: { origin: "https://someone-else.example", "access-control-request-method": "POST" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain("Content-Type");
  });

  it("rejects a bad email and quietly drops honeypot sign-ups", async () => {
    expect((await join("not-an-email", "10.0.0.2")).status).toBe(400);

    const bot = await join("bot@example.com", "10.0.0.2", { website: "https://spam.example" });
    expect(await bot.json()).toEqual({ ok: true });
    expect(await row("bot@example.com")).toBeNull();
  });

  it("rate limits one address after a handful of tries", async () => {
    // The limiter counts per fixed one-minute window; a burst that straddles a
    // window boundary starts a fresh count halfway and never reaches the cap.
    const untilNextWindow = RATE_LIMIT_WINDOW_MS - (Date.now() % RATE_LIMIT_WINDOW_MS);
    if (untilNextWindow < 5_000) await new Promise((r) => setTimeout(r, untilNextWindow + 50));
    const ip = "10.0.0.3";
    for (let i = 0; i < WAITLIST_PER_IP_LIMIT; i++) {
      expect((await join(`burst${i}@example.com`, ip)).status).toBe(200);
    }
    const limited = await join("one-too-many@example.com", ip);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
  });
});

describe("the Hosted waitlist: Turnstile", () => {
  const verdict = (success: boolean) =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ success }), { headers: { "content-type": "application/json" } }));

  it("tells the form its site key, or null while it is off", async () => {
    expect(await (await page("/api/waitlist/config")).json()).toEqual({ turnstileSiteKey: null });
    setKeys("site-key", "secret-key");
    const res = await page("/api/waitlist/config");
    expect(await res.json()).toEqual({ turnstileSiteKey: "site-key" });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("refuses a sign-up with no token or a failed one, and stores nothing", async () => {
    setKeys("site-key", "secret-key");
    const siteverify = verdict(false);
    const none = await join("nobody@example.com", "10.1.0.1");
    expect(none.status).toBe(400);
    expect(await none.json()).toEqual({ error: "turnstile_failed" });
    expect(siteverify).not.toHaveBeenCalled();

    const failed = await join("nobody@example.com", "10.1.0.1", { turnstile: "bad-token" });
    expect(failed.status).toBe(400);
    expect(await failed.json()).toEqual({ error: "turnstile_failed" });
    expect(siteverify).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(await row("nobody@example.com")).toBeNull();
    expect(mailsTo("nobody@example.com")).toBe(0);
  });

  it("refuses when Cloudflare can't be reached (fails closed)", async () => {
    setKeys("site-key", "secret-key");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    expect((await join("down@example.com", "10.1.0.2", { turnstile: "t" })).status).toBe(400);
  });

  it("takes a sign-up whose token passes, sending the secret and the client IP", async () => {
    setKeys("site-key", "secret-key");
    const siteverify = verdict(true);
    expect((await join("human@example.com", "10.1.0.3", { turnstile: "good-token" })).status).toBe(200);
    const body = siteverify.mock.calls[0]![1]!.body as FormData;
    expect(body.get("secret")).toBe("secret-key");
    expect(body.get("response")).toBe("good-token");
    expect(body.get("remoteip")).toBe("10.1.0.3");
    await until(() => mailsTo("human@example.com"));
    expect(await row("human@example.com")).not.toBeNull();
  });

  it("is on, and refuses everything, when only one of the two keys is set", async () => {
    setKeys(undefined, "secret-key");
    expect(await (await page("/api/waitlist/config")).json()).toEqual({ turnstileSiteKey: null });
    expect((await join("half@example.com", "10.1.0.4", { turnstile: "t" })).status).toBe(400);
  });
});

describe("the Hosted waitlist: confirming", () => {
  it("only shows a button on GET, and confirms on POST, once", async () => {
    await join("confirm@example.com", "10.2.0.1");
    await until(() => mailsTo("confirm@example.com"));
    const { confirm } = linksIn("confirm@example.com");

    const shown = await page(`/waitlist/confirm?t=${confirm}`);
    expect(shown.status).toBe(200);
    expect(shown.headers.get("cache-control")).toBe("no-store");
    expect(await shown.text()).toContain("Confirm my spot");
    expect((await row("confirm@example.com"))?.confirmed_at).toBeNull();

    const done = await confirmPost(confirm);
    expect(await done.text()).toContain("You're on the list");
    const confirmed = await row("confirm@example.com");
    expect(confirmed?.confirmed_at).not.toBeNull();
    expect(confirmed?.expires_at).toBeNull();

    // Replaying the link changes nothing and says the address is already confirmed.
    expect(await (await confirmPost(confirm)).text()).toContain("already confirmed");
  });

  it("takes the token from a form post too", async () => {
    await join("form@example.com", "10.2.0.2");
    await until(() => mailsTo("form@example.com"));
    const { confirm } = linksIn("form@example.com");
    const res = await page("/waitlist/confirm", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `t=${confirm}` });
    expect(await res.text()).toContain("You're on the list");
  });

  it("says an expired link has expired, and a made-up one doesn't work", async () => {
    await join("late@example.com", "10.2.0.3");
    await until(() => mailsTo("late@example.com"));
    const { confirm } = linksIn("late@example.com");
    await env.DB.prepare("UPDATE waitlist_tokens SET expires_at = ? WHERE token_hash = ?")
      .bind(Date.now() - 1, await sha256hex(confirm))
      .run();
    const expired = await confirmPost(confirm);
    expect(await expired.text()).toContain("This link has expired");
    expect((await row("late@example.com"))?.confirmed_at).toBeNull();

    expect(await (await confirmPost("made-up-token")).text()).toContain("This link doesn't work");
    expect((await page("/waitlist/confirm")).status).toBe(400);
  });

  it("lets an address with an expired pending row start over", async () => {
    await join("stale@example.com", "10.2.0.4");
    await until(() => mailsTo("stale@example.com"));
    const id = (await row("stale@example.com"))!.id;
    await env.DB.prepare("UPDATE waitlist SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, id).run();

    sent = [];
    await join("stale@example.com", "10.2.0.4");
    await until(() => mailsTo("stale@example.com"));
    const fresh = await row("stale@example.com");
    expect(fresh?.id).not.toBe(id);
    expect(fresh?.expires_at).toBeGreaterThan(Date.now());
  });

  it("the scheduler's cleanup removes expired pending rows with their tokens, never confirmed ones", async () => {
    await join("purge@example.com", "10.2.0.5");
    await join("keep@example.com", "10.2.0.6");
    await until(() => mailsTo("purge@example.com") + mailsTo("keep@example.com") === 2);
    await confirmPost(linksIn("keep@example.com").confirm);
    const purge = (await row("purge@example.com"))!.id;
    await env.DB.prepare("UPDATE waitlist SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, purge).run();
    for (const { stmt } of expiredWaitlistCleanupStatements(env)) await stmt.run();
    expect(await row("purge@example.com")).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM waitlist_tokens WHERE waitlist_id = ?").bind(purge).first()).toBeNull();
    expect(await row("keep@example.com")).not.toBeNull();
  });
});

describe("the Hosted waitlist: leaving", () => {
  it("deletes the row with one GET, and its tokens with it", async () => {
    await join("leaver@example.com", "10.3.0.1");
    await until(() => mailsTo("leaver@example.com"));
    const { leave } = linksIn("leaver@example.com");
    const id = (await row("leaver@example.com"))!.id;

    const res = await page(`/waitlist/leave?t=${leave}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("You've left the waitlist");
    expect(await row("leaver@example.com")).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM waitlist_tokens WHERE waitlist_id = ?").bind(id).first()).toBeNull();

    // A second click says it is already gone.
    expect(await (await page(`/waitlist/leave?t=${leave}`)).text()).toContain("not on the waitlist");
  });

  it("takes a mail app's one-click POST, and works for a confirmed row", async () => {
    await join("oneclick@example.com", "10.3.0.2");
    await until(() => mailsTo("oneclick@example.com"));
    const { confirm, leave } = linksIn("oneclick@example.com");
    await confirmPost(confirm);
    const res = await page(`/waitlist/leave?t=${leave}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    expect(res.status).toBe(200);
    expect(await row("oneclick@example.com")).toBeNull();
  });

  it("ignores a confirm token, or nonsense, as a leave link", async () => {
    await join("stays@example.com", "10.3.0.3");
    await until(() => mailsTo("stays@example.com"));
    const { confirm } = linksIn("stays@example.com");
    expect(await (await page(`/waitlist/leave?t=${confirm}`)).text()).toContain("not on the waitlist");
    expect(await (await page("/waitlist/leave?t=nonsense")).text()).toContain("not on the waitlist");
    expect(await row("stays@example.com")).not.toBeNull();
  });
});

describe("the Hosted waitlist: the admin report", () => {
  it("counts confirmed rows, pending ones apart, and lists and exports only confirmed by default", async () => {
    expect((await page("/api/waitlist")).status).toBe(401);
    expect((await page("/api/waitlist/export.csv")).status).toBe(401);

    await join("listed@example.com", "10.4.0.1");
    await join("waiting@example.com", "10.4.0.2");
    await until(() => mailsTo("listed@example.com") + mailsTo("waiting@example.com") === 2);
    await confirmPost(linksIn("listed@example.com").confirm);

    const list = await admin("/api/waitlist");
    const body = await list.json<{ count: number; pending: number; entries: { email: string; created_at: number }[] }>();
    const emails = body.entries.map((e) => e.email);
    expect(emails).toContain("listed@example.com");
    expect(emails).not.toContain("waiting@example.com");
    expect(body.pending).toBeGreaterThanOrEqual(1);
    const confirmedRows = await env.DB.prepare("SELECT COUNT(*) AS n FROM waitlist WHERE confirmed_at IS NOT NULL").first<{ n: number }>();
    expect(body.count).toBe(confirmedRows!.n);

    const csv = await admin("/api/waitlist/export.csv");
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const text = await csv.text();
    expect(text.split("\n")[0]).toBe("email,joined_at");
    expect(text).toContain("listed@example.com,");
    expect(text).not.toContain("waiting@example.com");

    const everyone = await (await admin("/api/waitlist/export.csv?status=all")).text();
    expect(everyone.split("\n")[0]).toBe("email,status,joined_at");
    expect(everyone).toContain("listed@example.com,confirmed,");
    expect(everyone).toContain("waiting@example.com,pending,");
  });
});

describe("the Hosted waitlist: rows from before double opt-in", () => {
  it("count as confirmed from the day they joined and never expire", async () => {
    // Migrate a fresh database up to 0029, add a row the old way, then run 0030.
    const all = env.TEST_MIGRATIONS;
    const split = all.findIndex((m) => m.name.startsWith("0030_"));
    expect(split).toBeGreaterThan(0);
    await applyD1Migrations(env.FRESH_DB, all.slice(0, split));
    await env.FRESH_DB.prepare("INSERT INTO waitlist (id, email, created_at) VALUES ('wl_old', 'old@example.com', 1700000000000)").run();
    await applyD1Migrations(env.FRESH_DB, all);
    const old = await env.FRESH_DB.prepare("SELECT confirmed_at, expires_at FROM waitlist WHERE id = 'wl_old'").first<{ confirmed_at: number; expires_at: number | null }>();
    expect(old).toEqual({ confirmed_at: 1700000000000, expires_at: null });
  });
});
