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
   many monitors as fit its plan's per-run budget (about 7 on Free, up to 200 on
   Paid; see below), most overdue first, with the rest deferred to the next tick.
3. **D1 reads/writes.** Each run does light database work: reading which monitors
   are due and their state, then writing samples, state updates, interval/summary
   rollups, and any queued notifications. This is small and roughly proportional
   to the number of checks per run.

There's also occasional traffic from you loading the dashboard and from visitors
viewing the public status page, plus notification deliveries (email/push/Discord/
webhook) when incidents happen - all typically minor for a small install.

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
(`src/worker/lib/budget.ts`): it counts its D1 queries as it goes, allows two
fetches per check (the attempt and one retry) and one per alert, keeps room for
the work every run ends with (rollups, cleanup, the run record), and leaves any
monitor that doesn't fit due for the next tick, most overdue first. Nothing is
dropped; it just waits 12 minutes.

### How many monitors fit

Measured in `test/integration/scheduler-budget.test.ts` (30 HTTP monitors):

- **Free plan: about 7 checks per run** when checks pass (about 5 D1 queries
  each), and about 3 per run while checks are failing and opening incidents
  (about 9 each). Polled monitors are checked every 12 minutes, so the Free plan
  comfortably runs **about 7 monitors that are on at the same time**.
- Monitors outside their operating hours cost nothing, so a set of
  business-hours monitors that don't all overlap goes further, and a monitor
  that misses a tick is simply checked on the next one.
- **Workers Paid** (`"WORKERS_PLAN": "paid"` in `wrangler.jsonc`): up to 200
  checks per run.

The CPU limit (10 ms per cron run on Free) counts only time spent computing, not
waiting on the network or D1, so it isn't usually the constraint for a few
checks; watch the Worker's logs in the Cloudflare dashboard if you push the
Free plan hard.

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
- Keep the monitor count modest on the Free plan (about 7 on at once); each
  added monitor adds up to 120 checks a day.
