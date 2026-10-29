# OpenPing Hosted platform Worker

This is the platform Worker for OpenPing Hosted: the code that owns customers rather than monitoring.
It is planned in [the build plan](../docs/HOSTED_BUILD_PLAN.md), and it talks to each customer's OpenPing only through [the contract](../docs/hosted/CONTRACT.md).

**Status: skeleton (B1), provisioning (B3), accounts (B2), the admin console (B6) and scheduling (B4), not deployed anywhere.**
Nothing here has been created in a Cloudflare account yet; see [Owner setup](#owner-setup-not-done-yet).

## What it does today

- Routes by hostname, with the domain taken from the `HOSTED_DOMAIN` var (decision D2, [DECISIONS.md](../docs/hosted/DECISIONS.md)):
  - `app.<domain>`: the platform's own pages (sign-up, sign-in, the account) and `GET /healthz`;
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
  - choosing an address (`/start`) creates the tenant (one per account, enforced by a unique index) and queues its provisioning;
  - `/open?tenant=<slug>` mints the Ed25519 hand-off (`src/handoff.ts`, only the contract's helpers) and redirects to `https://<slug>.<domain>/auth/hosted?t=...`;
  - `SIGN_UPS` stays `closed` until launch: existing accounts sign in, no new ones are made, and the email form sends nothing to an address without an account (it shows the same page either way);
  - signing out is a POST; the tenant's sign-out lands on `GET /sign-out`, which offers one tap to end the platform session too.
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
  - every minute the cron claims the tenants that are due and puts one message per tenant on `SCHEDULE_QUEUE` (`openping-schedule`), in rounds of 100 (one D1 batch and one `sendBatch` each);
  - the due query is a range scan of a partial index (`idx_tenants_schedule_due`, migration 0005) whose WHERE leaves out tenants that aren't ready, are suspended by billing or by the owner, or are being removed, so the cron reads only the tenants due this minute (`test/scheduling.test.ts` checks the query plan and the rows read);
  - when a tenant is due follows the contract's "When to call next" (section 6), on minute ticks: a new tenant at once (its next run spread over its interval by its id); after a run that answered `ran` with `nextDueAt`, the tick at or just before it (the tenant checks what is due within 30 seconds of a call), never more than 12 minutes on; after `ran` without `nextDueAt` (a bundle older than the field), every `minIntervalMinutes` of its effective limits (12 minutes on the trial and the yearly plan, 1 minute with fast checks, or a per-tenant override), keeping its phase; after `lease_busy`, the next tick; after `failed` or no answer, the next tick, then 2, 4, 8 minutes while it keeps failing, never slower than its interval;
  - the claim records the interval's next tick, and the consumer writes the due time again only when the run moved it to another tick, so a tenant whose work matches its plan costs no extra write;
  - the consumer calls each tenant's `POST /__platform/scheduled` through the dispatch namespace with fresh props and a new call id (`callTenant`), under a timeout (40 seconds at 1-minute checks, 90 seconds otherwise) that aborts the call;
  - never two runs of one tenant at once: the claim records a run id and a lease, the consumer starts only the claimed run and only once per attempt (a conditional write), and the run's lease (timeout plus 10 seconds) is shorter than the interval, so it is never released by hand; the tenant also keeps its own lease (`lease_busy`);
  - a call that gets no answer (an error, a status other than 200, a timeout, a missing script) is retried through the queue after 15, 60 and 180 seconds, only while the retry can finish before the tenant's next run, which is the retry otherwise; a run the tenant answers as `failed` is not retried;
  - each run's numbers go to `scheduler_stats` (one row per tenant: the last run's outcome, platform-measured duration, queue lag, the tenant's own duration, checks, failed checks, deferred monitors, D1 queries, version, error, failures in a row, and today's totals) and, once a day per tenant, to `scheduler_days` (kept 90 days); the admin console's tenant page shows them under "Scheduler".
- Exposes `TenantPlatform`, the capability each customer's OpenPing receives as `props.platform` (`audit` and `reportUsage` are real, the latter keeping each tenant's latest counts in `tenant_usage` for the console; `sendEmail` is a stub until A5).

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
| `src/accounts.ts`, `src/mail.ts`, `src/handoff.ts` | Accounts and identities, the Resend mailer, minting hand-off tokens |
| `src/admin/` | The admin console: `owner.ts` (who may use it), `data.ts` (queries, suspend and resume), `waitlist.ts` (the import), `pages.ts`, `routes.ts` |
| `src/provisioning.ts` | The provisioning state machine: `requestTenant`, `runProvisioning`, `removeTenant`, and `provisionDue` (the retry sweep) |
| `src/scheduling.ts` | The scheduler: `enqueueDue` (the cron's claims), `handleScheduleBatch` (the queue consumer), due times, run metrics and the console's `scheduleView` |
| `src/provisioning-env.ts` | Builds provisioning's dependencies from the env, or names the settings that are missing |
| `src/cloudflare/api.ts` | `CloudflareApi`: the D1 and Workers for Platforms calls provisioning makes, with links to Cloudflare's docs |
| `src/cloudflare/http.ts` | `HttpCloudflareApi`, the real client over HTTPS |
| `src/cloudflare/upload.ts` | Uploading a user Worker: the assets manifest and buckets, then the script with its metadata |
| `src/keys.ts` | Tenant `MASTER_KEY` generation and escrow under `PLATFORM_KEY` |
| `src/bundle.ts` | The tenant bundle (one OpenPing release) and where provisioning reads it from (R2, written by the release runner) |
| `test/` | workerd tests; `FakeDispatcher` (the dispatch namespace), `FakeCloudflareApi` (the Cloudflare API) and `fakeOpenPing` (a tenant answering the internal paths) |

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
| D1 rows written in `PLATFORM_DB` | 4: the claim (the row and its due-index entry), the start, the numbers; 2 more when the run moves the next one to another tick than the plan's interval |
| Workers for Platforms requests | 1 (the call to the tenant), counted at full price to be safe |
| CPU | about 20 ms in the tenant (an assumption until the load test measures it) and about 2 ms in the platform |
| Platform Worker requests | 1/25 (consumer batches of 25) plus the cron's 43,200 a month |

A month is 43,200 minutes: a 1-minute tenant runs 43,200 times, a 12-minute tenant 3,600 times.
CPU is 22 ms a run against the two plans' 90 million included CPU ms; the platform's own requests (the cron and the consumer batches) stay inside Workers Paid's 10 million in every row.

| Tenants | Runs a month | Queues | D1 writes | WfP requests | CPU | Total a month |
| --- | --- | --- | --- | --- | --- | --- |
| 200, all 12-minute | 0.72 million | $0.46 | $0 (2.9 million, included) | $0 | $0 | about $0.50 |
| 200, all 1-minute | 8.64 million | $9.97 | $0 (34.6 million, included) | $0 | $2.00 | about $12 |
| 2,000, all 12-minute | 7.2 million | $8.24 | $0 (28.8 million, included) | $0 | $1.37 | about $10 |
| 2,000, a quarter 1-minute | 27 million | $32.00 | $58.00 | $2.10 | $10.08 | about $102 |
| 2,000, all 1-minute | 86.4 million | $103.28 | $295.60 | $19.92 | $36.22 | about $455 |

These are on top of the $30 a month of fixed plan fees, and leave out each tenant's own D1 work in its own database, which the [Hosted plan's cost model](../docs/HOSTED_PLAN.md) covers.
At the margin a 12-minute tenant costs the scheduler about 2 cents a month, and a 1-minute tenant about 26 cents (D1 writes 17, queue 5, requests and CPU 4), against the $1 a month the add-on brings in.
The levers, if 1-minute checks sell well: drop the start write and rely on the tenant's own lease (a quarter of the D1 writes), or carry several tenants per message (queue operations fall with the number per message), both measured in the wave 4 load test first.

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
6. **The bundle bucket:** `wrangler r2 bucket create openping-tenant-bundles`; the release runner (C1) writes each release there in the layout `src/bundle.ts` describes.
7. **Mail and GitHub for sign-in:** verify a sending domain in Resend and set `MAIL_FROM`; create a GitHub OAuth app with the callback `https://app.<domain>/auth/github/callback` and set `GITHUB_CLIENT_ID`; set `SIGN_UPS` to `open` at launch.
8. **Secrets**, with `wrangler secret put` from the owner's machine and a copy of each in the password manager:
   - `HANDOFF_SIGNING_KEY`: the hand-off private key; `generateHandoffKeyPair()` in the contract makes the pair, and the public half goes in the `HANDOFF_PUBLIC_KEY` var in `wrangler.jsonc`, which provisioning copies to every tenant (O6);
   - `PLATFORM_KEY`: 32 random bytes in base64 (`openssl rand -base64 32`), encrypts the escrowed tenant keys (decision D4, O6); losing it means no tenant backup can be restored;
   - `CF_ACCOUNT_ID`: the account's 32 hex character id, a secret only to keep it out of this public config;
   - `CF_API_TOKEN`: a custom API token for that one account with **Account, Workers Scripts, Edit** and **Account, D1, Edit**, nothing else (O5); the dispatch namespace's scripts are Workers Scripts;
   - `RESEND_API_KEY` and `GITHUB_CLIENT_SECRET`, for sign-in;
   - `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, in test mode first (O3);
   - `PLATFORM_OWNERS`, if it names the owner by email rather than by account id (otherwise the var in `wrangler.jsonc`).
   The owner signs in once and adds a passkey on the account page, then opens `/admin`: the "Confirm it's you" page lists the account's passkeys with their credential ids.
   They copy the id of the passkey they hold (and check there is none they don't recognise) into `PLATFORM_OWNER_PASSKEYS`, then sign in with that passkey.
   Their account id then appears in the console's audit log (`by: acc_...` on each of their changes), and can replace the email in the public var.
9. **Support address:** support@n8builds.dev, decided; forward it with Cloudflare Email Routing (O4).
