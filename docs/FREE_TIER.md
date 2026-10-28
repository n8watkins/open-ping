# Staying within Cloudflare's free tier

OpenPing is designed to run comfortably on Cloudflare's **free plan** for a
small install. This page explains where the usage comes from so you can reason
about your own setup.

## Where usage comes from

OpenPing's footprint has three parts:

1. **Scheduled Worker invocations.** One Cron Trigger fires every 12 minutes
   (`*/12 * * * *`). That's `60 / 12 = 5` runs per hour, or **120 scheduled runs
   per day**, regardless of how many monitors you have.
2. **Outbound checks.** Each scheduled run checks the monitors that are due. For
   **3 HTTP monitors** at the 12-minute cadence that's ~3 checks per run, i.e.
   roughly **360 outbound checks per day** (≈ `120 runs × 3`). More monitors, or
   shorter intervals, scale this up proportionally - but schedule-aware monitors
   are only checked during their operating hours, which reduces it.

   The newer check types behave the same way, just with a different transport:
   **DNS** and **domain-expiry** checks are ordinary outbound `fetch`
   subrequests (to Cloudflare's DNS-over-HTTPS resolver and to RDAP,
   respectively), and **TCP** checks open a `connect()` socket instead of a
   `fetch`. Each still counts as roughly one check, and each run checks only as
   many monitors as fit its plan's per-run budget (about 8 on Free, up to 200 on
   Paid; see below), most overdue first, with the rest deferred to the next tick.
3. **D1 reads/writes.** Each run does light database work: reading which monitors
   are due and their state, then writing samples, state updates, interval/summary
   rollups, and any queued notifications. This is small and roughly proportional
   to the number of checks per run.

There's also occasional traffic from you loading the dashboard and from visitors
viewing the public status page, plus notification deliveries (email/push/Slack/Teams/
Discord/Telegram/webhook) when incidents happen - all typically minor for a small install.

## How this maps to the free tier

Cloudflare's free plan has limits on, broadly:

- **Workers requests per day** (your scheduled runs + dashboard/status-page hits),
- **D1 rows read and rows written per day**,
- **D1 storage**.

**Those numbers are set by Cloudflare, live on Cloudflare's side, and change over
time** - so this doc deliberately does **not** hard-code them. Check the current
limits on Cloudflare's pricing pages:

- Workers pricing & limits: <https://developers.cloudflare.com/workers/platform/pricing/>
- Workers Free plan limits: <https://developers.cloudflare.com/workers/platform/limits/>
- D1 pricing & limits: <https://developers.cloudflare.com/d1/platform/pricing/>

### The per-run limits (the ones that decide how many monitors fit)

The daily limits are rarely the problem. The tighter limits are **per invocation**:
every cron run is one Worker invocation, and on the Free plan it may make only
(checked 2026-10-27):

| Limit | Workers Free | Workers Paid |
| --- | --- | --- |
| Outbound fetches (subrequests) per invocation | 50 | 10,000 |
| D1 queries per invocation (a `batch()` counts as one) | 50 | 1,000 |
| CPU time per Cron Trigger | 10 ms | 30 s |
| Requests per day | 100,000 | No limit |
| D1 rows read / written per day | 5 million / 100,000 | Billed |

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

A run that goes past the per-invocation limits fails with "Too many API requests
by single Worker invocation", so OpenPing budgets each run
(`src/worker/lib/budget.ts`): it counts its D1 queries as it goes, counts every
fetch a check makes (Cloudflare counts each redirect hop as its own
subrequest, so an HTTP check that follows redirects holds room for up to six
while it runs and is then charged what it really made), the same again for a
failed check's confirmation re-check, and one per alert, keeps room for the
work every run ends with (rollups, cleanup, the run record), and leaves any
monitor that doesn't fit due for the next tick, most overdue first. Nothing is
dropped; it just waits 12 minutes.

### Confirm before alerting and the budget

