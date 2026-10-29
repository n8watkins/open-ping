/**
 * Driving provisioning from a Queue (`PROVISION_QUEUE`, platform/wrangler.jsonc).
 *
 * Why a Queue: the first run used to live in the sign-up request's
 * waitUntil, which Cloudflare cuts 30 seconds after the answer, and a run cut
 * there leaves nothing behind but a lease. A queue consumer gets minutes of
 * wall time per batch, a message whose consumer dies is delivered again, and
 * a retry is just a message sent with a delay. A Durable Object alarm per
 * tenant would do the same with a class, a namespace and a migration to
 * maintain; the queue needs one binding. Delivery is at least once, which
 * the lease already makes safe, and the every-minute cron (provisionDue)
 * stays as the net for a message that is lost or runs out of retries.
 * https://developers.cloudflare.com/queues/configuration/javascript-apis/
 */

import { runProvisioning, type ProvisionOutcome, type ProvisioningDeps } from "./provisioning";
import { log } from "./log";

export interface ProvisionMessage {
  tenantId: string;
}

/** Delay for a message that found the tenant held by another run. */
const BUSY_RETRY_SECONDS = 60;
/** Queues allow a delay of at most 12 hours. */
const MAX_DELAY_SECONDS = 12 * 3600;

/** Asks for a run of `tenantId`, now or after `delaySeconds`. */
export async function enqueueProvisioning(queue: Queue<ProvisionMessage>, tenantId: string, delaySeconds = 0): Promise<void> {
  const delay = Math.min(MAX_DELAY_SECONDS, Math.max(0, Math.ceil(delaySeconds)));
  await queue.send({ tenantId }, delay > 0 ? { delaySeconds: delay } : undefined);
}

/**
 * One batch of messages, one tenant after another. A step that failed is
 * rescheduled as a new delayed message at its next attempt; a tenant held by
 * another run is retried in a minute; anything else is done.
 */
export async function handleProvisionBatch(
  deps: ProvisioningDeps,
  batch: MessageBatch<ProvisionMessage>,
  queue: Queue<ProvisionMessage>,
): Promise<ProvisionOutcome[]> {
  const now = deps.now ?? Date.now;
  const outcomes: ProvisionOutcome[] = [];
  for (const message of batch.messages) {
    const tenantId = typeof message.body?.tenantId === "string" ? message.body.tenantId : "";
    let outcome: ProvisionOutcome;
    try {
      // A new tenant has no next attempt set, and a retry's message arrives when it is due, so the schedule is kept.
      outcome = await runProvisioning(deps, tenantId);
    } catch (error) {
      log.error("provision.run_threw", { tenant: tenantId, error });
      message.retry({ delaySeconds: 30 });
      continue;
    }
    outcomes.push(outcome);
    if (outcome.kind === "retry") {
      await enqueueProvisioning(queue, tenantId, (outcome.nextAt - now()) / 1000 + 1);
      message.ack();
    } else if (outcome.kind === "busy") {
      message.retry({ delaySeconds: BUSY_RETRY_SECONDS });
    } else {
      message.ack();
    }
  }
  return outcomes;
}
