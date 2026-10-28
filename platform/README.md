# OpenPing Hosted platform Worker

This is the platform Worker for OpenPing Hosted: the code that owns customers rather than monitoring.
It is planned in [the build plan](../docs/HOSTED_BUILD_PLAN.md), and it talks to each customer's OpenPing only through [the contract](../docs/hosted/CONTRACT.md).

**Status: skeleton (build plan item B1), not deployed anywhere.**
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
| `test/` | workerd tests, and `FakeDispatcher`, the in-memory stand-in for the dispatch namespace |

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
No test makes a network request or needs a Cloudflare login.

## Owner setup (not done yet)

None of these steps has been done.
They are needed before staging in wave 3 ([build plan, section 12](../docs/HOSTED_BUILD_PLAN.md#12-owner-actions-and-costs)), and the main session runs them with the owner, never an agent.

1. **Workers Paid** ($5 a month) and **Workers for Platforms** ($25 a month) on the Cloudflare account (owner action O1).
2. **The Hosted domain** (decision D2, owner action O2): buy it, add it to Cloudflare, then set `HOSTED_DOMAIN` and add routes for `app.<domain>/*` and `*.<domain>/*` to this Worker.
3. **The dispatch namespace:** `wrangler dispatch-namespace create openping-tenants` (and `openping-tenants-staging` for staging).
4. **The platform database:** `wrangler d1 create openping-platform`, then put its id in a gitignored local config (as `deploy.local.json` does for OpenPing), and apply `migrations/` with `wrangler d1 migrations apply PLATFORM_DB --remote`.
5. **The queue:** `wrangler queues create openping-schedule` (B4 adds the consumer and the cron).
6. **Secrets**, with `wrangler secret put` from the owner's machine and a copy of each in the password manager:
   - `HANDOFF_SIGNING_KEY`: the hand-off private key; `generateHandoffKeyPair()` in the contract makes the pair, and the public half becomes every tenant's `HANDOFF_PUBLIC_KEY` (O6);
   - `PLATFORM_KEY`: encrypts the escrowed tenant keys (decision D4, O6);
   - `CF_API_TOKEN`: scoped to Workers, D1 and the namespace, for provisioning (O5);
   - `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, in test mode first (O3).
7. **Support address:** support@n8builds.dev, decided; forward it with Cloudflare Email Routing (O4).
