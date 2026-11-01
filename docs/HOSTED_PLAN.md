# OpenPing Hosted: the staged plan

Decided 2026-10-27.
OpenPing stays free to run in your own Cloudflare account, and gets one paid option, OpenPing Hosted, for people who would rather not run it.
There is no free hosted plan.
The research behind the numbers: the short plan (https://claude.ai/artifact/BARzBrjwkQMgtZs2HWgjAk) and the full report (https://claude.ai/artifact/C67YiUApqTAGcsR7VHxiEN).

## The offer

The launch pricing is decided ([decision D13](./hosted/DECISIONS.md#d13-launch-pricing), 2026-10-29).

- **In your own Cloudflare account:** free and MIT licensed, every feature, set up with the guide at `/install` (and `docs/INSTALL.md`).
- **OpenPing Hosted: $24 a year.** 20 monitors checked every 12 minutes, 2 status pages, every alert channel, and a failure confirmed from a second region before it alerts.
- **Fast checks add-on: $24 a year more ($48 in total).** 1-minute checks on up to 5 of the monitors; the rest stay at 12 minutes.
- **More monitors:** a pack of 25 more monitors at 12-minute checks is $24 a year, at most 4 packs (120 monitors); a pack of 5 more fast monitors (1-minute checks, with the add-on) is $36 a year, at most 3 packs (20 fast monitors).
  Larger accounts ask support.
- **Trial:** 30 days, no card (5 monitors, 12-minute checks, 1 status page, email alerts).
- **Yearly billing only**, because of Stripe's 30 cent fee per charge.
- **Not offered:** checks faster than a minute, a global probe network, or SMS and voice (revisit only if customers ask).

Every number above lives in one place in the code, and the landing page, the platform's billing pages and the limits the platform sends each customer's OpenPing all read it:

- the plans' limits, the packs and their caps: `PLAN_LIMITS` and `PACKS` in `src/shared/hosted-contract.ts` (the contract, [section 5](./hosted/CONTRACT.md#5-plans-and-limits));
- the dollar amounts and the trial length: `src/shared/hosted-offer.ts` (`HOSTED_TRIAL_DAYS` is the platform's `TRIAL_DAYS`);
- what Stripe charges: the four yearly Prices of [platform/README.md](../platform/README.md), step 11, whose ids are config.

## Why it can be this cheap

- Each hosted customer is their own isolated OpenPing (Cloudflare Workers for Platforms), so the code that already runs in your own account runs for them unchanged, and no customer can ever see another's data.
- Fixed costs are about $25 to $45 a month: Workers Paid ($5), Workers for Platforms ($25), and email beyond Resend's free tier.
  Starter mode starts at $5 a month, Workers Paid alone, until about 80 customers ([Starting cheaper](#starting-cheaper-starter-mode-on-workers-paid-alone)).
- Each customer costs about 6 cents a month at 12-minute checks (5 monitors), and about 5 cents at 1-minute checks once check writes are batched (stage 2).
- Stripe's 30 cent fee is why billing is yearly: it takes about 5% of $24, but 14% of a $3 monthly charge.
- Break-even is about 20 to 25 customers.
- Measured on 2026-10-29, the per-customer cost is higher than the two lines above: about 80 cents a month for 20 monitors at 12-minute checks, and about $7.30 a month for 20 monitors at 1-minute checks, past the first 50 million rows Workers Paid includes.
  1-minute checks for 20 monitors did not fit the $12 add-on first planned, which is why the add-on is $24 a year for 5 monitors; see [Cost per customer, measured](#cost-per-customer-measured).
- Measured again on 2026-10-31, after each check started writing fewer rows (option 4 below): about 45 cents a month at 12-minute checks and about $3.00 at 1-minute checks, for 20 monitors.

## Cost per customer, measured

Measured first on 2026-10-29 with the build of Hosted wave 3 (per-monitor intervals), and again on 2026-10-31 after each check started writing fewer rows, in `test/integration/hosted-cadence.test.ts`: the real scheduler and D1 (workerd), the platform calling as its scheduler does, counting D1's own `rows_read` and `rows_written`.
D1 bills rows, not queries: on Workers Paid the account's first 50 million rows written and 25 billion read each month are included, then $1.00 per million written and $0.001 per million read (checked on 2026-10-29 at developers.cloudflare.com/workers/platform/pricing).
Local D1 may count index writes a little differently from production; the first month's invoice is the real number (risk table in the build plan).

| 20 monitors | Calls a month | Rows written a month | Rows read a month | D1 past the allowance | Requests, queue and CPU | Total a month | Revenue a month |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Every 12 minutes (`hosted`) | 3,600 | 0.44 million (was 0.79) | 2.6 million | $0.44 | under $0.01 | about $0.45 (was $0.80) | $2.00 |
| Every minute (`hosted_fast`) | 43,200 | 2.9 million (was 7.2) | 11.8 million | $2.90 | about $0.10 | about $3.00 (was $7.30) | $3.00 |

- A passing check that changes nothing writes 3 rows: its state (with its next-check index entry) and its count in its hour summary, which also keeps its time, response time and status code for the 24-hour views (`history/check-log.ts`).
  It used to write about 7.3: a sample row (3 with its two indexes), the same state and hour summary, and the open status interval, and its sample's delete a day later cost one more.
  A check that fails, changes the state, warms up or was a blip a re-check cleared still writes its full sample row; the status interval is written only when the state changes.
  `test/integration/check-write-rows.test.ts` pins these counts.
- A call on 1-minute checks writes about 67 rows (was 147): about 3 per check plus the run's lease, and the upkeep every 12th call.
  The first check of each hour also starts that hour's summary (3 rows more), and the upkeep clears each hour's check log a day later (1 row an hour), in place of a delete for every sample.
- A call on 12-minute checks writes about 119 rows (was 199), because each also does the upkeep: the history rollups, the cleanup and the run record (lib/cadence.ts does these once per 12 minutes however often the tenant is called).
  40 of them are the day and month rollups, which rewrite each monitor's current day and month on every pass; at 12-minute checks they are now the largest part.
- Per monitor this is about 21,000 rows a month at 12-minute checks (its checks, its hour summaries and its share of the rollups) and about 137,000 at 1-minute checks; the calls themselves add about 25,000 a month at 12 minutes and 144,000 when the tenant is called every minute.
  The plan and pack costs below are built from these.
- Reads cost almost nothing now; before the rollups fix in the same wave, every run read about 160,000 rows and wrote 1,347 on a two-month-old install, about $4.85 a month per customer at 12-minute checks.
- A 5-monitor trial at 12-minute checks is about 13 cents a month (was 20), from the same numbers.
- Viewing reads rows too.
  With 1-minute checks a monitor checks 1,440 times a day, so the Overview and the all-monitors 24-hour history would have read about 86,000 and 57,600 rows per view for 20 monitors; they now read about 1,700 and 1,000 (the Overview reaches each monitor's last 28 checks through the index, and the all-monitors 24-hour view takes hourly averages for its percentiles while any monitor is checked more often than every 12 minutes).
  One monitor's own 24-hour view reads its 24 hour summaries, which hold its passing checks, and the sample rows of the rest, instead of 1,440 sample rows.
  Until 2026-10-31 every all-monitors view (the history from 24 hours to 90 days, the Overview, the Monitors list's stats and the uptime figures) read the whole summaries table, about 30,000 rows a view on a two-month-old install with 20 monitors; they now read only the rows in their range (`test/integration/history-compaction.test.ts`).
- Requests, queue messages and CPU are per call: about 3 queue operations ($0.40 per million) and 2 Worker requests ($0.30 per million) a call, and a few milliseconds of CPU.
- The included 50 million rows written cover about 110 customers at 12-minute checks (was 60), or about 17 at 1-minute checks (was 6), before any of this is billed.

**1-minute checks for 20 monitors don't fit the $12 add-on.**
They cost about $7.20 a month in rows against $1 a month of add-on revenue (measured 2026-10-29; about $2.90 since option 4, 2026-10-31).
The options, with what each cost for one customer when they were weighed (2026-10-29, before option 4):

1. **Cap 1-minute checks at 5 monitors** (the other 15 at 12 minutes): about 2.5 million rows (the 5 fast monitors, the other 15, and a call every minute), so $2.50 a month against $3.00.
   A plan limit (a new `fastMonitors` field in `PlanLimits`) and a contract change.
2. **Make the add-on's fastest interval 5 minutes** for all 20: about 1.7 million rows, so $1.70 a month against $3.00.
   Only the platform's `minIntervalMinutes` for `hosted_fast` changes; the editor already offers 5 minutes.
3. **Price the add-on for 20 one-minute monitors**: about $90 a year.
4. **Write fewer rows per check** (a sample only on a change, a failure or once per 12 minutes, and the status interval's counts taken from the summaries): about 3.5 rows a check, $3.50 a month for 20 one-minute monitors.
   About 2 days of work; it makes options 1 and 2 comfortable but doesn't close the gap alone, and it coarsens the 24-hour chart for 1-minute monitors.
   **Done on 2026-10-31**, without coarsening anything: a passing check that changes nothing is kept in its hour summary instead of a sample row, so every chart, percentile and recent-checks list shows every check as before, and the status interval is written only when the state changes.
   It writes about 3 rows a check at either cadence: $2.90 a month for 20 one-minute monitors, and 44 cents for 20 at 12 minutes.
5. **Launch as is and watch it**: the first 6 or so fast customers fit in the included rows, and the invoice shows the real cost before the allowance is used up.

**Launch pricing (recommended 2026-10-29, decided as D13 the same day, with the packs added):**

| Plan | Price | What it includes | Cost to us a month (worst case) |
| --- | --- | --- | --- |
| Self-hosted | free | everything, in the customer's own Cloudflare account | none |
| Trial | free for 30 days, no card | 5 monitors at 12-minute checks, 1 status page, email alerts | about $0.13 (was $0.20) |
| OpenPing Hosted | $24 a year | 20 monitors at 12-minute checks, 2 status pages, every alert channel, second-region confirmation | about $0.45 against $2.00 (was $0.83) |
| Fast checks add-on | $24 a year more ($48 in total) | 1-minute checks on up to 5 of the 20 monitors; the rest stay at 12 minutes | about $1.24 against $4.00 (was $2.50) |
| Monitor pack | $24 a year each, at most 4 | 25 more monitors at 12-minute checks | about $0.52 against $2.00 (was $0.70) |
| Fast monitor pack | $36 a year each, at most 3, with the add-on | 5 more monitors at 1-minute checks | about $0.69 against $3.00 (was $1.60) |

- The costs are from the 2026-10-31 measurements (option 4 done); the figures in brackets are the 2026-10-29 ones the prices were decided on.
- The fast checks add-on's cost is its 5 fast monitors (about 0.69 million rows a month), its 15 monitors at 12 minutes (about 0.32 million), the tenant's calls every minute (about 0.14 million rows) and their requests (about $0.10).
- A pack's cost is its monitors' rows alone, their share of the rollups included (the calls are already paid for by the plan): 25 monitors every 12 minutes write about 0.52 million rows a month, and 5 monitors every minute about 0.69 million.
- This is option 1 priced at $24 a year instead of $12: at $12 it cleared only about 50 cents a month on the 2026-10-29 costs, too little to absorb card fees (about 8 to 15 cents a month) and busier customers.
- Option 4 (fewer rows per check) was planned for after launch and is done (2026-10-31): it roughly halved every plan's cost, the base plan included.
- Yearly billing only, as before, because of Stripe's 30 cent fee per charge.

**Margins on the recommended prices (2026-10-29, costs measured again on 2026-10-31),** after Stripe's card fee (2.9% plus 30 cents a charge) and Stripe Tax (0.5%):

| Plan | Price a year | Stripe a year | Cost a year, busiest / typical | Profit a year, busiest / typical | Margin, busiest / typical |
| --- | --- | --- | --- | --- | --- |
| OpenPing Hosted | $24 | $1.12 | $5.40 / $2.40 | $17.48 / $20.48 | 73% / 85% |
| Hosted with fast checks | $48 | $1.93 | $14.88 / $9.12 | $31.19 / $36.95 | 65% / 77% |

- Busiest means every monitor the plan allows is in use (20 at 12 minutes; or 5 at 1 minute and 15 at 12 minutes); typical means about 8 monitors, or 3 fast and 5 at 12 minutes.
- Before option 4 (2026-10-29) the costs were $9.96 / $4.09 and $33.60 / $16.80 a year, for margins of 54% / 78% and 26% / 61%.
- Fixed cost is about $30 a month (Workers Paid and Workers for Platforms), so break-even is about 18 typical or 21 busiest base-plan customers (was 20 and 28).
- While the account stays inside the 50 million rows written that Workers Paid includes (about 110 base-plan customers, was 60), the base plan's margin is about 94%: Stripe's fee is then the main cost.
- Not included: email beyond Resend's free tier, the domain, and support time.

**The trial (decided: 30 days with 5 monitors, D13).**
There is no free plan: self-hosting is the free offering.
A trial costs what its monitors cost to run for its length, and no Stripe fee:

| Trial | Cost per trial | Per paying customer at 5% / 10% / 20% conversion | As a share of the first year's $24 |
| --- | --- | --- | --- |
| 14 days, 5 monitors (first built) | about $0.06 | $1.20 / $0.60 / $0.30 | 5% / 3% / 1% |
| 30 days, 5 monitors (decided) | about $0.13 | $2.60 / $1.30 / $0.65 | 11% / 5% / 3% |
| 30 days, the full plan (20 monitors) | about $0.45 | $9.00 / $4.50 / $2.25 | 38% / 19% / 9% |

- Costs from the 2026-10-31 measurements; on the 2026-10-29 ones the three trials cost about $0.10, $0.20 and $0.83.
- The conversion rates are assumptions to show the range, not measurements.
- A 30-day trial with 5 monitors costs at most about 11% of a converted customer's first year even at a poor 5% conversion, and inside the included rows it costs close to nothing.
- The full plan as a trial is the one that can cost a large share of the first year, and it invites using the trial as a free plan.

## Starting cheaper: starter mode on Workers Paid alone

Built 2026-10-31 and off by default ([platform/README.md, "Starter mode"](../platform/README.md#starter-mode), [the contract, section 10](./hosted/CONTRACT.md#10-starter-mode-ordinary-workers-and-signed-calls)).
Starter mode runs every customer as an ordinary Worker on the account, at its own Custom Domain under a subdomain the owner already has (`<slug>.openping.n8builds.dev`), so Hosted needs Workers Paid ($5 a month) and no Workers for Platforms ($25 a month) and no new domain.
The checks, the database and every per-customer number above are the same in both modes: only how the platform and a customer's OpenPing call each other changes.

**What starter mode adds per customer, measured on 2026-10-31** in local D1 (workerd), counting D1's own `rows_written`:

- Each signed call's nonce is recorded once and deleted when it expires: 4 rows written a call, on the receiving side.
- A customer on 12-minute checks gets 3,600 platform calls a month and makes about 3,600 calls back (the usage report once per 12 minutes), plus one description request per 30 seconds of each isolate that serves its visitors (at most about 86,000 a month for a status page visited all day, and a few thousand for a quiet one).
  That is about 0.03 million rows a month for a quiet customer and at most about 0.37 million for a busy status page, against the 0.79 million a busiest customer's checks write (about 4% to 47% more rows; typical customers are near the low end).
- On 1-minute checks it is 43,200 platform calls a month, about 0.19 million rows, against 7.2 million.
- Requests: the tenant's calls back to the platform are about 7,000 to 90,000 more Worker requests a customer a month, inside the 10 million Workers Paid includes until well past 100 customers.
- CPU: an HMAC-SHA256 over a few hundred bytes per call, well under a millisecond.

**Cost a month on Workers Paid alone,** for the base plan (`hosted`, 12-minute checks), busiest (20 monitors, 0.82 million rows a customer with starter mode's rows) and typical (about 8 monitors, about 0.38 million), with D1's first 50 million rows written and the Queues' first million operations included (checked 2026-10-29 at developers.cloudflare.com/workers/platform/pricing):

| Customers | Rows written, busiest / typical | Starter mode, busiest / typical | Workers for Platforms, busiest / typical | Revenue |
| --- | --- | --- | --- | --- |
| 10 | 8.2 / 3.8 million | $5 / $5 | $30 / $30 | $20 |
| 50 | 41 / 19 million | $5 / $5 | $30 / $30 | $100 |
| 200 | 164 / 76 million | not possible as built (see below) | $145 / $57 | $400 |

- At 200 customers the rows past the allowance are about $114 (busiest) or $26 (typical), the queue operations past the first million about 50 cents, and the requests still inside the 10 million; the table's Workers for Platforms figures add its $25 to those.
- **Starter mode stops at one zone's 100 Custom Domains,** the owner's own hostnames included: with `n8builds.dev` already holding a few, about 85 to 90 customers.
  Sign-ups stop at 95 with a plain message, and the health check warns the owner from 85.
  Workers Paid's 500 Workers per account would allow about 490, but the Custom Domains run out first.
- So the plan is to start in starter mode and move to Workers for Platforms, with a dedicated domain and its wildcard route, before about 80 customers: the move is one tenant at a time from the admin console, keeps each customer's data where it is, and serves visitors throughout ([platform/README.md](../platform/README.md#moving-to-workers-for-platforms)).
- Break-even: a typical base-plan customer brings about $1.90 a month after Stripe's fees, so starter mode's $5 is covered by 3 customers, against about 16 for the $30 of Workers Paid with Workers for Platforms.
- Not included, as above: email beyond Resend's free tier and support time; starter mode saves the domain (about $10 to $15 a year) too.

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
  - Stripe Checkout for the $24 yearly plan, the $24 yearly fast checks add-on and the monitor packs ($24 and $36 a year each), adding and removing packs from the billing page, and the Stripe Customer Portal for cards, invoices and cancelling.
  - A webhook that writes subscription state to the platform database and turns plans, the add-on and the packs on and off.
  - Stripe Tax for sales tax and VAT.
  - Plan limits enforced in the customer Worker: 20 monitors (more with packs), 2 status pages, 12-minute checks, and 1-minute checks on as many monitors as the add-on and its packs allow.
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