A failed check on a monitor that was up is checked once more about 5 seconds later before it can open an incident ([MONITOR_TYPES.md](./MONITOR_TYPES.md#confirm-before-alerting)).
The re-check costs another probe's fetches (one, plus any redirects it follows) and no D1 queries, and the run asks for them only when a check has failed, so passing checks keep costing only their own fetches.
D1 queries, not fetches, decide how many checks fit on Free, so re-checks don't reduce the number of monitors a run can check.
If a run has no fetch left for a re-check, it does not record the failure at all: the monitor keeps its state, no incident opens, and it stays due, so the next run checks it first and confirms it then.
OpenPing chooses a 12-minute delay over an alert that wasn't confirmed; Settings > Diagnostics counts these as deferred re-checks.
A monitor that is already down gets no re-check, so a long outage costs one fetch per run, and heartbeats are never re-checked.
A run with a re-check takes about 5 seconds longer (it waits before the second check); that is wall-clock time, not CPU time.

### How many monitors fit

Measured in `test/integration/scheduler-budget.test.ts` (30 HTTP monitors):

- **Free plan: about 8 checks per run** when checks pass (about 5 D1 queries
  each), and about 3 per run while checks are failing and opening incidents
  (about 9 each). Polled monitors are checked every 12 minutes, so the Free plan
  comfortably runs **about 8 monitors that are on at the same time**.
- Monitors outside their operating hours cost nothing, so a set of
  business-hours monitors that don't all overlap goes further, and a monitor
  that misses a tick is simply checked on the next one.
- **Workers Paid** (`"WORKERS_PLAN": "paid"` in `wrangler.jsonc`): up to 200
  checks per run.

The CPU limit (10 ms per cron run on Free) counts only time spent computing, not
waiting on the network or D1, so it isn't usually the constraint for a few
checks; watch the Worker's logs in the Cloudflare dashboard if you push the
Free plan hard.

### How long a run takes

A run's **Duration** (in Settings > Diagnostics, and `durationMs` in `/api/diagnostics`) is wall-clock time, not CPU time.
Almost all of it is spent waiting on D1, so it is set by how many round trips the run makes and how far each one travels.
Cron Triggers run on whichever Cloudflare machine has spare capacity, which is often far from your database.
In production a D1 round trip from a cron run measured about 160 ms on most ticks and about 12 ms on a good one, while the same queries from a dashboard request take a few milliseconds.

So the scheduler sends its work in as few round trips as it can (`src/worker/scheduler.ts`):

1. one batch takes the lease, opens the run record and reads the monitors, their state, maintenance windows and settings;
2. each due check adds its own queries;
3. one batch does the end-of-run work: claiming queued notifications, the rollups, retention and expired-login cleanup;
4. one batch records the finish and releases the lease.

A run that checks nothing (every monitor paused or outside its hours) makes exactly 3 round trips and finishes in well under a second even at 160 ms each.
The **DB calls** column (`d1Queries`) shows each run's count, so duration divided by DB calls is roughly that run's latency to D1.
Builds before this change rolled history up with one query per monitor and day, about 160 round trips per run, which is why off-hours runs on those builds took 25 to 40 seconds while checking nothing.

### Telling OpenPing your plan

Set `WORKERS_PLAN` in `wrangler.jsonc` (`"free"`, the default, or `"paid"`) and
redeploy. Leaving it on `"free"` on a Paid account is safe; it just checks fewer
monitors per run than it could.

## The in-app Usage estimates

OpenPing shows a **Usage** view with its own estimates of requests and D1
activity. Treat these as **OpenPing's own approximations to help you plan** -
they are **not** authoritative billing figures. Always rely on the **Cloudflare
dashboard** for actual usage and on Cloudflare's pricing pages for the
authoritative limits.

## Keeping usage low

- Polled monitors run every 12 minutes, so each one that is on costs one check
  per run.
- Lean on **schedule-aware monitoring**: outside operating hours a monitor is
  `Scheduled off` and isn't checked.
- Pause monitors you don't currently need.
- Keep the monitor count modest on the Free plan (about 8 on at once); each
  added monitor adds up to 120 checks a day.
