# OpenPing Hosted: the staged plan

Decided 2026-10-27.
OpenPing stays free to run in your own Cloudflare account, and gets one paid option, OpenPing Hosted, for people who would rather not run it.
There is no free hosted plan.
The research behind the numbers: the short plan (https://claude.ai/artifact/BARzBrjwkQMgtZs2HWgjAk) and the full report (https://claude.ai/artifact/C67YiUApqTAGcsR7VHxiEN).

## The offer

- **In your own Cloudflare account:** free and MIT licensed, every feature, set up with the guide at `/install` (and `docs/INSTALL.md`).
- **OpenPing Hosted: $24 a year.** 20 monitors checked every 12 minutes, 2 status pages, every alert channel, and a failure confirmed from a second region before it alerts.
- **Fast checks add-on: $12 a year more** for 1-minute checks.
- **Trial:** 14 days, no card, if it stays cheap to support (5 monitors, 12-minute checks, 1 status page, email alerts).
- **Not offered:** checks faster than a minute, a global probe network, or SMS and voice (revisit only if customers ask).

## Why it can be this cheap

- Each hosted customer is their own isolated OpenPing (Cloudflare Workers for Platforms), so the code that already runs in your own account runs for them unchanged, and no customer can ever see another's data.
- Fixed costs are about $25 to $45 a month: Workers Paid ($5), Workers for Platforms ($25), and email beyond Resend's free tier.
- Each customer costs about 6 cents a month at 12-minute checks (5 monitors), and about 5 cents at 1-minute checks once check writes are batched (stage 2).
- Stripe's 30 cent fee is why billing is yearly: it takes about 5% of $24, but 14% of a $3 monthly charge.
- Break-even is about 20 to 25 customers.

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
  - The waitlist: email only, a honeypot, per-IP and global rate limits, a confirmation email when Resend is set up, stored in D1 (migration 0010), and only on the canonical install (`WAITLIST_ENABLED`); every other install's landing page posts to it.
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
