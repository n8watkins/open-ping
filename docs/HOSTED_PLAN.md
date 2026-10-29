# OpenPing Hosted: the staged plan

Decided 2026-10-27.
OpenPing stays free to run in your own Cloudflare account, and gets one paid option, OpenPing Hosted, for people who would rather not run it.
There is no free hosted plan.
The research behind the numbers: the short plan (https://claude.ai/artifact/BARzBrjwkQMgtZs2HWgjAk) and the full report (https://claude.ai/artifact/C67YiUApqTAGcsR7VHxiEN).

## The offer

- **In your own Cloudflare account:** free and MIT licensed, every feature, set up with the guide at `/install` (and `docs/INSTALL.md`).
- **OpenPing Hosted: $24 a year.** 20 monitors checked every 12 minutes, 2 status pages, every alert channel, and a failure confirmed from a second region before it alerts.
- **Fast checks add-on:** planned at $12 a year for 1-minute checks; the measured cost doesn't fit, and the recommendation is $24 a year for 1-minute checks on up to 5 monitors (see [Cost per customer, measured](#cost-per-customer-measured)).
- **Trial:** 14 days, no card, if it stays cheap to support (5 monitors, 12-minute checks, 1 status page, email alerts).
- **Not offered:** checks faster than a minute, a global probe network, or SMS and voice (revisit only if customers ask).

## Why it can be this cheap

- Each hosted customer is their own isolated OpenPing (Cloudflare Workers for Platforms), so the code that already runs in your own account runs for them unchanged, and no customer can ever see another's data.
- Fixed costs are about $25 to $45 a month: Workers Paid ($5), Workers for Platforms ($25), and email beyond Resend's free tier.
- Each customer costs about 6 cents a month at 12-minute checks (5 monitors), and about 5 cents at 1-minute checks once check writes are batched (stage 2).
- Stripe's 30 cent fee is why billing is yearly: it takes about 5% of $24, but 14% of a $3 monthly charge.
- Break-even is about 20 to 25 customers.
- Measured on 2026-10-29, the per-customer cost is higher than the two lines above: about 80 cents a month for 20 monitors at 12-minute checks, and about $7.30 a month for 20 monitors at 1-minute checks, past the first 50 million rows Workers Paid includes.
  1-minute checks for 20 monitors do not fit the $12 add-on; see [Cost per customer, measured](#cost-per-customer-measured).

## Cost per customer, measured

Measured on 2026-10-29 with the build of Hosted wave 3 (per-monitor intervals), in `test/integration/hosted-cadence.test.ts`: the real scheduler and D1 (workerd), the platform calling as its scheduler does, counting D1's own `rows_read` and `rows_written`.
D1 bills rows, not queries: on Workers Paid the account's first 50 million rows written and 25 billion read each month are included, then $1.00 per million written and $0.001 per million read (checked on 2026-10-29 at developers.cloudflare.com/workers/platform/pricing).
Local D1 may count index writes a little differently from production; the first month's invoice is the real number (risk table in the build plan).

| 20 monitors | Calls a month | Rows written a month | Rows read a month | D1 past the allowance | Requests, queue and CPU | Total a month | Revenue a month |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Every 12 minutes (`hosted`) | 3,600 | 0.79 million | 2.6 million | $0.79 | under $0.01 | about $0.80 | $2.00 |
| Every minute (`hosted_fast`) | 43,200 | 7.2 million | 13 million | $7.20 | about $0.10 | about $7.30 | $3.00 |

- A call on 1-minute checks writes about 147 rows: about 7.3 per check (its state, sample, hour summary and status interval, with their indexes) plus the run's lease.
  A check's sample is deleted a day later, one more row each.
- A call on 12-minute checks writes about 199 rows, because each also does the upkeep: the history rollups, the cleanup and the run record (lib/cadence.ts does these once per 12 minutes however often the tenant is called).
- Reads cost almost nothing now; before the rollups fix in the same wave, every run read about 160,000 rows and wrote 1,347 on a two-month-old install, about $4.85 a month per customer at 12-minute checks.
- A 5-monitor trial at 12-minute checks is about 20 cents a month, estimated from the same numbers.
- Viewing reads rows too.
  With 1-minute checks a monitor keeps 1,440 samples a day, so the Overview and the all-monitors 24-hour history would have read about 86,000 and 57,600 rows per view for 20 monitors; they now read about 1,700 and 1,000 (the Overview reaches each monitor's last 28 checks through the index, and the all-monitors 24-hour view takes hourly averages for its percentiles while any monitor is checked more often than every 12 minutes).
  One monitor's own 24-hour view still reads its 1,440 checks, which are its chart's points: about 1.4 million rows for 1,000 views, a tenth of a cent.
- Requests, queue messages and CPU are per call: about 3 queue operations ($0.40 per million) and 2 Worker requests ($0.30 per million) a call, and a few milliseconds of CPU.
- The included 50 million rows written cover about 60 customers at 12-minute checks, or about 6 at 1-minute checks, before any of this is billed.

**1-minute checks for 20 monitors don't fit the $12 add-on.**
They cost about $7.20 a month in rows against $1 a month of add-on revenue.
The options, with what each costs for one customer:

1. **Cap 1-minute checks at 5 monitors** (the other 15 at 12 minutes): about 2.5 million rows (the 5 fast monitors, the other 15, and a call every minute), so $2.50 a month against $3.00.
   A plan limit (a new `fastMonitors` field in `PlanLimits`) and a contract change.
2. **Make the add-on's fastest interval 5 minutes** for all 20: about 1.7 million rows, so $1.70 a month against $3.00.
   Only the platform's `minIntervalMinutes` for `hosted_fast` changes; the editor already offers 5 minutes.
3. **Price the add-on for 20 one-minute monitors**: about $90 a year.
4. **Write fewer rows per check** (a sample only on a change, a failure or once per 12 minutes, and the status interval's counts taken from the summaries): about 3.5 rows a check, $3.50 a month for 20 one-minute monitors.
   About 2 days of work; it makes options 1 and 2 comfortable but doesn't close the gap alone, and it coarsens the 24-hour chart for 1-minute monitors.
5. **Launch as is and watch it**: the first 6 or so fast customers fit in the included rows, and the invoice shows the real cost before the allowance is used up.

**Recommended pricing (2026-10-29, pending the owner's yes):**

| Plan | Price | What it includes | Cost to us a month (worst case) |
| --- | --- | --- | --- |
| Self-hosted | free | everything, in the customer's own Cloudflare account | none |
| Trial | free for 14 days, no card | 5 monitors at 12-minute checks, 1 status page, email alerts | about $0.20 |
| OpenPing Hosted | $24 a year | 20 monitors at 12-minute checks, 2 status pages, every alert channel, second-region confirmation | about $0.83 against $2.00 |
| Fast checks add-on | $24 a year more ($48 in total) | 1-minute checks on up to 5 of the 20 monitors; the rest stay at 12 minutes | about $2.50 against $4.00 |

- This is option 1 priced at $24 a year instead of $12: at $12 it clears only about 50 cents a month, too little to absorb card fees (about 8 to 15 cents a month) and busier customers.
- Option 4 (fewer rows per check) comes after launch, because it roughly halves every plan's cost, the base plan included.
- Yearly billing only, as before, because of Stripe's 30 cent fee per charge.

**Margins on the recommended prices (2026-10-29),** after Stripe's card fee (2.9% plus 30 cents a charge) and Stripe Tax (0.5%):

| Plan | Price a year | Stripe a year | Cost a year, busiest / typical | Profit a year, busiest / typical | Margin, busiest / typical |
| --- | --- | --- | --- | --- | --- |
| OpenPing Hosted | $24 | $1.12 | $9.96 / $4.09 | $12.92 / $18.79 | 54% / 78% |
| Hosted with fast checks | $48 | $1.93 | $33.60 / $16.80 | $12.47 / $29.27 | 26% / 61% |

- Busiest means every monitor the plan allows is in use (20 at 12 minutes; or 5 at 1 minute and 15 at 12 minutes); typical means about 8 monitors, or 3 fast and 5 at 12 minutes.
- Fixed cost is about $30 a month (Workers Paid and Workers for Platforms), so break-even is about 20 typical or 28 busiest base-plan customers.
- While the account stays inside the 50 million rows written that Workers Paid includes (about 60 base-plan customers), the base plan's margin is about 94%: Stripe's fee is then the main cost.
- Not included: email beyond Resend's free tier, the domain, and support time.

**The trial (pending the owner's choice).**
There is no free plan: self-hosting is the free offering.
A trial costs what its monitors cost to run for its length, and no Stripe fee:

| Trial | Cost per trial | Per paying customer at 5% / 10% / 20% conversion | As a share of the first year's $24 |
| --- | --- | --- | --- |
| 14 days, 5 monitors (as built) | about $0.10 | $2.00 / $1.00 / $0.50 | 8% / 4% / 2% |
| 30 days, 5 monitors (recommended) | about $0.20 | $4.00 / $2.00 / $1.00 | 17% / 8% / 4% |
| 30 days, the full plan (20 monitors) | about $0.83 | $16.60 / $8.30 / $4.15 | 69% / 35% / 17% |

- The conversion rates are assumptions to show the range, not measurements.
- A 30-day trial with 5 monitors costs at most about 17% of a converted customer's first year even at a poor 5% conversion, and inside the included rows it costs close to nothing.
- The full plan as a trial is the one that can cost a large share of the first year, and it invites using the trial as a free plan.

## The stages

Each stage ends at a gate.
Nothing past stage 2 starts until the stage 1 gate passes.

### Stage 0: stay inside Cloudflare's free plan (done)

- **Goal:** an install on the free plan never fails a run, however many monitors it has.
- **Scope:** the scheduler counts its database queries and outbound requests per run and defers what doesn't fit; the history rollup is a fixed number of queries; `WORKERS_PLAN` picks the budget.
- **Done in:** PR #8 (2026-10-27).

### Stage 1: honest wording and a waitlist

- **Goal:** find out whether people want Hosted before building it.
- **Scope:**
  - "Runs in your own Cloudflare account" instead of "self-hosted" where it misleads.
  - A Pricing section on the landing page: the free own-account path with the step-by-step guide, and "OpenPing Hosted, $24 a year, coming soon" with a waitlist form.
  - The waitlist: email only, a honeypot, per-IP and global rate limits, a confirmation email when Resend is set up, stored in D1 (migration 0010), and only on the canonical install (`WAITLIST_ENABLED`).
    Since the landing page plan's item 1.9, only the canonical install shows the landing page (`HOME_PAGE` "landing"); every other install shows its own status page at `/`.
  - An admin view in Settings with the count, the latest sign-ups and a CSV download.
  - A public `/install` guide.
- **Acceptance:** a sign-up from any install's landing page lands on openping.n8builds.dev once per email; a repeat or a bot gets the same answer and adds nothing; the admin sees the count and can download the CSV; unit and integration tests cover validation, rate limiting, the honeypot, the migration and admin-only access.
- **Effort:** 1 day.
- **Cost:** nothing new.
- **Owner actions:** deploy; apply migration 0010; set `WAITLIST_ENABLED` to `"true"` on openping.n8builds.dev only; optionally set `RESEND_API_KEY` and an `email_from` setting so confirmations send.
- **Gate:** about 20 people join within 8 weeks of launch. If not, stop here; the free path stands on its own.

### Stage 2: cheap fast checks and fewer false alarms

- **Goal:** make 1-minute checks cheap and alerts trustworthy, which both Hosted and the free path benefit from.
- **Scope:**
  - Batch each run's check results into one database write per run instead of about 3 per check.
  - Confirm a failure from a second region (a Durable Object placed by location hint) before opening an incident; 2 of 3 must agree when 3 are used.
    The same-location re-check already ships ("Confirm failures", [MONITOR_TYPES.md](./MONITOR_TYPES.md#confirm-before-alerting)); this step swaps its probe for one in another region.
    Findings (2026-10-28): Durable Objects work on Workers Free (SQLite-backed only); Free allows 50 external subrequests but 1,000 to Cloudflare services per invocation, which should cover calls to a Durable Object (to be measured); a location hint is best effort and applies only when the object is first created, so each region needs its own named object; and the cron's own location is not chosen, so "a different location" must be checked, not assumed.
    Smart Placement and placement hints only move `fetch` handlers, and a service binding runs on the same machine as its caller, so neither gives a second location.
- **Acceptance:** writes per check measured on a real install and under the budget the pricing assumes; a simulated single-region blip doesn't alert; a real outage alerts within one extra check.
- **Effort:** 3 to 4 days.
- **Cost:** under 1 cent per customer a month.
- **Owner actions:** none.
- **Gate:** measured cost per monitor at 1-minute checks is at or below the pricing assumption.

### Stage 3: one customer's OpenPing on Workers for Platforms

- **Goal:** prove the isolated-per-customer model works before building around it.
- **Scope:**
  - A dispatch namespace with one customer Worker and its own D1 database.
  - A platform Worker whose single cron triggers each customer Worker's scheduled run (customer Workers in a namespace can't have their own cron; workers-sdk issue #13840).
  - A migration runner that applies new migrations to every customer database.
  - An update runner that ships a new OpenPing version to every customer Worker.
- **Acceptance:** a test customer's monitors run on schedule for a week with no missed runs; a migration and an update reach the test customer without downtime.
- **Effort:** 4 to 5 days.
- **Cost:** Workers Paid ($5 a month) and Workers for Platforms ($25 a month).
- **Owner actions:** enable Workers Paid and Workers for Platforms on the Cloudflare account; create the dispatch namespace.
- **Gate:** the week-long run is clean.

### Stage 4: sign-up, provisioning and sign-in for customers

- **Goal:** anyone can start a trial and get their own OpenPing in a minute.
- **Scope:**
  - A sign-up page (email), a magic-link sign-in for customers (the existing magic-link code, generalized from the single admin).
  - Automatic provisioning: create the customer's Worker, database and settings, and point them at it.
  - Trial limits (5 monitors, 12-minute checks, 1 status page, email alerts) and automatic suspension when a trial ends unpaid.
- **Acceptance:** sign-up to a working dashboard in under a minute; a suspended customer's checks stop and their data stays for 30 days.
- **Effort:** 5 days.
- **Cost:** pennies per sign-up.
- **Owner actions:** decide the hosted address (for example app.openping.n8builds.dev) and add its DNS.
- **Gate:** five test sign-ups end to end, including a suspended one.

### Stage 5: billing and plan limits

- **Goal:** take payment and enforce what each plan includes.
- **Scope:**
  - Stripe Checkout for the $24 yearly plan and the $12 yearly add-on, and the Stripe Customer Portal for cards, invoices and cancelling.
  - A webhook that writes subscription state to the platform database and turns plans and the add-on on and off.
  - Stripe Tax for sales tax and VAT.
  - Plan limits enforced in the customer Worker: 20 monitors, 2 status pages, 12-minute or 1-minute checks.
- **Acceptance:** test-mode purchase, renewal, add-on, cancellation and a failed card all reach the right state; limits can't be exceeded through the dashboard or the API.
- **Effort:** 4 days.
- **Cost:** Stripe's fees per charge; Stripe Tax's fee per transaction.
- **Owner actions:** a Stripe account in live mode, business details, tax registration where required, the products and prices, and the webhook secret.
- **Gate:** a real $24 purchase by the owner, refunded.

### Stage 6: the parts around the product

- **Goal:** everything a paid service needs besides the software.
- **Scope:**
  - Terms of service and a privacy policy, including what customers may monitor (no checks aimed at sites they don't own or operate).
  - Emails: welcome, trial ending, receipt (Stripe), payment failed, suspended.
  - Monitoring OpenPing itself from outside Cloudflare (a second, independent checker) and a public status page for OpenPing.
  - Support: one email address, a short FAQ, and a response-time promise you can keep.
  - Abuse controls: rate limits on sign-up, a cap on email sends per customer.
- **Acceptance:** every page and email exists and is linked; an outage of the hosted platform pages the owner within 5 minutes.
- **Effort:** 3 days, plus legal review if wanted.
- **Cost:** the outside checker (a few dollars a month) and email.
- **Owner actions:** approve the terms and privacy policy; choose the support address.
- **Gate:** the owner signs off on the legal pages.

### Stage 7: launch

- **Goal:** open Hosted to the waitlist, then everyone.
- **Scope:** switch the Pricing card from "coming soon" to "Start a trial", email the waitlist once with early pricing, post the launch on n8builds.dev.
- **Acceptance:** the first paying customer.
- **Effort:** 1 day.
- **Owner actions:** the launch post.

## Rough total

About 3 weeks of work from stage 2 to stage 7, started only after the stage 1 gate passes.
