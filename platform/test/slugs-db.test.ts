import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { SLUG_HOLD_MS, SLUG_MESSAGES, checkSlugAvailability, holdSlug } from "../src/slugs";

beforeAll(async () => {
  await applyD1Migrations(env.PLATFORM_DB, env.TEST_MIGRATIONS);
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare("INSERT INTO accounts (id, email, created_at, updated_at) VALUES ('acc_slug', 'slug@example.com', 0, 0)"),
    env.PLATFORM_DB.prepare(
      "INSERT INTO tenants (id, account_id, slug, script_name, created_at, updated_at) VALUES ('slugtenant000001', 'acc_slug', 'existing', 't-slugtenant000001', 0, 0)",
    ),
  ]);
});

describe("slug availability", () => {
  it("normalizes, applies the rules, then checks the database", async () => {
    const db = env.PLATFORM_DB;
    expect(await checkSlugAvailability(db, " Brand-New ", 0)).toEqual({ ok: true, slug: "brand-new" });
    expect(await checkSlugAvailability(db, "Existing", 0)).toEqual({ ok: false, slug: "existing", reason: "taken" });
    expect(await checkSlugAvailability(db, "support", 0)).toEqual({ ok: false, slug: "support", reason: "reserved" });
    expect(await checkSlugAvailability(db, "no", 0)).toEqual({ ok: false, slug: "no", reason: "length" });
  });

  it("treats a held slug as taken until the hold ends, and never shortens a hold", async () => {
    const db = env.PLATFORM_DB;
    await holdSlug(db, "oldname", "deleted", 1_000);
    expect(await checkSlugAvailability(db, "oldname", 1_000 + SLUG_HOLD_MS - 1)).toMatchObject({ ok: false, reason: "taken" });
    expect(await checkSlugAvailability(db, "oldname", 1_000 + SLUG_HOLD_MS)).toMatchObject({ ok: true });
    await holdSlug(db, "oldname", "owner", 5_000);
    await holdSlug(db, "oldname", "renamed", 2_000);
    const row = await db.prepare("SELECT held_until FROM slug_holds WHERE slug = 'oldname'").first<{ held_until: number }>();
    expect(row!.held_until).toBe(5_000 + SLUG_HOLD_MS);
  });

  it("has a plain sentence for every reason", () => {
    for (const message of Object.values(SLUG_MESSAGES)) expect(message).toMatch(/^[A-Z].*\.$/);
  });
});
