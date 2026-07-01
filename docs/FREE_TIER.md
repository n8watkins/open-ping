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
   shorter intervals, scale this up proportionally — but schedule-aware monitors
   are only checked during their operating hours, which reduces it.

   The newer check types behave the same way, just with a different transport:
   **DNS** and **domain-expiry** checks are ordinary outbound `fetch`
   subrequests (to Cloudflare's DNS-over-HTTPS resolver and to RDAP,
   respectively), and **TCP** checks open a `connect()` socket instead of a
   `fetch`. Each still counts as roughly one check, and the scheduler caps every
   run at **200 checks** (most-overdue first; any excess defers to the next
   tick), so no single run can fan out unboundedly. In other words, the new
   types add work in the same proportional, bounded way as HTTP monitors and
   still fit comfortably in the free tier.
3. **D1 reads/writes.** Each run does light database work: reading which monitors
   are due and their state, then writing samples, state updates, interval/summary
   rollups, and any queued notifications. This is small and roughly proportional
   to the number of checks per run.

There's also occasional traffic from you loading the dashboard and from visitors
viewing the public status page, plus notification deliveries (email/push/Discord/
webhook) when incidents happen — all typically minor for a small install.

## How this maps to the free tier

Cloudflare's free plan has limits on, broadly:

- **Workers requests per day** (your scheduled runs + dashboard/status-page hits),
- **D1 rows read and rows written per day**,
- **D1 storage**.

**Those numbers are set by Cloudflare, live on Cloudflare's side, and change over
time** — so this doc deliberately does **not** hard-code them. Check the current
limits on Cloudflare's pricing pages:

- Workers pricing & limits: <https://developers.cloudflare.com/workers/platform/pricing/>
- Workers Free plan limits: <https://developers.cloudflare.com/workers/platform/limits/>
- D1 pricing & limits: <https://developers.cloudflare.com/d1/platform/pricing/>

### The takeaway

For a small install — **a handful of monitors** at the default 12-minute
cadence — the daily numbers above (≈120 scheduled runs, a few hundred checks,
and proportionally light D1 reads/writes) sit **well within** Cloudflare's free
tier with comfortable headroom. You generally only need to think about limits if
you run many monitors, use very short intervals, retain a lot of history, or get
heavy public-status-page traffic.

## The in-app Usage estimates

OpenPing shows a **Usage** view with its own estimates of requests and D1
activity. Treat these as **OpenPing's own approximations to help you plan** —
they are **not** authoritative billing figures. Always rely on the **Cloudflare
dashboard** for actual usage and on Cloudflare's pricing pages for the
authoritative limits.

## Keeping usage low

- Use the **default 12-minute interval** (shorter intervals multiply checks and
  D1 writes).
- Lean on **schedule-aware monitoring**: outside operating hours a monitor is
  `Scheduled off` and isn't checked.
- Pause monitors you don't currently need.
- Keep the monitor count modest; each added monitor adds ~120 checks/day at the
  default cadence.
