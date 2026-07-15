import { Hono } from "hono";
import { DateTime } from "luxon";
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

/** Validate that a string is "true" or "false". */
function boolSetting(v: string): string | null {
  return v === "true" || v === "false" ? null : "must be 'true' or 'false'";
}

/** Validate an integer string within [min, max]. */
function intRange(min: number, max: number) {
  return (v: string): string | null => {
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max
      ? null
      : `must be an integer in [${min}, ${max}]`;
  };
}

/**
 * Validate an OPTIONAL http(s) URL setting bounded to `max` chars. An empty
 * string is allowed (it clears the setting). Used for status-page branding
 * values that are rendered as an `href`/`src` on the PUBLIC status page, so a
 * `javascript:`/`data:` scheme must be rejected at the server boundary.
 */
function optionalUrlSetting(max = 2048) {
  return (v: string): string | null => {
    if (v === "") return null;
    if (v.length > max) return `must be at most ${max} characters`;
    try {
      const u = new URL(v);
      return u.protocol === "http:" || u.protocol === "https:"
        ? null
        : "must be an http(s) URL";
    } catch {
      return "must be a valid URL";
    }
  };
}

/**
 * Per-key value validators for writable settings (keys without an entry accept
 * any string). Each returns an error message when the value is invalid, so the
 * PUT handler can reject the whole request before storing anything.
 */
const VALIDATORS: Record<string, (v: string) => string | null> = {
  timezone: (v) =>
    DateTime.local().setZone(v).isValid ? null : "must be a valid IANA timezone",
  // app_url is interpolated into notification emails/links; require a real
  // http(s) URL so a malformed value can't break out of an href attribute
  // (the renderer also escapes it as defense-in-depth).
  app_url: (v) => {
    try {
      const u = new URL(v);
      const validScheme =
        u.protocol === "https:" ||
        (u.protocol === "http:" &&
          (u.hostname === "localhost" || u.hostname === "127.0.0.1"));
      return validScheme &&
        !u.username &&
        !u.password &&
        u.pathname === "/" &&
        !u.search &&
        !u.hash
        ? null
        : "must be an https origin (http is allowed only for local development)";
    } catch {
      return "must be a valid URL";
    }
  },
  // `retention` is a JSON object { sampleHours, hourlyDays, dailyDays } (read by
  // history/rollups + routes/diagnostics); each provided field must be a
  // positive integer.
  retention: (v) => {
    let obj: unknown;
    try {
      obj = JSON.parse(v);
    } catch {
      return "must be a JSON object { sampleHours, hourlyDays, dailyDays }";
    }
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
      return "must be a JSON object { sampleHours, hourlyDays, dailyDays }";
    }
    for (const k of ["sampleHours", "hourlyDays", "dailyDays"]) {
      const val = (obj as Record<string, unknown>)[k];
      if (val !== undefined && !(typeof val === "number" && Number.isInteger(val) && val > 0)) {
        return `${k} must be a positive integer`;
      }
    }
    return null;
  },
  status_page_accent: (v) =>
    /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)
      ? null
      : "must be a hex color (e.g. #6d8bff)",
  status_page_theme: (v) =>
    v === "dark" || v === "light" ? null : "must be 'dark' or 'light'",
  // Rendered as an href/src on the PUBLIC status page — require a safe scheme.
  status_page_homepage: optionalUrlSetting(),
  status_page_logo: optionalUrlSetting(),
  status_page_enabled: boolSetting,
  status_page_attribution: boolSetting,
  weekly_summary_enabled: boolSetting,
  weekly_summary_day: intRange(0, 6),
  weekly_summary_hour: intRange(0, 23),
};

settings.get("/", async (c) => {
  return c.json({ settings: await getExportableSettings(c.env) });
});

settings.put("/", async (c) => {
  const body = await c.req
    .json<{ settings?: Record<string, unknown> }>()
    .catch(() => ({ settings: undefined }));
  const input = body.settings ?? {};

  // Validate every provided writable key BEFORE writing anything so an invalid
  // value can't store garbage or leave a partial write behind (all-or-nothing).
  const pending: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Object.entries(input)) {
    if (!WRITABLE.has(key)) continue;
    const str = typeof value === "string" ? value : JSON.stringify(value);
    const validate = VALIDATORS[key];
    const error = validate ? validate(str) : null;
    if (error) {
      return c.json({ error: "validation", key, message: error }, 400);
    }
    pending.push({ key, value: str });
  }

  const written: string[] = [];
  for (const { key, value } of pending) {
    await setSetting(c.env, key, value);
    written.push(key);
  }
  return c.json({ ok: true, written, settings: await getExportableSettings(c.env) });
});
