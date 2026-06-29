import { z } from "zod";
import { DateTime } from "luxon";

/**
 * Shared validation schemas (worker + client). These define the wire shape of
 * monitor configuration: HTTP requests, assertions, schedules, notification and
 * public-page preferences, and heartbeat settings (PRD §6, §7).
 */

export const httpMethodSchema = z.enum([
  "HEAD",
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

export const headerSchema = z.object({
  name: z.string().min(1).max(256),
  // ~8 KB: request headers are stored and replayed on every check.
  value: z.string().max(8192),
});

export const httpAuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({
    type: z.literal("basic"),
    username: z.string(),
    password: z.string(),
  }),
  z.object({ type: z.literal("bearer"), token: z.string() }),
]);

// --- Content / JSON assertions (PRD §6.2) ---
export const assertionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("contains"),
    value: z.string().min(1).max(8192),
    caseSensitive: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("not_contains"),
    value: z.string().min(1).max(8192),
    caseSensitive: z.boolean().default(false),
  }),
  z.object({ kind: z.literal("not_empty") }),
  z.object({ kind: z.literal("is_json") }),
  z.object({ kind: z.literal("json_path_exists"), path: z.string().min(1) }),
  z.object({
    kind: z.literal("json_path_equals"),
    path: z.string().min(1),
    value: z.string().max(8192),
  }),
  z.object({
    kind: z.literal("json_path_contains"),
    path: z.string().min(1),
    value: z.string().max(8192),
  }),
]);

export const httpConfigSchema = z
  .object({
    // Constrain the scheme (and bound length) so client + server agree with the
    // outbound `assertSafeUrl` boundary: the value is also rendered as a
    // clickable admin href, so `javascript:`/`data:`/`file:` must be rejected.
    url: z
      .string()
      .url()
      .max(2048)
      .refine((u) => {
        try {
          return /^https?:$/.test(new URL(u).protocol);
        } catch {
          return false;
        }
      }, "url must be http(s)"),
    method: httpMethodSchema.default("GET"),
    headers: z.array(headerSchema).max(100).default([]),
    // ~64 KB: the body is stored in a TEXT column and replayed on every check.
    body: z.string().max(65536).optional(),
    auth: httpAuthSchema.default({ type: "none" }),
    timeoutMs: z.number().int().min(1000).max(120000).default(60000),
    warmupTimeoutMs: z.number().int().min(1000).max(300000).default(120000),
    followRedirects: z.boolean().default(true),
    expectedStatus: z
      .object({
        min: z.number().int().min(100).max(599).default(200),
        max: z.number().int().min(100).max(599).default(399),
      })
      .default({ min: 200, max: 399 })
      .refine((s) => s.min <= s.max, {
        message: "expectedStatus.min must be <= expectedStatus.max",
      }),
    degradedResponseMs: z.number().int().positive().optional(),
    failResponseMs: z.number().int().positive().optional(),
  })
  .refine(
    (cfg) =>
      cfg.degradedResponseMs == null ||
      cfg.failResponseMs == null ||
      cfg.degradedResponseMs <= cfg.failResponseMs,
    {
      message: "degradedResponseMs must be <= failResponseMs",
      path: ["degradedResponseMs"],
    },
  );

// --- Schedules (PRD §7) ---
export const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/**
 * A schedule timezone: an IANA zone name. Defaults to UTC and is refined so an
 * invalid zone is rejected at validation time — otherwise a bad zone would make
 * the monitor permanently `scheduled_off` and never be checked.
 */
export const timezoneSchema = z
  .string()
  .default("UTC")
  .refine((tz) => DateTime.local().setZone(tz).isValid, "invalid timezone");
export const weekdaySchema = z.number().int().min(0).max(6); // 0=Sun … 6=Sat
export const periodSchema = z.object({
  start: timeOfDaySchema,
  end: timeOfDaySchema, // end < start denotes an overnight period
});

export const scheduleSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("always") }),
  z.object({
    mode: z.literal("business_hours"),
    // `.min(1)`: a business-hours schedule with no weekdays would never run, so
    // the monitor would be silently `scheduled_off` forever and never checked.
    weekdays: z.array(weekdaySchema).min(1).max(7).default([1, 2, 3, 4, 5]),
    start: timeOfDaySchema.default("08:00"),
    end: timeOfDaySchema.default("17:00"),
    timezone: timezoneSchema,
  }),
  z.object({
    mode: z.literal("custom"),
    timezone: timezoneSchema,
    days: z
      .array(
        z.object({
          weekday: weekdaySchema,
          periods: z.array(periodSchema).max(24),
        }),
      )
      .max(31)
      .default([]),
    // YYYY-MM-DD; bounded so the JSON config blob can't grow unboundedly.
    excludedDates: z
      .array(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/))
      .max(1000)
      .default([]),
  }),
]);

// --- Notification + public preferences ---
export const notifySchema = z.object({
  channels: z.array(z.string().max(64)).max(100).default([]),
  events: z.record(z.string(), z.boolean()).optional(),
});

export const publicConfigSchema = z.object({
  visible: z.boolean().default(false),
  name: z.string().max(256).optional(),
  description: z.string().max(256).optional(),
  group: z.string().max(256).optional(),
  sortOrder: z.number().int().default(0),
  showUptime: z.boolean().default(true),
  showResponseTime: z.boolean().default(false),
  showIncidentDetails: z.boolean().default(true),
  showScheduledOff: z.boolean().default(false),
});

export const heartbeatConfigSchema = z.object({
  intervalSeconds: z.number().int().min(60).max(2592000).default(3600),
  graceSeconds: z.number().int().min(0).max(86400).default(300),
  acceptedMethods: z.array(httpMethodSchema).optional(),
  secret: z.string().optional(),
});

// --- Monitor create/update ---
const baseMonitorFields = {
  name: z.string().min(1).max(120),
  schedule: scheduleSchema.default({ mode: "always" }),
  // Function defaults so an omitted object still receives all nested field
  // defaults (zod uses a plain `.default(value)` verbatim, without re-parsing).
  notify: notifySchema.default(() => notifySchema.parse({})),
  public: publicConfigSchema.default(() => publicConfigSchema.parse({})),
  enabled: z.boolean().default(true),
};

export const createMonitorSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("http"),
    ...baseMonitorFields,
    config: httpConfigSchema,
    assertions: z.array(assertionSchema).default([]),
  }),
  z.object({
    type: z.literal("heartbeat"),
    ...baseMonitorFields,
    config: heartbeatConfigSchema,
  }),
]);

// Inferred types
export type HttpMethod = z.infer<typeof httpMethodSchema>;
export type HttpConfig = z.infer<typeof httpConfigSchema>;
export type HeartbeatConfig = z.infer<typeof heartbeatConfigSchema>;
export type Assertion = z.infer<typeof assertionSchema>;
export type Schedule = z.infer<typeof scheduleSchema>;
export type NotifyPrefs = z.infer<typeof notifySchema>;
export type PublicConfig = z.infer<typeof publicConfigSchema>;
export type CreateMonitorInput = z.infer<typeof createMonitorSchema>;
