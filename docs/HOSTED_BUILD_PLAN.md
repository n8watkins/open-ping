# OpenPing Hosted: the build plan

Status: building, 2026-10-28.
Done: C0 (contract) and B1 (platform skeleton) in #40; A1 (hosted mode switch) and A2 (hand-off sign-in) in #44; the contract itself is [docs/hosted/CONTRACT.md](./hosted/CONTRACT.md).
Done: C2 (batched check writes) in #46; the measurements are in [FREE_TIER.md](./FREE_TIER.md#d1-round-trips-per-run-before-and-after-batching).
The owner decided on 2026-10-28 to start building Hosted now instead of waiting for the waitlist gate (about 20 sign-ups by about 2026-12-23).
The waitlist keeps running; it becomes the launch list.
The offer, the prices and the cost model stay as in [the Hosted plan](./HOSTED_PLAN.md); this document is how to build it, in what order, and what can run at the same time.

## Contents

1. [What we are building](#1-what-we-are-building)
2. [Facts checked before planning](#2-facts-checked-before-planning)
3. [Architecture](#3-architecture)
4. [Decisions, with recommendations](#4-decisions-with-recommendations)
5. [The contract between the platform and a customer's OpenPing](#5-the-contract-between-the-platform-and-a-customers-openping)
6. [Workstreams](#6-workstreams)
7. [Waves: what runs in parallel](#7-waves-what-runs-in-parallel)
8. [How the agents work without stepping on each other](#8-how-the-agents-work-without-stepping-on-each-other)
9. [Testing and staging](#9-testing-and-staging)
10. [Security and abuse](#10-security-and-abuse)
11. [Operations: releases, migrations, backups, support](#11-operations-releases-migrations-backups-support)
12. [Owner actions and costs](#12-owner-actions-and-costs)
13. [Risks and how we would know](#13-risks-and-how-we-would-know)
14. [Definition of done for launch](#14-definition-of-done-for-launch)

## 1. What we are building

A customer goes to the Hosted sign-up page, signs in with an email link, a passkey or GitHub, and within a minute has their own OpenPing: the same dashboard, monitors, alerts and status pages as a self-hosted install, at an address like `acme.<hosted-domain>`.
They never see Cloudflare, keys or a setup token.
They get a 14-day trial with small limits and no card, then pay $24 a year (plus $12 a year for 1-minute checks).

Under the hood every customer is still a separate OpenPing: their own Worker and their own D1 database, in a Cloudflare dispatch namespace in the owner's account.
No customer can reach another customer's data, and the code each customer runs is the same code self-hosters run, built in a "hosted" mode.

What stays true for self-hosters: nothing changes for them.
Hosted mode is off unless the platform turns it on, and every feature still works in a plain install.

## 2. Facts checked before planning

Checked against Cloudflare's documentation on 2026-10-28.

- **Isolation:** each user Worker in a dispatch namespace can only use the bindings attached to it; a unique D1 database per user Worker gives full isolation ([Workers for Platforms bindings](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/bindings/)).
- **Scale:** Workers for Platforms has no script limit ([limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/limits/)); D1's database count per account can be raised on Workers Paid "to millions" ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)).
- **Missing in user Workers:** `caches.default` is disabled and `request.cf` is hidden unless the namespace is in trusted mode ([limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/limits/)).
  OpenPing uses neither (checked: no `caches.default`, `caches.open` or `request.cf` in `src/worker`).
- **No cron in user Workers:** user Workers in a namespace can't have their own Cron Triggers (workers-sdk issue #13840, noted in the Hosted plan), so the platform must trigger each customer's scheduler.
- **No gradual deployments for user Workers:** an upload goes to 100% at once ([limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/limits/)), so the release runner does its own canary and batching.
- **First uploads are synchronous:** a 200 from the upload API means the user Worker is ready to serve ([changelog, 2025-02-20](https://developers.cloudflare.com/changelog/post/2025-02-20-synchronous-uploads/)), which makes sign-up-to-dashboard in under a minute realistic.
- **Static assets per user Worker** are uploaded through an assets upload session on the namespace script ([direct upload](https://developers.cloudflare.com/workers/static-assets/direct-upload/)); files are deduplicated by hash, so the SPA is effectively uploaded once.
- **Per-customer limits:** the dispatch Worker can cap CPU time and subrequests per call ([custom limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/custom-limits/)).
- **Per-request capabilities:** the dispatch Worker can pass props and RPC stubs into a user Worker per request ([dynamic dispatch](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/dynamic-dispatch/)), which is how a customer's OpenPing can ask the platform for its plan without a network call or a shared secret on the wire.
- **Certificates:** Universal SSL covers the apex and one level of subdomain only; `*.app.example.com` needs Advanced Certificate Manager ($10 a month) or Total TLS ([Universal SSL limitations](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/)).
  `acme.<hosted-domain>` on a domain of its own is covered for free.
- **Outbound TCP to Cloudflare IPs is blocked** for every Worker, hosted or not (measured on 2026-10-28, see [the SSL spike](./SSL_EXPIRY_SPIKE.md)); this affects TCP and future certificate monitors equally on both paths.

## 3. Architecture

```
                         visitors / customers
                                  |
              *.<hosted-domain>   |   app.<hosted-domain>
                                  v
  +------------------------------------------------------------------+
  | platform Worker  (openping-platform, Workers Paid)                |
  |  - routes app.<hosted-domain>: sign-up, sign-in, account, billing |
  |  - routes <slug>.<hosted-domain>: dispatch to the customer        |
  |  - Stripe webhooks, admin console, abuse controls                 |
  |  - cron every minute: enqueue due customers                       |
  |  - queue consumer: run each customer's scheduler                  |
  |  bindings: PLATFORM_DB (D1), TENANTS (dispatch namespace),        |
  |            SCHEDULE_QUEUE (Queue), CF_API_TOKEN, STRIPE_*,        |
  |            PLATFORM_KEY (encrypts escrowed tenant keys)           |
  +------------------------------------------------------------------+
         | env.TENANTS.get("t_acme", { props }, { limits })
         v
  +---------------------------+   +---------------------------+
  | user Worker t_acme        |   | user Worker t_bravo       |  ... one per customer
  | OpenPing, HOSTED_MODE=1   |   | OpenPing, HOSTED_MODE=1   |
  | DB -> D1 openping-t_acme  |   | DB -> D1 openping-t_bravo |
  | MASTER_KEY (its own)      |   | MASTER_KEY (its own)      |
  | assets: the OpenPing SPA  |   | assets: the OpenPing SPA  |
  +---------------------------+   +---------------------------+
```

The pieces:

- **The platform Worker** is new code in this repository, in `platform/`.
  It owns everything that is about customers rather than monitoring: accounts, sign-up, billing, provisioning, routing, scheduling, releases and the owner's admin console.
- **The platform database** (`PLATFORM_DB`) holds accounts, sign-in methods, tenants (slug, script name, D1 id, status, plan, version), subscriptions, the escrowed tenant keys, audit events, and rate-limit counters.
  It never holds monitoring data.
- **A customer's OpenPing** is today's OpenPing built with hosted mode, uploaded as a user Worker named `t-<id>` (from the permanent tenant id, never the slug, which can be renamed), with its own D1 database, its own `MASTER_KEY`, and no `SETUP_TOKEN`, GitHub app or Resend key of its own.
- **Scheduling:** the platform's cron runs every minute and puts each due customer on a Queue; the queue consumer calls each customer's scheduler through the namespace, building fresh props (and a fresh platform capability) for every call, since an RPC stub in props only lives for the request that received it.
  One message per customer means one slow or broken customer can't delay the others, and Queues retry on failure.
- **Email:** the platform owns one Resend account and one verified sending domain; a customer's OpenPing sends email through a platform capability (an RPC stub passed in props), so no customer holds the Resend key and the platform can cap sends per customer.

## 4. Decisions, with recommendations

Each one is the owner's call; the plan assumes the recommendation until told otherwise.

| # | Decision | Recommendation | Why |
| --- | --- | --- | --- |
| D1 | Start before the waitlist gate | Yes (decided 2026-10-28) | The owner's call; the waitlist becomes the launch list. |
| D2 | Hosted address | Buy a short dedicated domain now (about $10 to $15 a year) and use `app.<domain>` and `<slug>.<domain>`; keep `app.openping.n8builds.dev` as a redirect | Free wildcard certificate, customer cookies never share a parent domain with the owner's portfolio, and it is the stage 5 rename done early. The alternative, `<slug>.app.openping.n8builds.dev`, needs Advanced Certificate Manager at $10 a month and puts every customer under the portfolio domain. |
| D3 | Customer sign-in | One platform account per customer (email link with a 6-digit code, passkey, GitHub), and the customer's OpenPing trusts a short-lived signed hand-off from the platform | One account across devices and billing, no second sign-up inside their OpenPing, and the existing passkey and magic-link code is reused. Google sign-in after launch (landing plan section 3). |
| D4 | Who holds each customer's `MASTER_KEY` | The platform generates it, sets it as the user Worker's secret, and keeps a copy encrypted with `PLATFORM_KEY` | Needed to restore a customer's backup and to rotate keys; the copy is useless without `PLATFORM_KEY`, which lives only as a platform secret and in the owner's password manager. |
| D5 | Prices and trial | Keep the Hosted plan: $24 a year, $12 a year for 1-minute checks, 14-day trial with 5 monitors and no card | Already researched; break-even about 20 to 25 customers. |
| D6 | Custom domains for customers' status pages | After launch, with Cloudflare for SaaS | Not needed to launch; the default `<slug>.<domain>/status` works. |
| D7 | Second-region confirmation | Build in parallel, ship when measured | It improves both paths and is independent of everything else. |
| D8 | Cancelled or unpaid accounts | Checks stop at once, data kept 30 days with an export link, then the Worker and database are deleted | Matches the Hosted plan and keeps costs bounded. |
| D9 | Legal | Short plain-English terms and privacy policy drafted by an agent, reviewed by the owner; a lawyer only if revenue justifies it | A $24 product; the terms must forbid monitoring sites the customer doesn't own or operate. |

## 5. The contract between the platform and a customer's OpenPing

This is written and merged first (wave 1, item C0), because every workstream builds against it.
It lives in `docs/hosted/CONTRACT.md` with TypeScript types in `src/shared/hosted-contract.ts`, imported by both sides.

- **Hosted mode:** the user Worker runs with `HOSTED_MODE = "1"` and a `TENANT_ID`.
  In hosted mode OpenPing:
  - hides and refuses `/setup`, `/recover`, the setup token and the GitHub OAuth configuration;
  - signs in only through the platform hand-off (section below) and the customer's own passkeys;
  - takes its plan limits from the platform (below) instead of `WORKERS_PLAN`;
  - sends email through the platform's mail capability;
  - shows "Managed by OpenPing Hosted" in Settings, with links to the account and billing pages;
  - keeps every other feature identical.
- **Props passed on every dispatched request** (`env.TENANTS.get(name, { props })`):
  - `tenant`: id, slug, status (`trial`, `active`, `past_due`, `suspended`), plan, limits;
  - `platform`: an RPC stub with `sendEmail(message)`, `reportUsage(counts)`, `audit(event)`.
  Props are set by the platform for each call, so a customer's code can't forge them.
- **Sign-in hand-off:** the platform redirects a signed-in customer to `https://<slug>.<domain>/auth/hosted?t=<token>`.
  The token is a single-use, 60-second, Ed25519-signed statement (tenant id, account id, email, nonce); the user Worker checks it with the platform's public key (a plain var) and creates its normal session.
  Replay is blocked by storing used nonces until they expire.
- **Scheduler entry:** the queue consumer calls `POST /__platform/scheduled` on the user Worker with a header the dispatch Worker adds and strips from public traffic; the user Worker runs exactly what its `scheduled()` handler runs today and returns the run summary (checks, failures, D1 queries, duration) for platform metrics.
- **Self-migration:** the user Worker carries its migrations in the bundle and applies any missing ones, under a lock, at the start of the first scheduled run or request after an update; `GET /__platform/health` reports version, schema version and last run.
- **Limits enforcement:** the monitor, status page and channel create routes check the limits in props (20 monitors, 2 status pages, 12 or 1 minute) and answer 402 with a plain message and an upgrade link.

## 6. Workstreams

Each workstream is a piece one agent (or the owner) can own end to end.
Sizes: S is under a day of agent work, M one to two days, L three or more.
"Needs" lists what must be merged first; anything without a "needs" can start at once.

### A. Hosted mode in OpenPing (`src/`)

- [x] **A1 Hosted mode switch (M), done.** `HOSTED_MODE`, `TENANT_ID`, props typing, the "managed" UI states; `/setup` and `/recover` refuse; tests that a plain install is unchanged. Needs: C0.
- [x] **A2 Hand-off sign-in (M), done.** `/auth/hosted`, Ed25519 verification with Web Crypto, nonce store (migration), session creation, sign-out back to the platform. Needs: C0.
- **A3 Platform scheduler entry and self-migration (M).** `/__platform/scheduled`, `/__platform/health`, bundled migrations with a lock and a schema version. Needs: C0.
- **A4 Plan limits (S).** 402 responses with an upgrade link on create routes, UI states, and the budget profile for hosted plans. Needs: C0.
- **A5 Mail through the platform (S).** A mail transport interface with today's Resend sender and a platform-capability sender. Needs: C0.

### B. The platform Worker (`platform/`)

- [x] **B1 Skeleton (M), done in #40.** Workspace layout, its own `wrangler.jsonc`, Hono app, platform D1 schema and migrations, host-based routing (`app.` versus `<slug>.`), dispatch with custom limits, 404 and suspended pages, tests with a fake namespace. Needs: C0.
- **B2 Accounts and sign-in (L).** Email link plus code (reusing the magic-link code), passkeys (reusing `src/worker/lib/webauthn.ts`), GitHub OAuth, sessions, rate limits, the account page, issuing hand-off tokens. Needs: B1.
- [x] **B3 Provisioning (L), done.** A Cloudflare API client (create and delete D1, upload a user Worker with assets, bindings, secrets and tags, delete it), the provisioning state machine (`requested`, `db_created`, `uploaded`, `migrated`, `ready`, with retry and clean rollback), slug rules and reserved names, and a fake API for tests. Needs: B1 for wiring; the client itself can start with C0.
  The tenant's migrations run through the contract's `POST /__platform/scheduled` (A3); the bundle comes from an R2 bucket the release runner (C1) fills.
  Runs are driven by a Queue with the cron as a net; a permanent failure, or too many in a row, pauses the tenant for the owner instead of rolling it back, and `removeTenant` is the clean teardown.
- **B4 Scheduling (M).** Cron every minute, due calculation from each tenant's interval, Queue producer and consumer, per-tenant timeouts, run metrics in the platform database. Needs: B1, A3.
- **B5 Billing (L).** Stripe Checkout (yearly plan and the add-on), the Customer Portal, the signed webhook, subscription state, dunning (past due, suspended), trial end, Stripe Tax, plan changes reaching the tenant props. Needs: B1.
- **B6 Owner's admin console (M).** Tenant list and search, status, plan, version, last run, usage, suspend and resume, impersonate-for-support with an audit trail, waitlist import. Needs: B1.
- **B7 Lifecycle jobs (M).** Trial ending emails, suspension, 30-day deletion with an export first, tenant export to a self-host bundle (D1 export plus instructions). Needs: B3, B5.

### C. Shared and cross-cutting

- **C0 The contract (S, first).** Section 5 as a document and as shared types, plus the decision record for D2 to D4. Needs: nothing.
- **C1 Release runner (M).** Build the tenant bundle once per release, upload it to a canary tenant, check `/__platform/health`, then roll out in batches with stop-on-error and a one-command rollback to the previous bundle. Needs: B3, A3.
- **C2 Batched check writes (M, Hosted stage 2). Done in #46.** One D1 write per run instead of about 3 per check; measured. Helps self-hosters too. Needs: nothing.
- **C3 Second-region confirmation (M, Hosted stage 2).** A Durable Object per region with a location hint, used by the existing confirm step; measured on a throwaway deployment. Needs: nothing. Built and measured; see [SECOND_REGION.md](./SECOND_REGION.md). A Hosted tenant bundle needs the `REGION_PROBE` binding and its migration when B3 uploads it, or it confirms where the check ran.
- **C4 Observability (M).** Workers Logs on the platform and namespace, per-tenant run metrics, an external monitor of the platform itself (a separate OpenPing install on a different account, plus one outside checker), and a public status page for OpenPing Hosted. Needs: B1, B4.

### D. Product, content and launch

- **D1 Landing and pricing (M).** The hero's Hosted card becomes "Start a free trial"; pricing, FAQ and comparison updated; sign-up and sign-in pages styled like the app. Needs: B2 for the live links; copy can start at once.
- **D2 Emails (S).** Welcome, sign-in code, trial ending (3 days and 1 day), receipt (Stripe), payment failed, suspended, deletion warning. Needs: nothing for the templates.
- **D3 Terms and privacy (M).** Plain-English drafts, the acceptable-use rule, data retention, sub-processors (Cloudflare, Stripe, Resend). Needs: nothing; owner review before launch.
- **D4 Docs (S).** Hosted FAQ, "move from Hosted to self-hosted" and back. Needs: B7.
- **D5 Launch (S).** Email the waitlist with early pricing, open sign-up, announce. Needs: everything in the launch definition (section 14).

## 7. Waves: what runs in parallel

At most three agents run at once on this machine (memory), each in its own worktree; the owner's items run alongside every wave.
Each wave ends when its PRs are merged and `main` is green.

```
wave 0 (owner, now)      O1 accounts/plan  O2 domain  O3 Stripe  O4 support address
                         |
wave 1                   C0 contract ──┬──> A1 hosted mode ──┐
(about 2 days)           C2 batched    │                     │
                         writes        └──> B1 platform skel ┤
                         D2/D3 drafts (content agent)        │
                                                             v
wave 2                   A2 hand-off   B3 provisioning   C3 second region
(about 4 days)           A3 sched+migr B2 accounts        D1 copy
                         A4 limits     B6 admin console
                         A5 mail
                                                             v
wave 3                   B4 scheduling   B5 billing   C1 release runner
(about 4 days)           B7 lifecycle    C4 observability
                                                             v
wave 4                   staging soak: 5 test customers for 7 days,
(7 days, mostly          security review, load test (200 fake tenants),
 waiting)                restore drill, owner review of legal pages
                                                             v
wave 5 (1 day)           launch to the waitlist (D5), then public
```

Lanes inside each wave, three agents at a time:

| Wave | Lane 1 (`src/`, hosted mode) | Lane 2 (`platform/`) | Lane 3 (independent) |
| --- | --- | --- | --- |
| 1 | C0 contract, then A1 | B1 skeleton (starts when C0 merges, half a day in) | C2 batched writes; D2 and D3 drafts |
| 2 | A2, then A3, then A4 and A5 | B3 provisioning, then B2 accounts | C3 second region; B6 admin console; D1 copy |
| 3 | A fixes from integration | B4 scheduling, then B5 billing | C1 release runner, then B7 lifecycle, then C4 |
| 4 | bug fixes | bug fixes | soak, load test, restore drill |

The critical path is C0, B1, B3, B4, C1 and the soak; everything else fits around it.
With three lanes the build is about 10 working days of agent time plus the 7-day soak, so about three weeks from the owner's wave 0 items.

## 8. How the agents work without stepping on each other

- **One owner per directory.** Lane 1 owns `src/` (except `src/shared/hosted-contract.ts`, which only changes through a contract PR), lane 2 owns `platform/`, lane 3 owns its feature's files; anything else goes in a separate small PR.
- **Contract first, then code.** A change to the contract is its own PR that both lanes rebase on.
- **Fakes for anything remote.** The Cloudflare API, Stripe and the dispatch namespace each get an in-memory fake with the same interface, so all tests run locally and no agent needs production credentials.
- **No remote commands from agents.** Agents never run remote Wrangler, deploy, or Stripe live-mode commands; the main session runs staging and production steps after review, as today.
- **Same rules as today:** Conventional Commits with user-facing subjects, squash merges with a subject of 100 characters or fewer, tests and lint green before a PR, worktrees and branches removed after merge.

## 9. Testing and staging

- **Unit and integration tests** for both Workers, with the platform's integration tests running a real OpenPing build as the "user Worker" behind the fake namespace, so the contract is tested end to end on every PR.
- **Staging** is a second dispatch namespace (`openping-tenants-staging`), a second platform Worker and database, and `staging.<domain>`, all in the owner's account and all deletable.
- **Stripe test mode** for everything until the owner's real $24 purchase in wave 4.
- **Load test:** 200 fake tenants with 20 monitors each against staging for an hour: no missed scheduler runs, queue lag under a minute, cost per tenant measured against the 6-cent assumption.
- **Restore drill:** delete a staging tenant's database, restore it from its export with its escrowed key, and confirm the data and encrypted settings read back.
- **Browser checks** of sign-up, hand-off sign-in, billing and the suspended state at desktop and phone width, to the mobile standard in [MOBILE_PLAN.md](./MOBILE_PLAN.md); sign-up and sign-in are designed phone-first, since many customers will start on a phone and later use the Android app (stage M2).

## 10. Security and abuse

- **Isolation:** one database and one secret set per customer; the platform database holds no monitoring data; props and hand-off tokens are the only channel from platform to customer, and both are signed or set by the dispatcher.
- **Internal paths** (`/__platform/*`) are reachable only from the dispatch Worker: it strips every `x-openping-*` header from public requests, and a platform call carries a header that must equal the per-call id in props, which only the dispatcher can set (no per-release secret needed; [CONTRACT.md](./hosted/CONTRACT.md) section 6).
- **Keys:** `PLATFORM_KEY` and `HANDOFF_SIGNING_KEY` are platform secrets, and every tenant carries `HANDOFF_PUBLIC_KEY` as a var, so rotating the hand-off key is a release; customer `MASTER_KEY`s are escrowed only encrypted.
- **Abuse:** sign-up rate limits per IP and per email domain, disposable-email blocking, trial monitors limited to 12-minute checks, per-tenant caps on email sends and outbound requests through custom limits, an acceptable-use rule in the terms, and the owner's suspend button.
- **Payment safety:** Stripe webhooks verified by signature and processed idempotently; plan changes apply from webhook state only, never from the browser.
- **A security review** of the hand-off, internal paths, provisioning and billing in wave 4, by a separate review agent, before launch.

## 11. Operations: releases, migrations, backups, support

- **Releases:** the same release-kit flow tags a version; the release runner (C1) then ships it to the canary tenant, waits for a clean scheduled run, and rolls out in batches of 50 with a pause on any health failure.
  Self-hosters are unaffected and keep deploying their own way.
- **Migrations:** additive only, as today; each customer's OpenPing applies them itself (A3), and the release runner refuses a release whose migrations aren't additive.
- **Backups:** D1 Time Travel gives point-in-time restore for 30 days on Workers Paid; a weekly export of every tenant to R2 adds a copy outside D1, and the restore drill proves it works.
- **Support:** one address (owner's choice), a short FAQ, impersonation only with an audit record the customer can see in their Settings, and a promise of a reply within 2 business days.
- **The owner's own install** stays self-hosted at openping.n8builds.dev and keeps monitoring the owner's apps; it also becomes one of the outside monitors of Hosted.

## 12. Owner actions and costs

Wave 0; nothing in waves 1 and 2 waits on them except where noted.
Owner status on 2026-10-28: O4 decided; the domain (O2), Workers Paid and Workers for Platforms (O1) and finishing the Stripe account (O3) come later, before wave 3.

| # | Action | Needed by | Cost |
| --- | --- | --- | --- |
| O1 | Turn on Workers Paid and Workers for Platforms in the Cloudflare dashboard | Staging in wave 3 (B3, B4 against real Cloudflare) | $5 + $25 a month |
| O2 | Pick and buy the Hosted domain (decision D2), add it to Cloudflare | Staging in wave 3 | About $10 to $15 a year |
| O3 | Create a Stripe account (business details, bank account, tax settings), stay in test mode | B5 in wave 3; live mode for the wave 4 purchase | Stripe's fees per charge |
| O4 | Support email address: **support@n8builds.dev** (decided 2026-10-28; set up forwarding with Cloudflare Email Routing) | D2 emails, terms | None |
| O5 | Make a Cloudflare API token scoped to Workers, D1 and the namespace, and set it as a platform secret | Staging in wave 3 | None |
| O6 | Generate `PLATFORM_KEY` and the hand-off signing key with the agent, and save both in the password manager | Staging in wave 3 | None |
| O7 | Review the terms and privacy drafts | Wave 4 | None, or a lawyer if wanted |
| O8 | Make one real $24 purchase and refund it | Wave 4 | $24, refunded |

Running cost before revenue: about $30 to $45 a month (Workers Paid, Workers for Platforms, Resend beyond its free tier), covered at about 20 to 25 customers.

## 13. Risks and how we would know

| Risk | Signal | Response |
| --- | --- | --- |
| Few people sign up | The waitlist count and the trial-to-paid rate after launch | Keep Hosted running cheaply (fixed cost about $30 a month) or switch it off; self-hosting is unaffected. |
| One cron can't reach every customer in time | Queue lag in platform metrics during the load test | Shard the queue, or move due tracking to a Durable Object per tenant group. |
| Cost per customer above the 6-cent assumption | Measured in the load test and from the first month's invoice | Batch writes (C2), lengthen trial intervals, or adjust the price before launch. |
| Workers for Platforms API limits slow releases | Release runner timings in staging | Bigger batches with backoff; uploads are idempotent. |
| A bad release breaks every customer | Canary health check | Automatic stop and one-command rollback (C1). |
| Abuse (monitoring third parties, email spam) | Per-tenant send and request counters, complaints | Caps, the suspend button, the terms. |
| Second-region confirmation can't pick a different location | Measured colo of the confirming probe | Ship the same-location confirm (already live) and keep trying placements. |

## 14. Definition of done for launch

- A stranger can sign up, get a working OpenPing in under a minute, add monitors, receive an alert, publish a status page, start paying, and cancel, all without help.
- A trial that isn't paid stops checking on day 15 and is deleted on day 45, with emails before each step.
- Plan limits can't be exceeded through the dashboard, the API, MCP or the CLI.
- The canary and batched release has shipped at least two versions to staging tenants with no missed runs.
- The restore drill passed, the security review found nothing high or critical open, and the load test met its targets.
- The owner approved the terms and privacy policy and made the real purchase.
- OpenPing Hosted has its own public status page, monitored from outside Cloudflare.
