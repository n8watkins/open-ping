import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";
import type { MonitorRecord } from "./db/monitors";
import { probe, probeFetchLimit } from "./checks/runner";
import { lookupColo, type RegionProbeRpc, type RegionRecheckResult } from "./checks/region";

/**
 * One region's re-checker (checks/region.ts). The scheduler reaches it by the
 * name `region:<hint>` with that location hint, so it is created in, and stays
 * in, a data center near that region; its outbound requests leave from there.
 *
 * It keeps one thing: the data center it runs in, looked up once (one request)
 * and refreshed weekly in case Cloudflare ever moves it. It never stores a
 * monitor: the record it gets (credentials included, as the scheduler holds
 * them) lives only for the call, and the response body is dropped before it
 * answers, since its assertions were already evaluated here.
 *
 * Its requests are its own: each call it receives gets 50 subrequests on
 * Workers Free, none charged to the scheduler (measured, docs/SECOND_REGION.md).
 * One re-check makes at most its probe's worst case plus the lookup, well
 * inside that (DURABLE_OBJECT_SUBREQUESTS in checks/region.ts).
 */
export class RegionProbe extends DurableObject<Env> implements RegionProbeRpc {
  async recheck(monitor: MonitorRecord, opts: { warmup: boolean }): Promise<RegionRecheckResult> {
    let fetches = 0;
    let colo = await this.ctx.storage.get<string>(COLO_KEY);
    const checkedAt = (await this.ctx.storage.get<number>(COLO_AT_KEY)) ?? 0;
    if (!colo || Date.now() - checkedAt > COLO_REFRESH_MS) {
      fetches++;
      const found = await lookupColo();
      if (found) {
        colo = found;
        await this.ctx.storage.put({ [COLO_KEY]: found, [COLO_AT_KEY]: Date.now() });
      }
    }
    const attempt = await probe(monitor, { warmup: opts.warmup, fresh: true, run: {} });
    fetches += attempt.result.fetches ?? probeFetchLimit(monitor);
    const { body: _body, ...result } = attempt.result as typeof attempt.result & { body?: string };
    return { attempt: { ...attempt, result }, colo: colo ?? null, fetches };
  }
}

const COLO_KEY = "colo";
const COLO_AT_KEY = "colo_at";
const COLO_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
