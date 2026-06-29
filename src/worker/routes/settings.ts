import { Hono } from "hono";
import type { AppEnv } from "../types";
import { requireAuth } from "../middleware/auth";
import { getExportableSettings, setSetting } from "../db/settings";

/**
 * General settings API mounted at /api/settings. Reads/writes non-secret app
 * configuration through a whitelist (secrets go through dedicated flows).
 */
export const settings = new Hono<AppEnv>();
settings.use("*", requireAuth);

const WRITABLE = new Set([
  "timezone",
  "app_url",
  "email_from",
  "vapid_subject",
  "status_page_enabled",
  "status_page_name",
  "status_page_description",
  "status_page_logo",
  "status_page_favicon",
  "status_page_accent",
  "status_page_theme",
  "status_page_homepage",
  "status_page_footer",
  "status_page_attribution",
  "weekly_summary_enabled",
  "weekly_summary_day",
  "weekly_summary_hour",
  "retention",
  "notify_defaults",
]);

settings.get("/", async (c) => {
  return c.json({ settings: await getExportableSettings(c.env) });
});

settings.put("/", async (c) => {
  const body = await c.req
    .json<{ settings?: Record<string, unknown> }>()
    .catch(() => ({ settings: undefined }));
  const input = body.settings ?? {};
  const written: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (!WRITABLE.has(key)) continue;
    await setSetting(c.env, key, typeof value === "string" ? value : JSON.stringify(value));
    written.push(key);
  }
  return c.json({ ok: true, written, settings: await getExportableSettings(c.env) });
});
