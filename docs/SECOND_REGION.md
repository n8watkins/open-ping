# Second-region confirmation

A failed check is confirmed from another Cloudflare location before it opens an incident, so one data center's network trouble doesn't page anyone.
This builds on [Confirm before alerting](./MONITOR_TYPES.md#confirm-before-alerting): the re-check 5 seconds later now runs somewhere else.

## How it works

- Each region is one Durable Object (`RegionProbe`, `src/worker/region-probe.ts`), reached by the name `region:<hint>` with that [location hint](https://developers.cloudflare.com/durable-objects/reference/data-location/).
- Cloudflare creates a Durable Object near its hint the first time it is asked for, and it stays in that data center.
- Its outbound requests leave from there, so its re-check sees the target the way that part of the world does.
- When a check fails, the scheduler asks Cloudflare's trace endpoint which data center the run is in (once per run, only when something needs confirming).
- It then picks the first region in `CONFIRM_REGIONS` whose Durable Object it knows to be somewhere else, and asks that object to re-check (`src/worker/checks/region.ts`).
- If the re-check fails too, the incident opens and records the data center that confirmed it; the incident shows "Confirmed from Frankfurt by a second check before alerting".
- If it passes, there is no incident, and the sample is a blip with `"confirmedFrom": "FRA"` in its meta.
- A region whose Durable Object turns out to share the run's data center still re-checks, but isn't recorded as elsewhere; the next run in that place picks another region.
- HTTP, DNS and TCP monitors are confirmed this way; domain monitors are not, since RDAP answers the same everywhere.

## Settings

- `CONFIRM_REGIONS` (a wrangler.jsonc var) lists the location hints to use, in order of preference; the template sets `weur,enam,apac`.
- `off`, an empty value, or no `REGION_PROBE` binding re-checks where the check ran, exactly as before.
- Each monitor's "Confirm failures" setting still decides whether a failure is re-checked at all.

## Falling back

- When the Durable Object can't be reached, throws, or doesn't answer within the probe's timeout plus 15 seconds, the re-check runs where the check ran, if the run still has room for it.
- When the run has no room left for that, the failure waits for the next run, the same as any re-check the budget can't afford.
- An install deployed without the Durable Object (an older template, or a Hosted bundle without the binding) behaves exactly as before.

## What it costs

- On Workers Free, SQLite-backed Durable Objects are included: 100,000 requests a day, 13,000 GB-s of duration a day, 5 GB of storage.
- A confirmation is one Durable Object request; an install whose checks all pass makes none.
- Each object stores only its data center, so storage stays at a few bytes.
- In the run's subrequest budget (`src/worker/lib/budget.ts`), a check that may confirm holds its probe's worst case plus 3 while it runs: the hop to the Durable Object, the run's one data-center lookup, and the object's own lookup when it refreshes (weekly).
- It is charged what it really made when it ends, so a passing check still costs only its own probe.
- Until measured, the Durable Object's own requests are charged to the run as well (`REMOTE_FETCHES_CHARGED` in `src/worker/checks/region.ts`), so a confirmed HTTP failure without redirects costs 3 to 5 of the run's 45 requests instead of 2 (the lookups are paid once per run and once a week).
- If the measurement below shows that a Durable Object's requests count only against its own invocation, that constant becomes false and a confirmation costs the run 1 or 2 requests.
- No D1 queries are added: the data center goes into the incident row and the sample meta the run already writes.

## What Cloudflare documents (checked 2026-10-28)

- Durable Objects are on Workers Free, SQLite-backed ones only ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
- A location hint is best effort, honored only on the first `get()` of an object, and objects don't move once created ([data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)).
- `sam`, `afr` and `me` don't host Durable Objects; those hints land in a nearby region instead.
- Workers Free allows 50 external subrequests and 1,000 subrequests to Cloudflare services per invocation ([limits](https://developers.cloudflare.com/workers/platform/limits/)).
- The docs don't say whether a Durable Object call counts as an external or an internal subrequest, nor whether the object's own fetches count against its caller.
- A Durable Object gets a fresh 30 seconds of CPU time for each incoming request ([Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)).
- In Workers for Platforms, user Workers can bind Durable Objects, and `request.cf` isn't available to them unless the namespace is trusted, which is why OpenPing asks the trace endpoint instead.

## What to measure before merging

The throwaway Worker in `scripts/region-probe/` measures what the docs leave open.
Deploy it to a Workers Free account with `npx wrangler deploy -c scripts/region-probe/wrangler.jsonc`, read the results, then delete it with `npx wrangler delete -c scripts/region-probe/wrangler.jsonc`.
Its cron run (every 10 minutes) logs the same results as `GET /all`; read them with `npx wrangler tail -c scripts/region-probe/wrangler.jsonc`.

1. Where each hint lands: `GET /hints` lists every hint's data center, and the scheduler-side data center, for the template's `weur`, `enam` and `apac` and the rest.
2. Latency: the same response has each object's first call (creation plus its trace lookup) and a warm call, in milliseconds.
3. Whether Durable Object calls count against the 50 external subrequests: `GET /do-calls?n=60` makes 60 calls in one invocation and reports how many worked.
4. Whether a Durable Object's own fetches count against its caller: `GET /do-fetches?n=60` makes one call whose object makes 60 fetches.
5. The scheduled path: compare the cron run's logged results with the HTTP ones, since OpenPing's confirmations run from the cron trigger.
6. That the trace endpoint reports the data center the code runs in: `requestCfColo` and `workerColo` in `GET /hints` should match.

## Results

To be filled in after the measurement, one line per finding:

- Where `weur`, `enam` and `apac` landed:
- First and warm call latency per region:
- 60 Durable Object calls in one invocation:
- One call whose object made 60 fetches:
- Cron run versus HTTP:
- `request.cf.colo` versus the trace endpoint:
- Decision on `REMOTE_FETCHES_CHARGED` and the default `CONFIRM_REGIONS`:
