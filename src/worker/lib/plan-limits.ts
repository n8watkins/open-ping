import type { Context, MiddlewareHandler } from "hono";
import {
  checkChannelKindLimit,
  checkFastMonitorLimit,
  checkIntervalLimit,
  checkMonitorLimit,
  checkStatusPageLimit,
  fastMonitorAllowance,
  isFastInterval,
  planLimitBody,
  PLAN_LIMIT_STATUS,
  type PlanLimitBody,
  type TenantInfo,
} from "../../shared/hosted-contract";
import type { ChannelKind } from "../../shared/notifications";
import type { AppEnv, Env } from "../types";
import { hostedProps } from "./hosted";
import { reportUsage } from "../db/usage";
import {
  checkIntervalSecondsSchema,
  intervalSecondsOf,
  POLLED_INTERVAL_SECONDS,
  type CreateMonitorInput,
} from "../../shared/schemas";
import { defaultIntervalSeconds, planMinimumSeconds } from "../../shared/check-interval";
import type { MonitorRecord } from "../db/monitors";

/**
 * Plan limits, in hosted mode only (docs/hosted/CONTRACT.md, section 5).
 *
 * The limits come from this call's props (`props.tenant.limits`), never from a
 * copy of their own, so the platform can change a tenant's plan without a
 * release. Every create path asks here first: the REST API (the dashboard and
 * the CLI use it), MCP and a backup import. On a plain install there is no
 * plan, nothing here runs, and nothing costs a query.
 *
 * A downgrade never deletes anything: what exists over the limit keeps
 * running, and only a new one is refused.
 */

/** What a check needs to know about the tenant. */
export type HostedPlan = Pick<TenantInfo, "plan" | "limits" | "urls">;

/** This request's plan in hosted mode; undefined on a plain install. */
export function hostedPlan(c: Context<AppEnv>): HostedPlan | undefined {
  return hostedProps(c)?.tenant;
}

/** A refused create: HTTP 402 with this body. */
export interface PlanLimitRefusal {
  ok: false;
  status: typeof PLAN_LIMIT_STATUS;
  error: "plan_limit";
  body: PlanLimitBody;
}

function refusal(plan: HostedPlan, exceeded: Parameters<typeof planLimitBody>[0] | null): PlanLimitRefusal | null {
  if (!exceeded) return null;
  return { ok: false, status: PLAN_LIMIT_STATUS, error: "plan_limit", body: planLimitBody(exceeded, plan) };
}

// Count, then insert: two creates at the same instant can both take the last
// free place. Accepted (reviewed 2026-10-28): the next create is refused.
async function count(env: Env, table: "monitors" | "status_pages"): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

/** May `adding` more monitors be created? Paused ones count. */
export async function monitorLimit(
  env: Env,
  plan: HostedPlan | undefined,
  adding = 1,
): Promise<PlanLimitRefusal | null> {
  if (!plan || adding <= 0) return null;
  return refusal(plan, checkMonitorLimit(plan.limits, (await count(env, "monitors")) + adding - 1));
}

/** May one more status page be created? The default page counts. */
export async function statusPageLimit(env: Env, plan: HostedPlan | undefined): Promise<PlanLimitRefusal | null> {
  if (!plan) return null;
  return refusal(plan, checkStatusPageLimit(plan.limits, await count(env, "status_pages")));
}

/** May a channel of this kind be created? */
export function channelKindLimit(plan: HostedPlan | undefined, kind: ChannelKind): PlanLimitRefusal | null {
  if (!plan) return null;
  return refusal(plan, checkChannelKindLimit(plan.limits, kind));
}

/**
 * Is a monitor's check interval within the plan? Polled monitors (http, dns,
 * tcp, domain) are checked every `intervalSeconds`; a heartbeat's interval is
 * how often its job pings, not a check, so it never counts.
 */
export function intervalLimit(plan: HostedPlan | undefined, monitor: CreateMonitorInput): PlanLimitRefusal | null {
  if (!plan || monitor.type === "heartbeat") return null;
  return refusal(plan, checkIntervalLimit(plan.limits, intervalSecondsOf(monitor) / 60));
}

/** Polled monitors set faster than every 12 minutes (paused ones count), leaving out `except`. */
async function countFast(env: Env, except: string | null): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM monitors WHERE type <> 'heartbeat' AND interval_seconds < ?1 AND id <> COALESCE(?2, '')",
  )
    .bind(POLLED_INTERVAL_SECONDS, except)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * May this monitor be a fast one (checked more often than every 12 minutes)?
 * Only a create or an edit that sets a fast interval is held to it: an edit
 * that keeps the stored interval passes, so a fast monitor kept from a bigger
 * plan can still be renamed. An edit leaves the monitor itself out of the
 * count. Run it after intervalLimit, which answers first for an interval the
 * plan doesn't offer at all.
 */
export async function fastMonitorLimit(
  env: Env,
  plan: HostedPlan | undefined,
  monitor: CreateMonitorInput,
  existing?: Pick<MonitorRecord, "id" | "type" | "intervalSeconds"> | null,
): Promise<PlanLimitRefusal | null> {
  if (!plan || monitor.type === "heartbeat") return null;
  const seconds = intervalSecondsOf(monitor);
  if (!isFastInterval(seconds)) return null;
  if (existing && existing.type !== "heartbeat" && existing.intervalSeconds === seconds) return null;
  return refusal(plan, checkFastMonitorLimit(plan.limits, await countFast(env, existing?.id ?? null)));
}

