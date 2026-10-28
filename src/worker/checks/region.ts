import type { Env } from "../types";
import type { MonitorRecord } from "../db/monitors";
import { probeFetchLimit, type ProbeAttempt, type RemoteRecheck } from "./runner";

/**
 * Second-region confirmation (docs/SECOND_REGION.md): a failed check's
 * confirmation re-check runs from another Cloudflare location, so one data
 * center's network trouble doesn't open an incident on its own.
 *
 * Each region is one Durable Object (worker/region-probe.ts) created with a
 * location hint, so it lives in a data center near that region and stays
 * there. The scheduler asks one whose data center differs from the one it is
 * running in, and the incident records where the re-check ran ("Confirmed
 * from Frankfurt"). Whenever that can't happen (no binding, the setting is
 * off, the Durable Object fails or times out) the re-check runs where the
 * first check did, exactly as before.
 *
 * Cost, per confirmation (lib/budget.ts reserves it before the check starts):
 * one request for the hop to the Durable Object, plus, once per run, one to
 * learn which data center the run is in (the Cloudflare trace endpoint), plus
 * what the probe itself makes. Whether Cloudflare counts the probe's requests
 * against the scheduler's invocation, or only against the Durable Object's
 * own, is not documented; until it's measured (scripts/region-probe/) this
 * module charges them to the run, which is the safe assumption.
 */

/** Location hints Cloudflare accepts (developers.cloudflare.com/durable-objects/reference/data-location/). */
export const LOCATION_HINTS = [
  "wnam",
  "enam",
  "sam",
  "weur",
  "eeur",
  "apac",
  "apac-ne",
  "apac-se",
  "oc",
  "afr",
  "me",
] as const;
export type LocationHint = (typeof LOCATION_HINTS)[number];

/**
 * Requests a remote re-check may cost on top of the probe itself: the hop to
 * the Durable Object, the run's one data-center lookup, and the Durable
 * Object's own lookup when it refreshes where it lives.
 */
export const REMOTE_RECHECK_OVERHEAD = 3;

/**
 * Charge the Durable Object's own requests (its probe and its data-center
 * lookup) to the scheduler's run. True is the safe assumption while it's
 * unmeasured: a Durable Object is its own invocation with its own limits, so
 * once scripts/region-probe/ shows the run isn't charged for them, this can
 * become false and a remote confirmation costs the run one request.
 */
export const REMOTE_FETCHES_CHARGED = true;

/** Where Cloudflare says a request is served from: `colo=FRA` in its plain-text trace. */
export const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";

/** How long the data-center lookup may take before the run goes on without it. */
const TRACE_TIMEOUT_MS = 5_000;

/** Monitor types whose re-check means something from elsewhere (not domain: RDAP answers the same everywhere). */
export function supportsRemoteRecheck(type: MonitorRecord["type"]): boolean {
  return type === "http" || type === "dns" || type === "tcp";
}

/**
 * The regions this install confirms from: `CONFIRM_REGIONS`, a comma-separated
 * list of location hints in order of preference (wrangler.jsonc vars). Empty,
 * "off", or no REGION_PROBE binding means confirm where the check ran.
 */
export function confirmRegions(env: Pick<Env, "CONFIRM_REGIONS" | "REGION_PROBE">): LocationHint[] {
  if (!env.REGION_PROBE) return [];
  const raw = (env.CONFIRM_REGIONS ?? "").trim().toLowerCase();
  if (!raw || raw === "off") return [];
  const valid = new Set<string>(LOCATION_HINTS);
  const out: LocationHint[] = [];
  for (const part of raw.split(",")) {
    const hint = part.trim();
    if (valid.has(hint) && !out.includes(hint as LocationHint)) out.push(hint as LocationHint);
  }
  return out;
}

/** The data center code (IATA, such as "FRA") in a Cloudflare trace response, or null. */
export function parseTraceColo(text: string): string | null {
  const m = /^colo=([A-Z]{3})\s*$/m.exec(text);
  return m ? m[1]! : null;
}

/** Asks Cloudflare which data center this code runs in: one request, null on any failure. */
export async function lookupColo(fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetcher(TRACE_URL, { signal: AbortSignal.timeout(TRACE_TIMEOUT_MS) });
    if (!res.ok) return null;
    return parseTraceColo(await res.text());
  } catch {
    return null;
  }
}

