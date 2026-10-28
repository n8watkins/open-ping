# Second-region confirmation

A failed check is confirmed from another Cloudflare location before it opens an incident, so one data center's network trouble doesn't page anyone.
This builds on [Confirm before alerting](./MONITOR_TYPES.md#confirm-before-alerting): the re-check 5 seconds later now runs somewhere else.

## How it works

- Each region is one Durable Object (`RegionProbe`, `src/worker/region-probe.ts`), reached by the name `region:<hint>` with that [location hint](https://developers.cloudflare.com/durable-objects/reference/data-location/).
- Cloudflare creates a Durable Object near its hint the first time it is asked for, and it stays in that data center.
- Its outbound requests leave from there, so its re-check sees the target the way that part of the world does.
- When a check fails, the scheduler asks Cloudflare's trace endpoint which data center the run is in (once per run, only when something needs confirming).
- It then picks the first region in `CONFIRM_REGIONS` whose Durable Object it knows to be somewhere else, and asks that object to re-check (`src/worker/checks/region.ts`).
- If the re-check fails too, the incident opens and records the data center that confirmed it; the incident shows "Confirmed from Atlanta by a second check before alerting".
- If it passes, there is no incident, and the sample is a blip with `"confirmedFrom": "ATL"` in its meta.
- A region whose Durable Object turns out to share the run's data center still re-checks, but isn't recorded as elsewhere; the next run in that place picks another region.
- HTTP, DNS and TCP monitors are confirmed this way; domain monitors are not, since RDAP answers the same everywhere.

## Settings

- `CONFIRM_REGIONS` (a wrangler.jsonc var) lists the location hints to use, in order of preference; the template sets `enam,weur`.
- Measured on 2026-10-28, `enam` landed in Atlanta (or Chicago) and `weur` in Lisbon, both away from the US-west data centers the cron ran in, with `weur` as the fallback for a run that lands in eastern North America.
- `off`, an empty value, or no `REGION_PROBE` binding re-checks where the check ran, exactly as before.
- Each monitor's "Confirm failures" setting still decides whether a failure is re-checked at all.

## Falling back

- When the Durable Object can't be reached, throws, or doesn't answer within the probe's timeout plus 15 seconds, the re-check runs where the check ran.
- The run's hold always covers that local re-check, so a failed hop never leaves a failure unconfirmed.
- When the run can't afford a re-check at all, the failure waits for the next run, as before.
- An install deployed without the Durable Object (an older template, or a Hosted bundle without the binding) behaves exactly as before.

## What it costs

- On Workers Free, SQLite-backed Durable Objects are included: 100,000 requests a day, 13,000 GB-s of duration a day, 5 GB of storage.
- A confirmation is one Durable Object request; an install whose checks all pass makes none.
- Each object stores only its data center, so storage stays at a few bytes.
- A confirmation costs the run 1 request for the hop to the Durable Object, plus 1 per run for the data-center lookup.
- The Durable Object's own requests (the probe and its weekly data-center lookup) are its own: it gets 50 subrequests for each call, and its caller is charged none of them (measured, below).
- One re-check makes at most its probe's worst case (6 for an HTTP check that follows every redirect) plus 1, well inside those 50 (`DURABLE_OBJECT_SUBREQUESTS`, checked in `src/worker/checks/region.test.ts`).
- In the run's subrequest budget (`src/worker/lib/budget.ts`), a check that may confirm holds a local re-check's worst case plus 2 while it runs (`REMOTE_RECHECK_OVERHEAD`), so a failed hop can still re-check here.
- It is charged what it really made when it ends, so a passing check still costs only its own probe, and a confirmed failure costs 2 or 3 of the run's 45 requests, about what a local re-check costs today.
- No D1 queries are added: the data center goes into the incident row and the sample meta the run already writes.

## What Cloudflare documents (checked 2026-10-28)

- Durable Objects are on Workers Free, SQLite-backed ones only ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
- A location hint is best effort, honored only on the first `get()` of an object, and objects don't move once created ([data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)).
- `sam`, `afr` and `me` don't host Durable Objects; those hints land in a nearby region instead.
- Workers Free allows 50 external subrequests and 1,000 subrequests to Cloudflare services per invocation ([limits](https://developers.cloudflare.com/workers/platform/limits/)).
- The docs don't say whether a Durable Object call counts as an external or an internal subrequest, nor whether the object's own fetches count against its caller; the measurement below answers both.
- A Durable Object gets a fresh 30 seconds of CPU time for each incoming request ([Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)).
- In Workers for Platforms, user Workers can bind Durable Objects, and `request.cf` isn't available to them unless the namespace is trusted, which is why OpenPing asks the trace endpoint instead.

## How it was measured

The throwaway Worker in `scripts/region-probe/` measures what the docs leave open; run it again if Cloudflare's placement or limits change.
Deploy it to a Workers Free account with `npx wrangler deploy -c scripts/region-probe/wrangler.jsonc`, read the results, then delete it with `npx wrangler delete -c scripts/region-probe/wrangler.jsonc`.
Its cron run (every 10 minutes) logs the same results as `GET /all`; read them with `npx wrangler tail -c scripts/region-probe/wrangler.jsonc`.

1. Where each hint lands: `GET /hints` lists every hint's data center, and the scheduler-side data center, for every hint.
2. Latency: the same response has each object's first call (creation plus its trace lookup) and a warm call, in milliseconds.
3. Whether Durable Object calls count against the 50 external subrequests: `GET /do-calls?n=60` makes 60 calls in one invocation and reports how many worked.
4. Whether a Durable Object's own fetches count against its caller: `GET /do-fetches?n=60` makes one call whose object makes 60 fetches.
5. The scheduled path: compare the cron run's logged results with the HTTP ones, since OpenPing's confirmations run from the cron trigger.
6. That the trace endpoint reports the data center the code runs in: `requestCfColo` and `workerColo` in `GET /hints` should match.

## Results

Measured on 2026-10-28 on Workers Free, from an HTTP request served in Los Angeles (LAX) and from the cron trigger, which ran in San Jose (SJC); both gave the same results.

- The hints landed in: `wnam` San Jose (SJC), `enam` Atlanta (ATL), `sam` Miami (MIA), `weur` Lisbon (LIS), `eeur` Frankfurt (FRA), `apac` Singapore (SIN), `apac-ne` Osaka (KIX), `apac-se` Singapore (SIN), `oc` Melbourne (MEL), `afr` Paris (CDG) and `me` Milan (MXP).
- A second object hinted `enam` landed in Chicago (ORD), so a hint picks a region, not one fixed data center.
- First and warm call latency from LAX, in milliseconds: `wnam` 395 and 18, `enam` 312 and 51, `weur` 623 and 166, `eeur` 568 and 152, `apac` 640 and 171.
- From the cron run in SJC: `wnam` 186 and 29, `enam` 215 and 60, `weur` 510 and 159, `apac` 636 and 181.
- A later first call to an object that already existed was warm, between 43 and 328 ms.
- 60 Durable Object calls in one invocation all worked, from HTTP and from cron, so they don't count against the caller's 50 external subrequests.
- One call whose object made 60 fetches stopped at exactly 50 with "Too many subrequests by single Worker invocation", while the caller, which made no fetches itself, was not charged.
- So a Durable Object has its own 50 subrequests per incoming call, and its fetches are not charged to the run.
- `request.cf.colo` matched the trace endpoint (LAX for both); a cron run has no `request.cf`, and the trace endpoint reported SJC.
- Decisions: the run is no longer charged for the Durable Object's requests, the hold dropped from 3 to 2 on top of a local re-check, and the template's `CONFIRM_REGIONS` is `enam,weur` (Atlanta is close to and different from the US-west cron, Lisbon is the fallback).
