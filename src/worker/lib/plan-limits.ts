import type { Context, MiddlewareHandler } from "hono";
import {
  checkChannelKindLimit,
  checkIntervalLimit,
  checkMonitorLimit,
  checkStatusPageLimit,
  planLimitBody,
  PLAN_LIMIT_STATUS,
  type PlanLimitBody,
  type TenantInfo,
} from "../../shared/hosted-contract";
import type { ChannelKind } from "../../shared/notifications";
import type { AppEnv, Env } from "../types";
import { hostedProps } from "./hosted";
import { reportUsage } from "../db/usage";
import { intervalSecondsOf, type CreateMonitorInput } from "../../shared/schemas";

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

/** After a successful create, delete or backup import through the REST API, report usage (hosted mode). */
export const reportUsageAfterChange: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  if (c.res.status < 200 || c.res.status >= 300) return;
  const { method, path } = c.req;
  const match = USAGE_PATH.exec(path);
  const changed =
    (method === "POST" && ((match && !match[2]) || path === "/api/data/import")) ||
    (method === "DELETE" && !!match?.[2]);
  if (changed) usageReporter(c)?.();
};