/**
 * A backup import's fast monitors, in the backup's order, within what the
 * plan allows next to the fast monitors already here; any past that are
 * restored at 12 minutes instead of refusing the restore (the editor can make
 * them fast again once the plan allows more). Run on what importedCheckInterval
 * resolved. A plain install has no plan and stores 12 minutes anyway.
 */
export async function importedFastIntervals(
  env: Env,
  plan: HostedPlan | undefined,
  inputs: readonly CreateMonitorInput[],
): Promise<CreateMonitorInput[]> {
  if (!plan || !inputs.some((m) => m.type !== "heartbeat" && isFastInterval(intervalSecondsOf(m)))) return [...inputs];
  let free = fastMonitorAllowance(plan.limits) - (await countFast(env, null));
  return inputs.map((m) => {
    if (m.type === "heartbeat" || !isFastInterval(intervalSecondsOf(m))) return m;
    if (free > 0) {
      free--;
      return m;
    }
    return { ...m, intervalSeconds: POLLED_INTERVAL_SECONDS };
  });
}

/**
 * The check interval a create or an edit of a polled monitor stores. On a plain
 * install it is always the cron's 12 minutes, whatever was sent (a backup or a
 * client from OpenPing Hosted may carry another). In hosted mode it is what was
 * sent; on an edit that sent none, the stored one; on a create that sent none,
 * 12 minutes or the plan's shortest if longer. `intervalLimit` then holds it to
 * the plan. Heartbeats are returned as they are.
 */
export function withCheckInterval(
  input: CreateMonitorInput,
  plan: HostedPlan | undefined,
  existing?: Pick<MonitorRecord, "type" | "intervalSeconds"> | null,
): CreateMonitorInput {
  if (input.type === "heartbeat") return input;
  if (!plan) return { ...input, intervalSeconds: POLLED_INTERVAL_SECONDS };
  const kept = existing && existing.type !== "heartbeat" ? existing.intervalSeconds : undefined;
  return {
    ...input,
    intervalSeconds: input.intervalSeconds ?? kept ?? defaultIntervalSeconds(plan.limits.minIntervalMinutes),
  };
}

/**
 * A monitor body with `intervalSeconds` left out when there is no plan: a
 * plain install never uses it, so like any other field it doesn't know, it is
 * ignored rather than refused (an API client or a backup from OpenPing Hosted
 * may send one). Anything that isn't an object is returned as it is.
 */
export function ignoreIntervalWithoutPlan(body: unknown, plan: HostedPlan | undefined): unknown {
  if (plan || !body || typeof body !== "object" || Array.isArray(body) || !("intervalSeconds" in body)) return body;
  const { intervalSeconds: _ignored, ...rest } = body as Record<string, unknown>;
  return rest;
}

/**
 * A backed-up monitor with an interval no install accepts left out, so it
 * restores at the default instead of failing the import (backups are meant to
 * restore, and a hand edit or a newer build may carry one).
 */
export function tolerantBackupInterval(monitor: unknown): unknown {
  if (!monitor || typeof monitor !== "object" || Array.isArray(monitor) || !("intervalSeconds" in monitor)) return monitor;
  const { intervalSeconds, ...rest } = monitor as Record<string, unknown>;
  return checkIntervalSecondsSchema.safeParse(intervalSeconds).success ? monitor : rest;
}

/**
 * A backup import's interval: as withCheckInterval, but one shorter than the
 * plan allows is restored at the plan's shortest instead of refusing the whole
 * restore (a backup of a 1-minute monitor restores on a 12-minute plan).
 */
export function importedCheckInterval(input: CreateMonitorInput, plan: HostedPlan | undefined): CreateMonitorInput {
  const resolved = withCheckInterval(input, plan);
  if (!plan || resolved.type === "heartbeat") return resolved;
  return {
    ...resolved,
    intervalSeconds: Math.max(resolved.intervalSeconds ?? 0, planMinimumSeconds(plan.limits.minIntervalMinutes)),
  };
}

/**
 * Hosted mode: a function that reports the tenant's counts through the
 * platform capability (contract, section 4) after the response, within this
 * call. Undefined on a plain install.
 */
export function usageReporter(c: Context<AppEnv>): (() => void) | undefined {
  const props = hostedProps(c);
  if (!props) return undefined;
  return () => {
    const done = reportUsage(c.env.DB, props.platform);
    try {
      c.executionCtx.waitUntil(done);
    } catch {
      // No execution context (some test harnesses): the report still runs.
    }
  };
}

/** Collection paths (create) and item paths (delete) whose change the platform counts. */
const USAGE_PATH = /^\/api\/(monitors|status-pages|channels)(\/[^/]+)?$/;

/**
 * After a successful create, delete or backup import through the REST API,
 * and an edit of a monitor (its interval may make it fast or not), report
 * usage (hosted mode).
 */
export const reportUsageAfterChange: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  if (c.res.status < 200 || c.res.status >= 300) return;
  const { method, path } = c.req;
  const match = USAGE_PATH.exec(path);
  const changed =
    (method === "POST" && ((match && !match[2]) || path === "/api/data/import")) ||
    (method === "DELETE" && !!match?.[2]) ||
    ((method === "PUT" || method === "PATCH") && match?.[1] === "monitors" && !!match[2]);
  if (changed) usageReporter(c)?.();
};
