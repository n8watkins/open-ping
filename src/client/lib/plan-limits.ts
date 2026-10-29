import {
  checkChannelKindLimit,
  checkMonitorLimit,
  checkStatusPageLimit,
  fastMonitorAllowance,
  PLAN_LIMIT_ERROR,
  PLAN_LIMIT_STATUS,
  STANDARD_CHECK_MINUTES,
  upgradeUrlFor,
  type PlanLimitBody,
  type PlanLimits,
} from "../../shared/hosted-contract";
import { isFastMonitor, keptFastMonitorIds, type FastCandidate } from "../../shared/check-interval";
import type { ChannelKind } from "../../shared/notifications";
import { ApiError } from "./api";
import { useBootstrap, type HostedAccount } from "./bootstrap";

/**
 * Plan limits as the app shows them, in hosted mode only (docs/hosted/
 * CONTRACT.md, section 5). The server enforces them on every create and
 * answers 402 with a PlanLimitBody; the app uses the same pure checks from the
 * contract to say so before a form is even filled in, with the very sentence
 * the server would answer. A self-hosted install has no plan, so all of this
 * is null there.
 */

/** The signed-in customer's plan, or null on a self-hosted install. */
export interface PlanState {
  plan: HostedAccount["plan"];
  limits: PlanLimits;
  upgradeUrl: string;
}

export function usePlan(): PlanState | null {
  const { me } = useBootstrap();
  const hosted = me?.hosted;
  if (!hosted?.limits) return null;
  return { plan: hosted.plan, limits: hosted.limits, upgradeUrl: hosted.upgradeUrl };
}

/**
 * The interval the editor starts a new polled monitor on: every minute on a
 * plan with fast checks (what the add-on is for) while a fast monitor is
 * free, otherwise 12 minutes or the plan's shortest if longer.
 */
export function defaultIntervalMinutes(plan: PlanState, fast?: FastUsage | null): number {
  const min = plan.limits.minIntervalMinutes;
  if (min <= 1 && (!fast || fast.others < fast.allowed)) return 1;
  return Math.max(STANDARD_CHECK_MINUTES, Math.ceil(min));
}

/** The fast monitors (checked more often than every 12 minutes) around the one being edited. */
export interface FastUsage {
  /** How many the plan allows. */
  allowed: number;
  /** Fast monitors other than this one (paused ones count, as the server counts them). */
  others: number;
  /**
   * This monitor is fast and among the ones checked at their own interval
   * (the oldest, when more are fast than allowed). False for a new monitor.
   */
  kept: boolean;
}

/**
 * Fast monitor usage for the editor, from the monitor list, leaving out
 * `editingId` (null for a new monitor). Null on a plan that has no fast
 * checks, where the interval picker locks those choices by itself.
 */
export function fastUsage(
  plan: PlanState | null,
  monitors: readonly (Omit<FastCandidate, "createdAt"> & { createdAt?: number })[],
  editingId: string | null,
): FastUsage | null {
  if (!plan || plan.limits.minIntervalMinutes >= STANDARD_CHECK_MINUTES) return null;
  const allowed = fastMonitorAllowance(plan.limits);
  const others = monitors.filter((m) => m.id !== editingId && isFastMonitor(m)).length;
  const kept =
    editingId !== null &&
    keptFastMonitorIds(
      monitors.map((m) => ({ ...m, createdAt: m.createdAt ?? 0 })),
      allowed,
    ).has(editingId);
  return { allowed, others, kept };
}

/** The 402 body of a refused create, or null for any other error. */
export function planLimitFromError(err: unknown): PlanLimitBody | null {
  if (!(err instanceof ApiError) || err.status !== PLAN_LIMIT_STATUS) return null;
  const data = err.data as Partial<PlanLimitBody> | null;
  if (!data || data.error !== PLAN_LIMIT_ERROR || typeof data.message !== "string") return null;
  return data as PlanLimitBody;
}

function body(plan: PlanState, exceeded: Omit<PlanLimitBody, "error" | "plan" | "upgradeUrl"> | null): PlanLimitBody | null {
  return exceeded
    ? { error: PLAN_LIMIT_ERROR, ...exceeded, plan: plan.plan, upgradeUrl: upgradeUrlFor(plan.upgradeUrl, exceeded.limit) }
    : null;
}

/** What creating one more monitor would answer, when `count` exist. */
export function monitorLimitReached(plan: PlanState | null, count: number): PlanLimitBody | null {
  return plan ? body(plan, checkMonitorLimit(plan.limits, count)) : null;
}

/** What creating one more status page would answer, when `count` exist. */
export function statusPageLimitReached(plan: PlanState | null, count: number): PlanLimitBody | null {
  return plan ? body(plan, checkStatusPageLimit(plan.limits, count)) : null;
}

/** What creating a channel of this kind would answer. */
export function channelKindRefused(plan: PlanState | null, kind: ChannelKind): PlanLimitBody | null {
  return plan ? body(plan, checkChannelKindLimit(plan.limits, kind)) : null;
}

const CHANNEL_NAMES: Record<ChannelKind, string> = {
  push: "Push",
  email: "Email",
  discord: "Discord",
  slack: "Slack",
  teams: "Microsoft Teams",
  telegram: "Telegram",
  webhook: "Webhook",
};

/**
 * How many exist now, when that is more than the plan includes (a downgrade
 * keeps everything): the count after the create, less the one asked for.
 */
function overBy(limit: PlanLimitBody): { count: number; allowed: number } | null {
  if (typeof limit.allowed !== "number" || typeof limit.requested !== "number") return null;
  const count = limit.requested - 1;
  return count > limit.allowed ? { count, allowed: limit.allowed } : null;
}

/** A short heading for a limit, above its one-sentence message. */
export function planLimitTitle(limit: PlanLimitBody): string {
  const over = overBy(limit);
  switch (limit.limit) {
    case "monitors":
      if (over) return `${over.count} of ${over.allowed} monitors, over your plan`;
      return `All ${limit.allowed} monitors in use`;
    case "status_pages":
      if (over) return `${over.count} of ${over.allowed} status pages, over your plan`;
      return limit.allowed === 1 ? "Your status page is in use" : `All ${limit.allowed} status pages in use`;
    case "channel_kind": {
      const kind = String(limit.requested) as ChannelKind;
      return `${CHANNEL_NAMES[kind] ?? kind} alerts aren't in your plan`;
    }
    case "interval":
      return "Faster checks aren't in your plan";
    case "fast_monitors":
      return limit.allowed === 0 ? "Fast checks aren't in your plan" : `All ${limit.allowed} fast monitors in use`;
  }
}

/**
 * The sentence under the heading: the server's, except over the plan, where
 * "remove one" would not be enough to add one.
 */
export function planLimitMessage(limit: PlanLimitBody): string {
  const over = overBy(limit);
  if (!over || (limit.limit !== "monitors" && limit.limit !== "status_pages")) return limit.message;
  const what = limit.limit === "monitors" ? ["monitor", "monitors"] : ["status page", "status pages"];
  const extra = over.count - over.allowed + 1;
  return `Your plan includes ${over.allowed} ${over.allowed === 1 ? what[0] : what[1]}. The ones you have keep working; remove ${extra} or upgrade to add more.`;
}

/** "3 of 5 monitors", for a count next to a list. */
export function usageLabel(count: number, allowed: number, one: string, many: string): string {
  return `${count} of ${allowed} ${allowed === 1 ? one : many}`;
}
