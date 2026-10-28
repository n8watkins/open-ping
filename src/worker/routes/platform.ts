import { Hono, type Context, type Next } from "hono";
import { z } from "zod";
import {
  HOSTED_ERRORS,
  INTERNAL_HEADER,
  isPlatformCall,
  type HealthResponse,
  type ScheduledRunSummary,
  type TenantProps,
} from "../../shared/hosted-contract";
import type { AppEnv } from "../types";
import { hostedProps } from "../lib/hosted";
import { countingD1, type UsageCounter } from "../lib/budget";
import { BUNDLE_VERSION, BUNDLED_SCHEMA_VERSION, ensureSchema, readSchemaState } from "../lib/migrate";
import { runScheduled } from "../scheduler";
import { reportUsage } from "../db/usage";

/**
 * The internal paths the OpenPing Hosted platform calls (docs/hosted/CONTRACT.md,
 * section 6), mounted at /__platform.
 *
 * Hosted mode only: on a plain install every handler passes through, so the
 * paths answer exactly what they answered before (the app shell). In hosted
 * mode only a platform call is served, one whose `x-openping-platform` header
 * equals `props.callId`; anything else gets the 404 an unknown route gets, so
 * the paths can't be discovered.
 */
export const platformRoutes = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;

/** This call's props when it is a platform call; null when it is hosted but not one; undefined on a plain install. */
function platformCall(c: Ctx): TenantProps | null | undefined {
  const props = hostedProps(c);
  if (!props) return undefined;
  return isPlatformCall(props, c.req.header(INTERNAL_HEADER) ?? null) ? props : null;
}

const notFound = (c: Ctx) => c.json({ error: HOSTED_ERRORS.notFound }, 404);

/** Runs `handler` only for a platform call (see platformCall). */
function onlyPlatform(handler: (c: Ctx, props: TenantProps) => Promise<Response>) {
  return async (c: Ctx, next: Next) => {
    const props = platformCall(c);
    if (props === undefined) return next();
    if (props === null) return notFound(c);
    return handler(c, props);
  };
}

const scheduledRequest = z.object({
  runId: z.string().min(1).max(200),
  scheduledTime: z.number().int().nonnegative(),
  cron: z.string().max(200),
});

/**
 * POST /__platform/scheduled: one scheduler run, called by the platform's queue
 * consumer for each due tenant (a user Worker in a dispatch namespace has no
 * Cron Trigger). It applies any missing migrations first, then runs exactly
 * what the scheduled() handler runs, and answers the run's summary with 200
 * whatever happened.
 */
platformRoutes.post(
  "/scheduled",
  onlyPlatform(async (c, props) => {
    const parsed = scheduledRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    const request = parsed.data;
    const startedAt = Date.now();
    // Queries outside the run itself (the migrations, the usage report) are
    // counted here; the run counts its own.
    const usage: UsageCounter = { d1: 0 };
    const db = countingD1(c.env.DB, usage);

    const summary = (over: Partial<ScheduledRunSummary> & Pick<ScheduledRunSummary, "outcome">): ScheduledRunSummary => ({
      runId: request.runId,
      version: BUNDLE_VERSION,
      schemaVersion: 0,
      migrationsApplied: 0,
      startedAt,
      durationMs: Date.now() - startedAt,
      checked: 0,
      failures: 0,
      deferred: 0,
      d1Queries: usage.d1,
      ...over,
    });

    const schema = await ensureSchema(db);
    if (!schema.ok) {
      return c.json(
        summary({
          outcome: "failed",
          schemaVersion: schema.schemaVersion,
          migrationsApplied: schema.applied,
          error: schema.error,
        }),
      );
    }
    const migrated = { schemaVersion: schema.schemaVersion, migrationsApplied: schema.applied };

    let result: Awaited<ReturnType<typeof runScheduled>>;
    try {
      const controller: ScheduledController = {
        cron: request.cron,
        scheduledTime: request.scheduledTime,
        noRetry() {},
      };
      result = await runScheduled(controller, c.env);
    } catch (error) {
      // runScheduled handles everything after it holds the lease; this is its
      // first round trip failing (the database didn't answer).
      console.error("[platform] scheduled run failed", error);
      return c.json(summary({ outcome: "failed", ...migrated, error: "the database did not answer" }));
    }
    if (result.outcome === "lease_busy") {
      return c.json(summary({ outcome: "lease_busy", ...migrated, d1Queries: usage.d1 + result.d1Queries }));
    }

    await reportUsage(db, props.platform);
    const { stats } = result;
    return c.json(
      summary({
        outcome: result.outcome,
        ...migrated,
        checked: stats.monitorsChecked,
        failures: stats.checkFailures,
        deferred: result.deferred,
        d1Queries: usage.d1 + (stats.d1Queries ?? 0),
        ...(result.outcome === "failed" ? { error: shortReason(stats.error) } : {}),
      }),
    );
  }),
);

/**
 * GET /__platform/health: version, schema and last run, for the release runner
 * and the platform's monitoring. It migrates first, like any call after an
 * update, but never waits on another call's migration: it reports it.
 */
platformRoutes.get(
  "/health",
  onlyPlatform(async (c) => {
    await ensureSchema(c.env.DB, { waitMs: 0 });
    let body: HealthResponse;
    try {
      const [schema, lastRun] = await Promise.all([readSchemaState(c.env.DB), lastFinishedRun(c.env.DB)]);
      body = {
        ok: schema.schemaVersion >= BUNDLED_SCHEMA_VERSION && !schema.migrating,
        version: BUNDLE_VERSION,
        schemaVersion: schema.schemaVersion,
        bundledSchemaVersion: BUNDLED_SCHEMA_VERSION,
        migrating: schema.migrating,
        lastRun,
      };
    } catch (error) {
      console.error("[platform] health: the database did not answer", error);
      body = {
        ok: false,
        version: BUNDLE_VERSION,
        schemaVersion: 0,
        bundledSchemaVersion: BUNDLED_SCHEMA_VERSION,
        migrating: false,
        lastRun: null,
      };
    }
    c.header("Cache-Control", "no-store");
    return c.json(body, body.ok ? 200 : 503);
  }),
);

// Every other internal path: the unknown-route answer, in hosted mode.
platformRoutes.all(
  "*",
  onlyPlatform(async (c) => notFound(c)),
);

/** A run's error, kept short for the platform's run record. */
function shortReason(error: string | undefined): string {
  const reason = error ?? "the run failed";
  return reason.length > 200 ? `${reason.slice(0, 197)}...` : reason;
}

/** The most recent finished scheduler run, or null before the first one. */
async function lastFinishedRun(db: D1Database): Promise<HealthResponse["lastRun"]> {
  try {
    const row = await db
      .prepare(
        `SELECT started_at, ok, duration_ms FROM scheduler_runs
          WHERE finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1`,
      )
      .first<{ started_at: number; ok: number | null; duration_ms: number | null }>();
    if (!row) return null;
    return { at: row.started_at, outcome: row.ok ? "ran" : "failed", durationMs: row.duration_ms ?? 0 };
  } catch (error) {
    // A database that was never migrated has no runs yet.
    if (/no such table/i.test(error instanceof Error ? error.message : String(error))) return null;
    throw error;
  }
}
