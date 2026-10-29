# OpenPing Hosted platform Worker

This is the platform Worker for OpenPing Hosted: the code that owns customers rather than monitoring.
It is planned in [the build plan](../docs/HOSTED_BUILD_PLAN.md), and it talks to each customer's OpenPing only through [the contract](../docs/hosted/CONTRACT.md).

**Status: skeleton (B1), provisioning (B3), accounts (B2), the admin console (B6), scheduling (B4), billing (B5), the release runner (C1), lifecycle (B7) and observability (C4), not deployed anywhere.**
Nothing here has been created in a Cloudflare account yet; see [Owner setup](#owner-setup-not-done-yet).

## What it does today

- Routes by hostname, with the domain taken from the `HOSTED_DOMAIN` var (decision D2, [DECISIONS.md](../docs/hosted/DECISIONS.md)):
  - `app.<domain>`: the platform's own pages (sign-up, sign-in, the account), `GET /healthz` (the Worker and its database answer) and `GET /__health` (the whole platform, for outside monitors);
  - `<domain>` and `www.<domain>`: a 301 to `app.<domain>`;
  - `<slug>.<domain>`: that customer's OpenPing, dispatched to its user Worker `t-<tenant id>`;
  - anything else: a plain 404.
- Looks tenants up in the platform database by slug and answers by their state:
  - unknown, reserved or invalid slug: a "There's no OpenPing here" page (404);
  - still provisioning: an "Almost ready" page (503 with `Retry-After`);
  - suspended: a "This OpenPing is paused" page (503) linking to the account page;
  - ready and not suspended: dispatched with the contract's props and per-call CPU and subrequest limits;
  - ready but the script is missing, or the user Worker throws: an "unavailable" page (502), logged.
- Never forwards a public request to `/__platform/*`, and strips every `x-openping-*` header from public traffic, so nothing a visitor sends can pass for a platform call.
- Provisions a customer's OpenPing (B3, `src/provisioning.ts`), step by step, each step recorded in `tenants.provision_state`:
  - `requested`: generates the tenant's `MASTER_KEY`, escrows it encrypted with `PLATFORM_KEY` (decision D4), and creates its D1 database `openping-t-<id>`;
  - `db_created`: uploads the current tenant bundle as `t-<id>`: static assets first, then the script with its database, `ASSETS`, the hosted vars, the `MASTER_KEY` secret and its tags, plus whatever Durable Objects, migrations and vars the release's own wrangler config declares (`workerConfigFromWrangler` in `src/bundle.ts`, for example the second-region probe); a retried upload deletes the half-made script first, so its Durable Object migrations start from a known tag;
  - `uploaded`: has the tenant apply its migrations through one `POST /__platform/scheduled`;
  - `migrated`: waits for `GET /__platform/health` to answer ok, then marks it `ready`, which is when visitors reach it.
- Drives each run from a Queue (`PROVISION_QUEUE`, `src/provisioning-queue.ts`): a message per new tenant and per retry, so a run gets minutes rather than a request's 30-second `waitUntil`, and a run that dies is delivered again; the every-minute cron (`provisionDue`) is the safety net.
- Retries a failed step with backoff (10 seconds up to 30 minutes).
  A failure retrying can't fix (a Cloudflare 4xx, a broken bundle, a `PLATFORM_KEY` that can't open the escrowed key), or 6 failures in a row, pauses the tenant (`provision_paused_at`) with nothing rolled back, for the owner to fix and `resumeProvisioning`, or `removeTenant`.
  One lease per tenant with a token, renewed before each step and checked by every write, keeps two runs from ever working on one tenant.
  `removeTenant` deletes the script, the database (D1's "not found", code 7404, counts as done), the key and the row, and holds a ready tenant's slug for 90 days so nobody else picks up its address.
- Caches each tenant's row per isolate for routing: 30 seconds for a ready tenant, 5 seconds for an unknown slug, never for one still being set up.
- Checks slugs at sign-up (`checkSlugAvailability`): the rules and reserved names in `src/slugs.ts`, existing tenants, and held slugs.
- Runs customer accounts on `app.<domain>` (B2, `src/account-routes.ts`), designed phone first in OpenPing's tokens:
  - sign-up and sign-in with an email that carries both a 6-digit code and a link (15 minutes, single use, 5 tries per code, 10 wrong codes per address per day before only the link works, and a new sign-in cancels the older ones; the link opens a confirm button so mail scanners can't spend it), a passkey (OpenPing's own `src/worker/lib/webauthn.ts`, discoverable, relying party `app.<domain>`), or GitHub (with PKCE, matched by user id, joined to an account only by its verified primary email);
  - sessions in a `__Host-` cookie that never reaches a customer's subdomain, stored as hashes, 30 days, one per browser;
  - rate limits per address, then per IP (an IPv6 address's /64), then in total, where a request refused by a narrow limit never counts against the wide one, and a short list of throwaway mail domains refused for email and GitHub sign-ups alike;
  - every post checked to come from `app.<domain>`, no inline script (the passkey helper is served from `/static/passkeys.js`);
  - the account page: the customer's OpenPing and its state, passkeys, GitHub, sign-out;
  - changing the sign-in email (`/account/email`, `src/auth/email-change.ts`): a sign-in from the last 15 minutes (a passkey one when the account has a passkey, `src/auth/fresh.ts`), then a 6-digit code and a link to the new address (15 minutes, 5 tries, only for the account that asked; an address another account holds gets nothing and the page reads the same); the switch moves the account and its email identity together, ends the other browsers' sessions, updates the Stripe customer's email, emails the old address and is audited (`account.email_changed`); the customer's OpenPing takes the new address as its report email on the next hand-off (`admin_email`); GitHub sign-in still matches by GitHub id, and a new GitHub account joins only by the account's current email;
  - choosing an address (`/start`) creates the tenant (one per account, enforced by a unique index) and queues its provisioning;
  - `/open?tenant=<slug>` mints the Ed25519 hand-off (`src/handoff.ts`, only the contract's helpers) and redirects to `https://<slug>.<domain>/auth/hosted?t=...`;
  - `SIGN_UPS` stays `closed` until launch: existing accounts sign in, no new ones are made, and the email form sends nothing to an address without an account (it shows the same page either way);
  - signing out is a POST; the tenant's sign-out lands on `GET /sign-out`, which offers one tap to end the platform session too;
  - `/terms` and `/privacy` (`src/legal/`): the Terms of Service and the Privacy Policy, rendered from [docs/legal/TERMS.md](../docs/legal/TERMS.md) and [docs/legal/PRIVACY.md](../docs/legal/PRIVACY.md), which the Worker bundles as text (the `Text` module rule in `wrangler.jsonc`, and a matching plugin in `vitest.config.ts`), so the Markdown is their one copy; every page's footer links both, the sign-up and sign-in pages say that continuing accepts them, and a new account records the Terms' version (its "Last updated" date) and the time (migration 0011).
- Runs the owner's admin console at `app.<domain>/admin` (B6, `src/admin/`):
  - who gets in: an account named in `PLATFORM_OWNERS` (account ids or emails, never in code), signed in with one of the passkeys pinned in `PLATFORM_OWNER_PASSKEYS` (credential ids) in the last 12 hours, and in the last 10 minutes for any change; everyone else, signed in or not, gets the ordinary 404 on every path and method, and the owner without a fresh pinned sign-in gets one tap to sign in again and come back;
  - why pinned: anyone holding the owner's inbox can sign in by email and register a passkey of their own, so only the passkeys named in config count; once one is pinned, the owner's passkeys can be added or removed only within 10 minutes of a pinned sign-in, and every account is emailed whenever a passkey is added to it;
  - the tenant list: search by address, email, tenant id or account id, filters for status, plan and setup state (paused included), counts of what needs a look, 50 a page;
  - each tenant: slug, script and D1 names, the D1 id, plan, status, version, its live `GET /__platform/health` (with its last run), usage against its limits, provisioning state with the last error, and its history from the audit log;
  - suspend (with a reason) and resume: the owner's suspension has its own columns (`owner_suspended_at`, `owner_suspended_reason`), and a tenant is suspended while either it or billing's `status` says so, so billing (B5) can never lift the owner's and the owner's resume leaves billing's state as it is; routing changes at once in the isolate that made the change (`forgetTenant`) and within 30 seconds in the others;
  - for a paused provisioning: resume it, or remove the tenant after typing its address; both run from the queue, or after the answer when there is none;
  - sign in as support: the contract's hand-off with role `support`, signed as the owner, with a reason the customer sees on their account page ("Support access"), recorded as `support.handoff_issued` before the token leaves;
  - a post whose next stop is a customer's origin (support sign-in, and an email sign-in that continues to `/open`) answers a page that goes on by GET (a meta refresh and a link), since the CSP's `form-action 'self'` blocks a post's redirect chain to another origin;
  - the audit log, newest first, filtered by tenant, actor and action prefix;
  - the waitlist: an upload (or paste) of the canonical install's CSV export (Settings > Reports > Download CSV), or the JSON of `/api/waitlist`, into `waitlist_entries`, idempotent, up to 5,000 addresses and 1 MB (enforced while reading) at a time; the platform never calls the install;
  - every change is a POST from this origin, limited to 120 an hour (support sign-ins 20), and audited with actor `owner` or `support`.
- Runs every customer's scheduler (B4, `src/scheduling.ts`), since a user Worker in a dispatch namespace has no Cron Trigger:
  - every minute the cron claims the tenants that are due and puts one message per tenant on `SCHEDULE_QUEUE` (`openping-schedule`), in rounds of 100 (one D1 batch and one `sendBatch` each), each delivered 0 to 10 seconds after the tick by tenant id so 1-minute tenants don't all start at once;
  - the due query is a range scan of a partial index (`idx_tenants_schedule_due`, migration 0005, held with `INDEXED BY`) whose WHERE leaves out tenants that aren't ready, are suspended by billing or by the owner, or are being removed, so the cron reads only the tenants due this minute (`test/scheduling.test.ts` checks the query plan and the rows read);
  - when a tenant is due is the contract's shared `nextScheduledCall` (section 6, "When to call next"), on the first minute tick at or after the time it gives: a new tenant at once; after `ran`, the tenant's `nextDueAt`, or 12 minutes after the run started when a bundle sends none; after `lease_busy`, the next tick; the platform adds only the backoff the contract allows: after `failed` or no answer, the next tick, then 2, 4, 8, at most 12 minutes while it keeps failing;
  - the claim takes a lease and names the run but leaves the due time alone; the run's last write sets the next due time and clears the claim and the lease together, so the next tick finds the tenant free however late the consumer started, and a lost message or a cron that dies after claiming leaves the tenant due, claimed again when the 3-minute queue lease runs out;
  - the consumer calls each tenant's `POST /__platform/scheduled` through the dispatch namespace with fresh props and a new call id (`callTenant`), under a timeout (40 seconds at 1-minute checks, 90 seconds otherwise) that aborts the call;
  - never two runs of one tenant at once: the claim records a run id and a lease, the consumer starts only the claimed run and only once per attempt (a conditional write), and the tenant also keeps its own lease (`lease_busy`);
  - a call is never retried through the queue: the backoff above is the retry, so a tenant is never called twice for one run; after the call, the run's bookkeeping is retried in place (3 times) when the platform database fails, and the message is acknowledged either way;
  - each run's numbers go to `scheduler_stats` (one row per tenant: the last run's outcome, platform-measured duration, queue lag, the tenant's own duration, checks, failed checks, deferred monitors, D1 queries, version, error, failures in a row, and today's totals) and, once a day per tenant, to `scheduler_days` (kept 90 days); the admin console's tenant page shows them under "Scheduler".
- Bills with Stripe (B5, `src/billing/`), in test mode until the owner says otherwise, and tested only against an in-memory Stripe (`test/fake-stripe.ts`):
  - a new tenant gets a 14-day trial with the trial plan's limits (5 monitors) and no card; on day 15 the cron's trial sweep suspends a trial with no subscription (`billing_reason` `trial_ended`), through a partial index (`idx_tenants_trial_end`, migration 0006) so paying tenants are never read;
  - `/billing` and the account page show the plan, the renewal date, and what can be done: subscribe through Stripe Checkout (the yearly plan at $24, or with 1-minute checks at $36), add 1-minute checks to a paid plan ($12, the rest of the year invoiced at once and applied only if paid: when the card is declined or the bank wants a confirmation, the customer goes straight to the invoice's payment page, the billing page shows the change waiting until Stripe drops it after about 23 hours, and the plan changes only once it is paid), or open Stripe's Customer Portal (card, invoices, cancel); `/billing/upgrade`, where a tenant's 402 answers link, leads with the next plan up;
  - Checkout runs in subscription mode for the account's own Stripe Customer (made once, with an idempotency key), with Stripe Tax on (`automatic_tax`, saving the address Checkout collects, and tax ids), and the account and tenant in the session's and the subscription's metadata;
  - `POST /stripe/webhook` checks the `Stripe-Signature` header exactly as Stripe documents for verifying by hand (HMAC-SHA256 of `t.body` with the endpoint secret, every `v1` compared in constant time, other schemes ignored, 5 minutes of tolerance), refuses an event of the wrong mode, processes each event id once (`stripe_events`; a second delivery while one is running answers 409), takes the account's billing lock (`billing_locks`; a second delivery for the same account meanwhile answers 409 and Stripe sends it again), fetches the subscription from Stripe while holding it (events can arrive in any order), and fetches it again after saving until two reads agree; every billing write checks the lock is still held, so a delivery that stalls past its lock changes nothing;
  - one paid subscription per account: Checkout takes the same lock, expires the account's previous open Checkout Session before making a new one, and refuses while a plan is paid; a second subscription that becomes active anyway is cancelled and refunded in full at once (`billing.duplicate_refunded` in the audit log), and the customer is emailed;
  - a subscription billing can't place (an account it doesn't know, or prices that aren't the two configured) is recorded as `billing.needs_attention` in the admin console's audit log; one it already knows keeps its saved plan, so a cancellation still stops checks;
  - the state machine (`src/billing/state.ts`): active or trialing is `active` (plan `hosted`, or `hosted_fast` with the add-on), `past_due` keeps checking while Stripe retries, `unpaid`, `paused` and `canceled` suspend with a reason, and incomplete subscriptions change nothing; the best of an account's subscriptions decides;
  - dunning: a failed payment emails the customer at once with Stripe's next try and a link to `/billing` (once per invoice and attempt, `billing_emails`, however often the event is delivered), and the account page shows it until it is paid; failures and payments are ordered by when they happened, so a late `payment_failed` after a later `invoice.paid` shows and sends nothing; Stripe retries on its own schedule, and after the last retry it cancels the subscription (decision D11, a Stripe setting in owner setup below), which suspends the tenant as `canceled`; the account page then offers to subscribe again;
  - billing writes only `tenants.status`, `.plan`, `.billing_reason` and `.suspended_at`, never the owner's `owner_suspended_*`, so a payment can't lift the owner's suspension; a change reaches the tenant's props on its next call (at once in the isolate that took the webhook, within 30 seconds elsewhere, and on the scheduler's next run);
  - every Stripe request pins API version `2026-09-30.endive`, and the shapes it reads are checked against Stripe's current reference (links in `src/billing/stripe.ts`).
- Ships each OpenPing release to every tenant (C1, `src/releases/`), from the bundle `npm run tenant-release` uploads to R2 ([RELEASING.md](../RELEASING.md#openping-hosted)):
  - requests come from the admin console or the command line as rows of `release_requests`, handled once each, in order, by the every-minute cron (or at once from the console);
  - before anything is touched it checks the bundle loads, its D1 migrations extend the ones tenants ran without changing any and the new ones are additive (the rule of `scripts/check-migrations.mjs`), and its Durable Object migrations extend the live ones; a failed check is a `refused` release, and a dry run records the plan and stops;
  - the canary (`RELEASE_CANARY`, the request's, or the oldest tenant) is uploaded with its escrowed `MASTER_KEY`, its database, the hosted vars and its Durable Object migrations from the tag it is at; its health must answer ok on the new version and one `POST /__platform/scheduled` must come back `ran`, and only then does `releases/current` point at the new version;
  - then batches of 50, chosen as each starts from the tenants not on the version yet (so one that finished provisioning on the old bundle meanwhile is included), each tenant health-checked up to 5 times 15 seconds apart; any failure stops the rollout for the owner to resume, skip the failures, cancel or roll back;
  - a rollback points `releases/current` back at once and re-uploads the older bundle to every tenant on another version, without a canary and past failures; one across a Durable Object migration is refused;
  - every step is in `releases` and `release_tenants` before the next starts, under a lease, so a tick that dies is picked up by the next; a tick works for up to 5 minutes beside the rest of the cron; a cancelled or replaced release loses its lease, so a run still in flight uploads and writes nothing more, and requests are handled by one handler at a time (`release_locks`);
  - a Durable Object migration's tag is recorded as pending before the upload; when a run died between the upload and the record, or the recorded tag is stale, the runner reads the script's real tag from Cloudflare and continues from it;
  - before a release is done, every tenant it made healthy is checked again, and one a raced upload left on another version is updated again (up to 3 times); `releases/current` is repaired at the end, and a rollback repairs it on every tick;
  - the console's Releases tab shows the current version, the versions in the bucket, the release in progress with its canary, batch, progress and failures, requests still waiting, and the history, and each release's page lists its tenants, failures first.
- Runs the lifecycle jobs (B7, `src/lifecycle/`) every 5 minutes from the cron, reading billing's state only through `BillingView` (`billing-view.ts`):
  - one run at a time (`lifecycle_locks`), and each list it reads leaves out the tenants it has already dealt with for that cycle, so tenants stuck at the front never starve the ones behind;
  - the account emails of `src/emails.ts`, each once (claimed as sending in `lifecycle_notices`, marked sent only once Resend took it, the claim dropped if the send fails and taken over after 10 minutes if its run died, with Resend's idempotency key): welcome when ready, the trial ending in 3 days and in 1, and suspended once per suspension, saying whether the trial ended or the payment lapsed (billing's `billing_reason`); a failed payment is billing's own email;
  - a deletion warning a week before deletion; deletion 30 days after billing suspended the tenant, and never sooner than a week after the warning went out (so mail being off delays it, never skips it);
  - before any deletion, an export of the tenant's database (D1's export API, polled, one run per export under a lease) to the `EXPORTS` bucket as `openping.sql` with `README.md`, the steps to run it as a self-hosted OpenPing, and the escrowed copy of its key kept with it in `export_keys`; the deletion waits until that export is done and reads back as the same bytes (its SHA-256), still an OpenPing dump with the same tables, with its key kept; a failed or untrustworthy export is tried again with backoff, then afresh six hours later, never skipped; deletion counts only a warning that was actually sent;
  - a payment that lands before the teardown wins: the tenant is marked for removal only while it is still suspended by that same suspension; the owner's own suspension never deletes anything;
  - exports are kept 30 days (before a deletion) or 7 (a customer's own), then their files, their kept key and their rows are deleted together (decision D12).
- Lets a customer take their OpenPing with them at `app.<domain>/account/export`: an export (one at a time, three a day), its downloads (only to its own account, with no caching), the steps, and each export's `MASTER_KEY` after a sign-in from the last 15 minutes (with a passkey, when the account has one), recorded in the audit log and emailed to the account each time it is shown; a deleted tenant's account still reaches its last export and key there while it is kept.
- Watches itself (C4, `src/observability/`, `src/log.ts`; the whole design, the monitors to create and the costs are in [OBSERVABILITY.md](../docs/hosted/OBSERVABILITY.md)):
  - every log line is one flat object, `{ event: "<area>.<what>", level, ...fields }`, so Workers Logs indexes each field; fields named like secrets are written as `"[redacted]"` at every depth and every string is scrubbed of secret-shaped values (tokens in query strings, `/hb/` paths, Bearer tokens, JWTs, Stripe, Resend and OpenPing keys, email addresses); provisioning steps, scheduler batches, billing webhooks, release steps, lifecycle emails and every mail send are logged;
  - Workers Logs is on for the platform (`observability` in `wrangler.jsonc`) and for every customer's user Worker, through each upload's metadata, at the `TENANT_LOG_SAMPLING` rate (0 to 1, 1 by default, a bad value logged and treated as 1), with invocation logs off (they record request URLs and headers, which carry secrets here) and query strings redacted; what that still records, and the staging check, are in [OBSERVABILITY.md](../docs/hosted/OBSERVABILITY.md#2-logs);
  - `GET app.<domain>/__health` answers 200 or 503 with each check as a yes or no, nothing else: the database, the cron's and the enqueue's heartbeats (`platform_heartbeats`, migration 0010; the enqueue's fails when the queue refused its batch), queue lag (the oldest due tenant's wait, new tenants included, 5 minutes at most), tenants failing 3 runs in a row (5 at most), a paused or stuck release, and whether mail, billing and provisioning are configured; one D1 batch of primary key and partial index reads, shared per Cloudflare location for 10 seconds (the Cache API) and per isolate for 15, behind the optional `HEALTH_RATE_LIMIT` binding, never a per-tenant scan; `GET /healthz` sits behind the same cache and limit;
  - the queue consumer adds each batch's runs to `scheduler_minutes` (one row per UTC minute, with duration buckets for the p95, kept 8 days) in one write, and a partial index over `scheduler_stats` holds only the failing tenants;
  - the admin console's Operations tab (`/admin/operations`) shows the same checks, runs a minute, failures, timeouts, p95 and average duration and queue lag over 15 minutes, an hour and a day, the last 24 hours by hour, and the failing and overdue tenants, worst first.
- Exposes `TenantPlatform`, the capability each customer's OpenPing receives as `props.platform` (`audit`, `reportUsage`, which keeps each tenant's latest counts in `tenant_usage` for the console, and `sendEmail`).
- Sends all its mail through one Resend account (`src/mail.ts`) from the Hosted domain, so no customer ever holds the key:
  - its own emails (`src/emails.ts`: sign-in, a new passkey, and the account emails of D2), from `MAIL_FROM`, with replies to the support address;
  - each customer's OpenPing's email through `sendEmail`, from `TENANT_MAIL_FROM` (or `MAIL_FROM`), only to the account's own email and to addresses that confirmed from a link the platform sends them first (`src/recipients.ts`, `app.<domain>/email/confirm`, on every plan), with a reply-to only to one of those, one message per recipient with Resend's idempotency key, tagged with the tenant and the category, capped at the plan's `emailsPerDay` per UTC day in `tenant_email_usage` (one statement reserves the places, so two sends can't both take the last one; a send the provider refuses gives its place back), with the contract's answers: over the cap, or when Resend's own day is spent, `email_quota_exceeded`, which the tenant holds until the next UTC midnight;
  - all of it is off while `RESEND_API_KEY` is missing or a From isn't on `HOSTED_DOMAIN`; the console's tenant page shows that tenant's emails today, failed and over the cap.

## Layout

| Path | What |
| --- | --- |
| `wrangler.jsonc` | The Worker's config, with placeholder bindings and no account or database ids |
| `migrations/` | The platform database schema (accounts, identities, tenants, subscriptions, escrowed keys, audit events, rate limits) |
| `src/index.ts` | The entry point: `fetch` and the `TenantPlatform` entrypoint |
| `src/app.ts` | Host-based routing and the tenant dispatch flow, built from injected dependencies |
| `src/dispatch.ts` | `TenantDispatcher`, the real `NamespaceDispatcher`, props, limits, header stripping and `callTenant` for platform calls |
| `src/hosts.ts` | Which part of the platform a hostname is for |
| `src/slugs.ts` | Slug rules and the reserved names |
| `src/tenants.ts` | Tenant rows, limit overrides, and the `TenantInfo` the contract hands a tenant |
| `src/capability.ts` | The platform capability, bound to one tenant |
| `src/pages.ts` | The status pages a visitor sees instead of a tenant (not found, paused, setting up, unavailable) |
| `src/ui.ts` | The HTML shell, the stylesheet in OpenPing's tokens, and the escaping `html` template |
| `src/account-routes.ts`, `src/account-pages.ts` | Sign-up, sign-in, the account page, `/start` and `/open` |
| `src/auth/` | Sessions, email codes and links, passkeys, GitHub OAuth, ceremonies and rate limits |
| `src/accounts.ts`, `src/handoff.ts` | Accounts and identities, minting hand-off tokens |
| `src/legal/` | `/terms` and `/privacy`: the bundled Markdown of `docs/legal/`, its small renderer (`markdown.ts`), and the pages |
| `src/mail.ts`, `src/emails.ts` | The Resend mailer and its settings; the platform's emails |
| `src/lifecycle/` | The lifecycle jobs: `jobs.ts` (emails, deletion), `exports.ts` (D1 exports to R2 and the steps), `account-export.ts` (`/account/export`), `billing-view.ts` (what it reads of billing), `env.ts` |
| `src/admin/` | The admin console: `owner.ts` (who may use it), `data.ts` (queries, suspend and resume), `waitlist.ts` (the import), `releases.ts` (the Releases tab), `operations.ts` (the Operations tab), `pages.ts`, `routes.ts` |
| `src/observability/` | `health.ts` (`GET /__health`, the heartbeats, the platform's state), `metrics.ts` (`scheduler_minutes`: writing and the windows) |
| `src/log.ts` | The structured, secret-free log lines |
| `src/provisioning.ts` | The provisioning state machine: `requestTenant`, `runProvisioning`, `removeTenant`, and `provisionDue` (the retry sweep) |
| `src/billing/` | Billing: `stripe.ts` (the Stripe client, pinned version), `signature.ts` (webhook signatures), `webhook.ts`, `state.ts` (the state machine and the trial sweep), `routes.ts`, `pages.ts`, `config.ts` |
| `src/scheduling.ts` | The scheduler: `enqueueDue` (the cron's claims), `handleScheduleBatch` (the queue consumer), due times, run metrics and the console's `scheduleView` |
| `src/provisioning-env.ts` | Builds provisioning's dependencies from the env, or names the settings that are missing |
| `src/cloudflare/api.ts` | `CloudflareApi`: the D1 and Workers for Platforms calls provisioning makes, with links to Cloudflare's docs |
| `src/cloudflare/http.ts` | `HttpCloudflareApi`, the real client over HTTPS |
| `src/cloudflare/upload.ts` | Uploading a user Worker: the assets manifest and buckets, then the script with its metadata |
| `src/keys.ts` | Tenant `MASTER_KEY` generation and escrow under `PLATFORM_KEY` |
| `src/bundle.ts` | The tenant bundle (one OpenPing release), its R2 layout, and `R2BundleSource`: versions, `releases/current`, each version's migrations |
| `src/releases/` | The release runner: `runner.ts` (requests, canary, batches, rollback), `checks.ts` (the additive check), `env.ts` |
| `../scripts/tenant-release.mjs` | The command line: build and upload the bundle, ask for a rollout, a rollback or a change, show the status |
| `test/` | workerd tests; `FakeDispatcher` (the dispatch namespace), `FakeCloudflareApi` (the Cloudflare API), `FakeMailer` (the outbox), `FakeR2Bucket` (the buckets) and `fakeOpenPing` (a tenant answering the internal paths) |

The contract types come from [`../src/shared/hosted-contract.ts`](../src/shared/hosted-contract.ts), shared with OpenPing.
The platform has no dependencies of its own; it uses the repository's Hono, Wrangler and test tooling.

## Running its tests

From the repository root:

```bash
npm run test:platform   # just the platform, in workerd with a local D1
npm test                # everything, the platform included (CI runs it as part of test:integration)
npm run typecheck       # includes platform/tsconfig.json
npm run lint            # includes platform/
```

The tests run with the same Cloudflare Vitest plugin as OpenPing's integration tests ([`vitest.config.ts`](./vitest.config.ts)).
The dispatch namespace and the queue exist only in a Cloudflare account, so the tests inject `FakeDispatcher` instead; the real `NamespaceDispatcher` is tested against a stand-in for the binding.
Provisioning runs against `FakeCloudflareApi`, which keeps databases, scripts and uploaded assets in memory, enforces the rules provisioning relies on, and can fail any call on demand.
`HttpCloudflareApi` is tested with a recording `fetch`, which checks every URL, header and multipart part it builds.
Sign-in runs against an in-memory outbox, a stand-in for GitHub's API, and OpenPing's software authenticator (`test/support/soft-authenticator.ts`), and `test/integration/platform-handoff.test.ts` (in the root suite) checks that a token the platform mints signs a customer in to the real OpenPing Worker.
No test makes a network request or needs a Cloudflare login.

## Scheduling costs at scale

Prices checked on 2026-10-28 in Cloudflare's docs: [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Workers for Platforms pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/platform/pricing/) and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

- Queues on Workers Paid: 1 million operations a month included, then $0.40 a million; a message under 64 KB costs 3 operations (write, read, delete), and each retry one more read.
- Workers for Platforms ($25 a month): 20 million requests and 60 million CPU ms included, then $0.30 a million requests and $0.02 a million CPU ms; CPU is charged across the dispatch chain.
- Workers Paid ($5 a month): 10 million requests and 30 million CPU ms included, the same overage prices.
- D1 on Workers Paid: 50 million rows written a month included, then $1.00 a million; an index adds a written row when a write changes the indexed column; reads cost $0.001 a million rows past 25 billion, which the scheduler never gets near.

What one run costs the platform:

| Item | Per run |
| --- | --- |
| Queue operations | 3 (one message) |
| D1 rows written in `PLATFORM_DB` | 5: the claim, the start, the finish (the row and its due-index entry), the numbers |
| Workers for Platforms requests | 1 (the call to the tenant), counted at full price to be safe |
| CPU | about 20 ms in the tenant (an assumption until the load test measures it) and about 2 ms in the platform |
| Platform Worker requests | 1/25 (consumer batches of 25) plus the cron's 43,200 a month |

A month is 43,200 minutes: a tenant with 1-minute work runs 43,200 times, one with 12-minute work 3,600 times.
CPU is 22 ms a run against the two plans' 90 million included CPU ms; the platform's own requests (the cron and the consumer batches) stay inside Workers Paid's 10 million in every row.

| Tenants | Runs a month | Queues | D1 writes | WfP requests | CPU | Total a month |
| --- | --- | --- | --- | --- | --- | --- |
| 200, all 12-minute | 0.72 million | $0.46 | $0 (3.6 million, included) | $0 | $0 | about $0.50 |
| 200, all 1-minute | 8.64 million | $9.97 | $0 (43.2 million, included) | $0 | $2.00 | about $12 |
| 2,000, all 12-minute | 7.2 million | $8.24 | $0 (36 million, included) | $0 | $1.37 | about $10 |
| 2,000, a quarter 1-minute | 27 million | $32.00 | $85.00 | $2.10 | $10.08 | about $129 |
| 2,000, all 1-minute | 86.4 million | $103.28 | $382.00 | $19.92 | $36.22 | about $541 |

These are on top of the $30 a month of fixed plan fees, and leave out each tenant's own D1 work in its own database, which the [Hosted plan's cost model](../docs/HOSTED_PLAN.md) covers.
At the margin a tenant with 12-minute work costs the scheduler about 2.5 cents a month, and one with 1-minute work about 30 cents (D1 writes 22, queue 5, requests and CPU 3), against the $1 a month the add-on brings in; a 1-minute plan whose monitors are slower costs what its work needs, since `nextDueAt` sets the cadence.
The levers, if 1-minute checks sell well: drop the start write and rely on the tenant's own lease (a fifth of the D1 writes), or carry several tenants per message (queue operations fall with the number per message), both measured in the wave 4 load test first.

## Observability costs

A health check costs nothing measurable: a checker once a minute is 43,200 platform requests, at most about 600,000 D1 rows read, no rows written and no log events a month, all inside Workers Paid's allowance.
C4 adds 86,400 heartbeat rows written a month, about one `scheduler_minutes` row per 25 runs at volume (about $3.50 a month at 2,000 tenants on 1-minute checks), and the user Workers' own log lines, the one cost that grows (about $10 to $30 a month at that size from December 1, 2026; `TENANT_LOG_SAMPLING` is the lever).
The full table is in [OBSERVABILITY.md](../docs/hosted/OBSERVABILITY.md#8-costs).

## Owner setup (not done yet)

None of these steps has been done.
Until every provisioning setting is present the cron logs which ones are missing and provisions nothing (`src/provisioning-env.ts`).
They are needed before staging in wave 3 ([build plan, section 12](../docs/HOSTED_BUILD_PLAN.md#12-owner-actions-and-costs)), and the main session runs them with the owner, never an agent.

1. **Workers Paid** ($5 a month) and **Workers for Platforms** ($25 a month) on the Cloudflare account (owner action O1).
2. **The Hosted domain** (decision D2, owner action O2): buy it, add it to Cloudflare, then set `HOSTED_DOMAIN` and add routes for `app.<domain>/*` and `*.<domain>/*` to this Worker.
3. **The dispatch namespace:** `wrangler dispatch-namespace create openping-tenants` (and `openping-tenants-staging` for staging).
4. **The platform database:** `wrangler d1 create openping-platform`, then put its id in a gitignored local config (as `deploy.local.json` does for OpenPing), and apply `migrations/` with `wrangler d1 migrations apply PLATFORM_DB --remote`.
5. **The queues:** `wrangler queues create openping-provision` (provisioning) and `wrangler queues create openping-schedule` (the scheduler, B4); this Worker consumes both (`queues.consumers` in `wrangler.jsonc`).
   For staging, `openping-provision-staging` and `openping-schedule-staging`: the consumer routes by the queue name's prefix.
6. **The bundle bucket:** `wrangler r2 bucket create openping-tenant-bundles` (and `openping-tenant-bundles-staging`); `npm run tenant-release -- build` then `upload` puts each release there in the layout `src/bundle.ts` describes, and the first `start` makes it current, before the first sign-up ([RELEASING.md](../RELEASING.md#openping-hosted)).
   Set `RELEASE_CANARY` in `wrangler.jsonc` to the owner's own test tenant once it exists, so every rollout tries it first.
7. **The exports bucket:** `wrangler r2 bucket create openping-tenant-exports` (and `-staging`), private (no public access, no custom domain); the API token also needs D1 export, which **Account, D1, Edit** covers (confirm in staging: Cloudflare's docs don't name the permission).
   As a backstop for the platform's own expiry, add a lifecycle rule: `wrangler r2 bucket lifecycle add openping-tenant-exports exports-backstop exports/ --expire-days 40`, longer than the longest keep time (30 days) plus a deletion's delays.
8. **Mail and GitHub for sign-in:** verify `HOSTED_DOMAIN` (or a subdomain of it, such as `mail.<domain>`) as a sending domain in Resend, with its SPF, DKIM and DMARC records in Cloudflare DNS; set `MAIL_FROM` (for example `OpenPing Hosted <signin@<domain>>`) and `TENANT_MAIL_FROM` (for example `OpenPing <alerts@<domain>>`), both on that domain; make the Resend API key with **Sending access** to that domain only; create a GitHub OAuth app with the callback `https://app.<domain>/auth/github/callback` and set `GITHUB_CLIENT_ID`; set `SIGN_UPS` to `open` at launch.
9. **Secrets**, with `wrangler secret put` from the owner's machine and a copy of each in the password manager:
   - `HANDOFF_SIGNING_KEY`: the hand-off private key; `generateHandoffKeyPair()` in the contract makes the pair, and the public half goes in the `HANDOFF_PUBLIC_KEY` var in `wrangler.jsonc`, which provisioning copies to every tenant (O6);
   - `PLATFORM_KEY`: 32 random bytes in base64 (`openssl rand -base64 32`), encrypts the escrowed tenant keys (decision D4, O6); losing it means no tenant backup can be restored;
   - `CF_ACCOUNT_ID`: the account's 32 hex character id, a secret only to keep it out of this public config;
   - `CF_API_TOKEN`: a custom API token for that one account with **Account, Workers Scripts, Edit** and **Account, D1, Edit**, nothing else (O5); the dispatch namespace's scripts are Workers Scripts;
   - `RESEND_API_KEY` and `GITHUB_CLIENT_SECRET`, for sign-in;
   - `STRIPE_SECRET_KEY` (a test-mode secret or restricted key, `sk_test_...` or `rk_test_...`) and `STRIPE_WEBHOOK_SECRET` (`whsec_...`, from step 10), in test mode first (O3);
   - `PLATFORM_OWNERS`, if it names the owner by email rather than by account id (otherwise the var in `wrangler.jsonc`).
   The owner signs in once and adds a passkey on the account page, then opens `/admin`: the "Confirm it's you" page lists the account's passkeys with their credential ids.
   They copy the id of the passkey they hold (and check there is none they don't recognise) into `PLATFORM_OWNER_PASSKEYS`, then sign in with that passkey.
   Their account id then appears in the console's audit log (`by: acc_...` on each of their changes), and can replace the email in the public var.
10. **Support address:** support@n8builds.dev, decided; forward it with Cloudflare Email Routing (O4).
11. **Stripe, in test mode** (owner action O3), in the Stripe dashboard:
    - two Products with yearly recurring Prices in USD: "OpenPing Hosted" at $24.00 and "1-minute checks" at $12.00, each with tax behavior "exclusive" and the tax code for software as a service; put their `price_...` ids in `STRIPE_PRICE_HOSTED` and `STRIPE_PRICE_FAST`;
    - Stripe Tax: turn it on, set the business's origin address, and add a registration wherever the business must collect tax (Stripe's dashboard lists where sales cross a threshold); `STRIPE_TAX` stays `on`;
    - the Customer Portal: allow updating the payment method, viewing invoices, and cancelling at the end of the period; leave subscription updates (plan switching) off, since the add-on is added from `/billing`; if they are ever turned on, list only the two prices above as products customers may switch between, since a subscription on any other price is held for the owner (`billing.needs_attention`); its default configuration is used unless `STRIPE_PORTAL_CONFIGURATION` names another;
    - failed payments (Billing settings, "Manage failed payments"): Smart Retries on, and after the last retry choose **"cancel the subscription"** (decision D11, [DECISIONS.md](../docs/hosted/DECISIONS.md)); Stripe then sends `customer.subscription.deleted`, the tenant is suspended by billing as `canceled`, its checks stop, and decision D8's 30 days of retention apply; the customer subscribes again from their account page; Stripe's own customer emails for failed payments can stay on alongside the platform's;
    - a webhook endpoint at `https://app.<domain>/stripe/webhook`, snapshot payload, API version `2026-09-30.endive`, with the ten events in `WEBHOOK_EVENTS` (`src/billing/webhook.ts`, including `customer.subscription.pending_update_applied` and `customer.subscription.pending_update_expired`); its signing secret is `STRIPE_WEBHOOK_SECRET`;
    - at launch: the same in live mode with live keys and prices, and `STRIPE_MODE` set to `live` (owner action O8).
12. **Monitoring and the public status page** (C4), once staging answers: on the owner's install, the category, the five monitors and the `hosted` status page of [OBSERVABILITY.md](../docs/hosted/OBSERVABILITY.md#5-alerting-the-monitors-to-create), with an API token from its Developers page; the canary tenant's status page turned on; a WAF rate limiting rule on `/__health` and `/healthz` ([section 3](../docs/hosted/OBSERVABILITY.md#3-the-health-endpoint)); the staging check that no secret reaches Workers Logs ([section 2](../docs/hosted/OBSERVABILITY.md#2-logs)); and three UptimeRobot monitors (free plan) as the outside checker ([section 7](../docs/hosted/OBSERVABILITY.md#7-the-outside-checker)).