/**
 * Where each region's Durable Object answered from last, kept for the life of
 * this isolate (a Durable Object doesn't move once created), so a run can pick
 * a region that isn't where it is running without asking first. Losing it only
 * means a run may ask a region in its own data center; that re-check still
 * counts, it just isn't recorded as from elsewhere.
 */
const knownColos = new Map<LocationHint, string>();

/** Tests only. */
export function resetKnownColos(): void {
  knownColos.clear();
}

/**
 * The region to ask: the first whose data center is known and differs from
 * this one, else the first not yet seen, else the first.
 */
export function pickRegion(regions: LocationHint[], here: string | null): LocationHint {
  return (
    regions.find((r) => knownColos.has(r) && knownColos.get(r) !== here) ??
    regions.find((r) => !knownColos.has(r)) ??
    regions[0]!
  );
}

/** What the Durable Object returns for one re-check (worker/region-probe.ts). */
export interface RegionRecheckResult {
  attempt: ProbeAttempt;
  /** Its data center, when its lookup worked. */
  colo: string | null;
  /** Requests it made: the probe's, plus its data-center lookup when it refreshed that. */
  fetches: number;
}

/** The Durable Object's RPC surface, as the scheduler sees it. */
export interface RegionProbeRpc {
  recheck(monitor: MonitorRecord, opts: { warmup: boolean }): Promise<RegionRecheckResult>;
}

/** The most a remote re-check may take: the probe's own timeout plus the hop. */
function remoteTimeoutMs(monitor: MonitorRecord, warmup: boolean): number {
  const config = monitor.config as { timeoutMs?: number; warmupTimeoutMs?: number };
  const probe = (warmup ? config.warmupTimeoutMs : undefined) ?? config.timeoutMs ?? 60_000;
  return probe + 15_000;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export interface RegionalOptions {
  /** Tests only: what looks up this run's data center (default: the trace endpoint). */
  lookupHere?: () => Promise<string | null>;
  /** Tests only: a shorter timeout for the hop. */
  timeoutMs?: number;
}

/**
 * One run's remote re-check (RunOptions.remoteRecheck), or null when this
 * install doesn't confirm from another region. Make one per run: it looks up
 * the run's data center once, on the first re-check, and charges that
 * request to it.
 */
export function regionalRechecker(
  env: Pick<Env, "CONFIRM_REGIONS" | "REGION_PROBE">,
  opts: RegionalOptions = {},
): ((monitor: MonitorRecord, o: { warmup: boolean }) => Promise<RemoteRecheck>) | null {
  const regions = confirmRegions(env);
  const ns = env.REGION_PROBE;
  if (!ns || regions.length === 0) return null;
  let here: Promise<string | null> | null = null;

  return async (monitor, o) => {
    // The first re-check of the run pays for the lookup; the rest share it.
    let lookupCost = 0;
    if (!here) {
      here = (opts.lookupHere ?? (() => lookupColo()))();
      lookupCost = 1;
    }
    const hereColo = await here;
    const region = pickRegion(regions, hereColo);
    const started = Date.now();
    try {
      const stub = ns.get(ns.idFromName(`region:${region}`), { locationHint: region }) as unknown as RegionProbeRpc;
      const res = await withTimeout(
        stub.recheck(monitor, o),
        opts.timeoutMs ?? remoteTimeoutMs(monitor, o.warmup),
      );
      if (res.colo) knownColos.set(region, res.colo);
      // Recorded as from elsewhere only when it was: a region whose data
      // center turned out to be this one still re-checked, just not elsewhere.
      const elsewhere = res.colo && res.colo !== hereColo ? res.colo : undefined;
      console.log(
        `[region] ${monitor.id} re-checked from ${region} (${res.colo ?? "?"}), run in ${hereColo ?? "?"}: ${
          res.attempt.ok ? "passed" : "failed"
        } in ${Date.now() - started} ms`,
      );
      return {
        attempt: res.attempt,
        ...(elsewhere ? { colo: elsewhere } : {}),
        fetches: lookupCost + 1 + (REMOTE_FETCHES_CHARGED ? res.fetches : 0),
      };
    } catch (e) {
      console.error(`[region] ${monitor.id} re-check from ${region} failed; re-checking here`, e);
      // Charged its worst case: the Durable Object may have made its requests
      // before the hop failed.
      return {
        attempt: null,
        fetches: lookupCost + 1 + (REMOTE_FETCHES_CHARGED ? probeFetchLimit(monitor) + 1 : 0),
      };
    }
  };
}
