# OpenPing Hosted platform Worker

This is the platform Worker for OpenPing Hosted: the code that owns customers rather than monitoring.
It is planned in [the build plan](../docs/HOSTED_BUILD_PLAN.md), and it talks to each customer's OpenPing only through [the contract](../docs/hosted/CONTRACT.md).

**Status: skeleton (B1) and provisioning (B3), not deployed anywhere.**
Nothing here has been created in a Cloudflare account yet; see [Owner setup](#owner-setup-not-done-yet).

## What it does today

- Routes by hostname, with the domain taken from the `HOSTED_DOMAIN` var (decision D2, [DECISIONS.md](../docs/hosted/DECISIONS.md)):
  - `app.<domain>`: the platform's own pages; for now a placeholder home page and `GET /healthz`;
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
- Exposes `TenantPlatform`, the capability each customer's OpenPing receives as `props.platform` (`audit` is real; `sendEmail` and `reportUsage` are stubs until A5, B2 and B6).

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
| `src/pages.ts` | The platform's own HTML pages, in OpenPing's design tokens |
| `src/provisioning.ts` | The provisioning state machine: `requestTenant`, `runProvisioning`, `removeTenant`, and `provisionDue` (the retry sweep) |
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
No test makes a network request or needs a Cloudflare login.

## Owner setup (not done yet)

None of these steps has been done.
Until every provisioning setting is present the cron logs which ones are missing and provisions nothing (`src/provisioning-env.ts`).
They are needed before staging in wave 3 ([build plan, section 12](../docs/HOSTED_BUILD_PLAN.md#12-owner-actions-and-costs)), and the main session runs them with the owner, never an agent.

1. **Workers Paid** ($5 a month) and **Workers for Platforms** ($25 a month) on the Cloudflare account (owner action O1).
2. **The Hosted domain** (decision D2, owner action O2): buy it, add it to Cloudflare, then set `HOSTED_DOMAIN` and add routes for `app.<domain>/*` and `*.<domain>/*` to this Worker.
3. **The dispatch namespace:** `wrangler dispatch-namespace create openping-tenants` (and `openping-tenants-staging` for staging).
4. **The platform database:** `wrangler d1 create openping-platform`, then put its id in a gitignored local config (as `deploy.local.json` does for OpenPing), and apply `migrations/` with `wrangler d1 migrations apply PLATFORM_DB --remote`.
5. **The queues:** `wrangler queues create openping-provision` (provisioning; this Worker is its consumer) and `wrangler queues create openping-schedule` (B4 adds its consumer).
6. **The bundle bucket:** `wrangler r2 bucket create openping-tenant-bundles`; the release runner (C1) writes each release there in the layout `src/bundle.ts` describes.
7. **Secrets**, with `wrangler secret put` from the owner's machine and a copy of each in the password manager:
   - `HANDOFF_SIGNING_KEY`: the hand-off private key; `generateHandoffKeyPair()` in the contract makes the pair, and the public half goes in the `HANDOFF_PUBLIC_KEY` var in `wrangler.jsonc`, which provisioning copies to every tenant (O6);
   - `PLATFORM_KEY`: 32 random bytes in base64 (`openssl rand -base64 32`), encrypts the escrowed tenant keys (decision D4, O6); losing it means no tenant backup can be restored;
   - `CF_ACCOUNT_ID`: the account's 32 hex character id, a secret only to keep it out of this public config;
   - `CF_API_TOKEN`: a custom API token for that one account with **Account, Workers Scripts, Edit** and **Account, D1, Edit**, nothing else (O5); the dispatch namespace's scripts are Workers Scripts;
   - `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, in test mode first (O3).
8. **Support address:** support@n8builds.dev, decided; forward it with Cloudflare Email Routing (O4).
