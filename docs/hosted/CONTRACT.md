# OpenPing Hosted: the contract

Status: contract version 1, 2026-10-28 (build plan item C0).
This is the agreement between the platform Worker (`platform/`) and a customer's OpenPing running as a user Worker in the dispatch namespace.
The TypeScript types, constants and pure helpers are in [`src/shared/hosted-contract.ts`](../../src/shared/hosted-contract.ts); both sides import them, and neither side keeps its own copy.
A change to this contract is its own pull request, which both lanes rebase on ([build plan, section 8](../HOSTED_BUILD_PLAN.md#8-how-the-agents-work-without-stepping-on-each-other)).
`HOSTED_CONTRACT_VERSION` goes up only for a change an older bundle can't understand.

## Contents

1. [Names](#1-names)
2. [Hosted mode](#2-hosted-mode)
3. [Props on every call](#3-props-on-every-call)
4. [The platform capability](#4-the-platform-capability)
5. [Plans and limits](#5-plans-and-limits)
6. [Internal paths](#6-internal-paths)
7. [The sign-in hand-off](#7-the-sign-in-hand-off)
8. [Error codes](#8-error-codes)
9. [What is deliberately not in the contract](#9-what-is-deliberately-not-in-the-contract)

## 1. Names

- A **tenant id** is 16 random characters of `[a-z0-9]`, assigned once by the platform and never changed (`isTenantId`).
- A **slug** is the customer's subdomain label: `<slug>.<hosted domain>`.
  It can change later (a rename), so nothing is keyed by it except routing.
  The slug rules and the reserved names live in the platform (`platform/src/slugs.ts`); the user Worker treats the slug as display data.
- The user Worker's **script name** is `t-<tenant id>` (`tenantScriptName`), and its D1 database is `openping-t-<tenant id>` (`tenantDatabaseName`).
  A dash, not the underscore the build plan sketched, because dashes are valid in every Cloudflare resource name.

## 2. Hosted mode

The platform uploads every user Worker with these plain vars (`HOSTED_ENV`):

| Var | Value |
| --- | --- |
| `HOSTED_MODE` | `"1"`; any other value or none means a plain install (`isHostedMode`) |
| `TENANT_ID` | the tenant id |
| `HANDOFF_PUBLIC_KEY` | base64url of the raw 32-byte Ed25519 public key that verifies hand-off tokens |

and one secret of its own, `MASTER_KEY`, generated and escrowed by the platform ([decision D4](./DECISIONS.md#d4-who-holds-each-customers-master_key)).
It has no `SETUP_TOKEN`, no GitHub OAuth app, no `RESEND_API_KEY` and no `API_TOKEN` of its own.

In hosted mode OpenPing:

- refuses `/setup`, `/recover`, the setup token and the GitHub OAuth configuration with 404 `managed_by_platform`, and hides them in the UI;
  the email magic link is refused the same way, since the platform's own sign-in replaces it;
- signs in only through the hand-off (section 7) and the customer's own passkeys;
- reports setup as complete to the app, so no wizard is ever shown;
- refuses a change to the install's address (`app_url`, HTTP 400 `managed_by_platform`) and hides it and the email sender in Settings, since the platform gives each tenant its address and sends its email;
- takes its limits from `props.tenant.limits` instead of `WORKERS_PLAN`;
- sends email only through `props.platform.sendEmail`;
- shows "Managed by OpenPing Hosted" in Settings, with links to `props.tenant.urls.account` and `props.tenant.urls.billing`;
- runs its scheduler only when the platform calls `POST /__platform/scheduled` (a user Worker in a namespace has no Cron Trigger);
- keeps every other feature identical to a plain install.

A plain install never reads props, never answers an internal path, and behaves exactly as it does today.
The switch and the gate live in `src/worker/lib/hosted.ts`; `test/integration/hosted-mode.test.ts` checks both modes against the real Worker.

## 3. Props on every call

The platform calls the user Worker with `env.TENANTS.get(scriptName, { props }, { limits })`.
The user Worker reads them as `ctx.props` (in Hono, `c.executionCtx.props`).
Cloudflare guarantees that only the platform can set props, so nothing in them is signed.
The shape is `TenantProps`:

| Field | Meaning |
| --- | --- |
| `contract` | `1`, the contract version the platform speaks |
| `invocation` | `"public"` for a visitor's request routed from `<slug>.<domain>`; `"platform"` when the platform itself calls (scheduler, health, releases) |
| `callId` | a random id, at least 16 characters, new for every call |
| `tenant` | `TenantInfo`: `id`, `slug`, `status` (`trial`, `active`, `past_due`, `suspended`), `plan` (`trial`, `hosted`, `hosted_fast`), `limits` (section 5), `trialEndsAt` (epoch ms or null), `urls` (`account`, `billing`, `upgrade`, `signIn`, `signOut`) |
| `platform` | the platform capability, an RPC stub (section 4) |

Props are fresh on every call, so a plan change, a suspension or a new limit reaches the tenant on its next request without a release.
The user Worker must not cache props, and above all must not keep the `platform` stub past the call that received it: Workers rejects that as cross-request I/O.
When hosted mode is on and props are missing or `contract` is not a version it understands, the user Worker answers 503 and does nothing else.
It checks props with `isTenantProps(props, env.TENANT_ID)`, so props for another tenant, or a `TENANT_ID` that isn't a tenant id, get the same answer.
The body is `{ "error": "hosted_unavailable" }`, and the reason goes to the Worker's logs.

`status` is billing state only.
A tenant that is still being provisioned is never dispatched to, so the user Worker never sees it.
A `suspended` tenant is not dispatched to for public traffic either (the platform shows its own suspended page); it can still be called with `invocation: "platform"` for an export.

## 4. The platform capability

`props.platform` implements `PlatformCapability`.
Each method runs inside the platform Worker, already bound to the calling tenant, so no method takes a tenant id and none can be pointed at another tenant.

- `sendEmail(message: HostedEmail): Promise<SendEmailResult>` sends one email from the platform's verified domain.
  The platform picks the From address; `replyTo` is optional.
  `category` (`"alert"`, `"report"`, `"signin"`, ...) feeds per-tenant metrics and the daily cap (`limits.emailsPerDay`).
  It answers `{ ok: true, id }` or `{ ok: false, error, message }` with `error` one of `email_quota_exceeded`, `email_rejected`, `email_unavailable`.
  It never throws for a delivery problem; a thrown error means the RPC itself failed, and the caller treats it like `email_unavailable`.
- `reportUsage(counts: UsageCounts): Promise<void>` reports `monitors`, `statusPages` and `channels` after a create or delete and at the end of each scheduled run.
  The platform uses it for the admin console and abuse signals, not for enforcement; enforcement is the user Worker's, from props.
- `audit(event: HostedAuditEvent): Promise<void>` records an event in the platform's audit log.
  `action` is dotted lowercase (`AUDIT_ACTION_PATTERN`, for example `session.created`), `actor` is `customer`, `support` or `system`, and `detail` is small, flat and never secret.
  Support sign-ins (section 7) are always audited, by both sides.

In the skeleton (B1) `audit` is real, `reportUsage` is accepted and dropped, and `sendEmail` answers `email_unavailable` until A5 and B2 wire the mail provider.

### How OpenPing sends its email

Every email OpenPing sends goes through one transport (`src/worker/notifications/mail.ts`): alerts (`category` `alert`, from the outbox and from a channel test), the weekly summary and the monthly report (`report`), and, on a plain install only, the sign-in link (`signin`) and the waitlist confirmation (`waitlist`).

- A plain install sends through Resend with its own `RESEND_API_KEY`, exactly as before.
- In hosted mode the hosted gate puts a transport over `props.platform.sendEmail` on that call's env, and nothing else is used, even when a `RESEND_API_KEY` is set.
  It sends `to` as one address, no From (the platform's), and `text` always.
- `email_quota_exceeded` puts the delivery off until the next UTC midnight without spending one of its attempts, so an alert over the cap goes out the next day instead of being given up on; `email_rejected` and `email_unavailable` retry like any failed delivery, and a thrown RPC counts as `email_unavailable`.
- The reports go to the admin email, which in hosted mode is the customer's account email: every customer hand-off (section 7) stores the token's `email` as `admin_email`, before the session, and a failed write is logged and doesn't stop the sign-in.
- Settings doesn't offer a From address for an email channel, and says the reports go to the account email instead of asking for `RESEND_API_KEY`.

## 5. Plans and limits

`PlanLimits` has `monitors`, `statusPages`, `minIntervalMinutes`, `channelKinds` (`"all"` or a list of channel kinds) and `emailsPerDay`.
The platform's defaults (`PLAN_LIMITS`):

| Plan | Monitors | Status pages | Fastest check | Channels | Emails a day |
| --- | --- | --- | --- | --- | --- |
| `trial` | 5 | 1 | 12 minutes | email | 50 |
| `hosted` | 20 | 2 | 12 minutes | all | 500 |
| `hosted_fast` | 20 | 2 | 1 minute | all | 500 |

The user Worker enforces whatever arrives in `props.tenant.limits`, never `PLAN_LIMITS` directly, so the platform can grant a tenant more without a release.
The email numbers are starting values, to be measured in the load test.

Enforcement happens on every create or update route, whether it is reached from the dashboard, the API, MCP or the CLI:

- creating a monitor: `checkMonitorLimit(limits, existingCount)`;
- creating a status page: `checkStatusPageLimit(limits, existingCount)`;
- creating or editing a monitor's interval: `checkIntervalLimit(limits, minutes)`;
- creating a channel: `checkChannelKindLimit(limits, kind)`.

Each returns null when the change fits, or the details for the answer.
A refused change is HTTP 402 with `planLimitBody(details, props.tenant)`:

```json
{
  "error": "plan_limit",
  "limit": "monitors",
  "allowed": 20,
  "requested": 21,
  "plan": "hosted",
  "message": "Your plan includes 20 monitors. Remove one or upgrade to add more.",
  "upgradeUrl": "https://app.<domain>/billing/upgrade"
}
```

`limit` is one of `monitors`, `status_pages`, `interval`, `channel_kind`.
`message` is one plain sentence the UI shows as is, next to a button to `upgradeUrl`.
A downgrade never deletes anything: existing monitors over the limit keep running, and only new ones are refused.

### How OpenPing does it

The checks are `src/worker/lib/plan-limits.ts`; on a plain install there is no plan, so none of them runs or costs a query.

- `POST /api/monitors` (the dashboard and the CLI), MCP `create_monitor` and a backup import (`POST /api/data/import`) all go through the same monitor check; an import counts the monitors it would create and refuses before creating any.
- The monitor count includes paused monitors, and the status page count includes the default page.
- A body is validated first, so an invalid one is still a 400 at the limit.
- Polled monitors are checked every 12 minutes, so `checkIntervalLimit` sees 12 for them; a heartbeat's interval is how often its job pings, not a check, so it never counts.
  An edit is held to the interval only when it changes it, so a monitor kept from a bigger plan can still be renamed.
- Push devices are not channels (they are `push_subscriptions`), so `channelKinds` doesn't apply to them.
- The check and the insert are separate queries, so two creates at the same instant could both pass at the last free place; the next create is refused.
- MCP answers a refusal as a tool error with the message and the upgrade link, and `structuredContent.planLimit` holding the body; the CLI prints both.
- `/api/auth/me` adds `limits` to `hosted`, and the app shows the usage ("3 of 5 monitors on your plan") and, at the limit, the same sentence with an Upgrade button instead of a form that can't be saved.
- `reportUsage` runs after every successful create or delete through the API and MCP, after the response (`waitUntil`).
- A hosted scheduler run gets its own budget (`PLAN_BUDGETS.hosted` in `src/worker/lib/budget.ts`: 300 D1 queries and 600 fetches), under the 1,000 subrequests the platform allows a platform call.

## 6. Internal paths

Every path under `/__platform/` is internal (`isInternalPath`).
The platform never forwards a public request to one: a visitor's request for `/__platform/...` gets the platform's own 404 and never reaches the user Worker.
The platform also removes every header starting with `x-openping-` (`INTERNAL_HEADER_PREFIX`) from every public request before dispatching it.

A platform call has `props.invocation === "platform"` and carries the header `x-openping-platform` (`INTERNAL_HEADER`) set to `props.callId`.
The user Worker serves an internal path only when `isPlatformCall(props, request.headers.get(INTERNAL_HEADER))` is true, and otherwise answers exactly what it answers for any unknown route (404 `not_found`), so the paths can't be discovered.
Props alone already prove the call came from the platform; the header ties the request to that one call and keeps the check from depending on a single field.
No shared secret is needed, so there is nothing to rotate per release.

### `POST /__platform/scheduled`

The platform's queue consumer calls this once per due tenant.
The request body is `ScheduledRequest`: `{ "runId": string, "scheduledTime": epoch ms, "cron": string }`.
The user Worker first applies any bundled migrations it is missing (under its lock), then runs exactly what its `scheduled()` handler runs today.
It always answers HTTP 200 with `ScheduledRunSummary`, whatever happened:

| Field | Meaning |
| --- | --- |
| `runId` | echoed from the request |
| `outcome` | `ran`, `lease_busy` (another run holds the lease), or `failed` |
| `version` | the OpenPing version of the bundle |
| `schemaVersion` | the highest migration applied after this run |
| `migrationsApplied` | migrations this run applied first |
| `startedAt`, `durationMs` | epoch ms, wall-clock ms |
| `checked`, `failures`, `deferred` | monitors checked, checks that failed, due monitors left for the next run |
| `d1Queries` | D1 queries the run made |
| `error` | a short non-secret reason, only when `outcome` is `failed` |

Any other status (or a thrown RPC error, or a timeout) means the platform could not get an answer, and the queue retries the message.

### `GET /__platform/health`

The release runner and the platform's monitoring call this.
Like any call after an update, it first applies the bundled migrations the database is missing; it still answers when that fails.
It answers `HealthResponse` with HTTP 200 when `ok`, 503 when not:
`{ "ok": boolean, "version": string, "schemaVersion": number, "bundledSchemaVersion": number, "migrating": boolean, "lastRun": { "at", "outcome", "durationMs" } | null }`.
`ok` means the database answers, `schemaVersion` is at least `bundledSchemaVersion`, and no migration is in progress.
"At least", because migrations are additive: after a rollback, an older bundle runs on the newer schema and is still healthy.

### Self-migration and public calls

Only platform calls migrate: `POST /__platform/scheduled` and `GET /__platform/health`, which the scheduler calls every minute and the release runner calls right after an upload.
Only one call migrates at a time; another platform call waits for it, for a few seconds at most.
When the migrations can't be applied (one failed, or another call is still applying them after the wait), `POST /__platform/scheduled` answers `outcome: "failed"` and health answers `ok: false`.

A public call never migrates, so a visitor's request (which the browser may cancel at any moment) can never hold the migration lock.
When it finds the schema older than its bundle, it answers 503 `hosted_updating` with `Retry-After: 10` and does nothing else: JSON `{ "error": "hosted_updating" }` for the API, MCP and heartbeats, and a short "This OpenPing is updating" page for a browser's page load.
The next platform call migrates, so this lasts about a minute at most after an update.

### How OpenPing does it

The internal paths are `src/worker/routes/platform.ts`, and self-migration is `src/worker/lib/migrate.ts`.

- On a plain install every internal path passes through to what it answered before (the app shell), even when a caller passes props and the header, and nothing migrates: a plain install's migrations run from `npm run deploy`.
- The migrations are compiled into the bundle at build time (`virtual:openping-bundle`, from `scripts/bundle-module.ts`), each file split into statements by Wrangler's own SQL splitter, with the version from `package.json`.
- Applied migrations are rows of Wrangler's own `d1_migrations` table, by file name, so the Worker and `wrangler d1 migrations apply` always agree on what a database has.
  `schemaVersion` is the highest number among those names (`0019_incident_alert_repair.sql` is 19).
- Each migration and its `d1_migrations` row go in one batch, which D1 runs as one transaction, so a migration is applied whole or not at all; `d1_migrations.name` is unique, so none is applied twice.
- The lock is a row in `d1_migrations_lock` with a 15-second expiry, pushed on with each migration, so a call that dies mid-migration frees it within seconds.
  A call that finds it held looks again every 250 ms for up to 8 seconds, with reads only, and tries to take it only once it is free or expired; health doesn't wait.
- Each isolate remembers for 10 minutes that it saw the schema current, so a call costs no query in that time, and forgets at once when any query fails with "no such table" or "no such column".
  It remembers a failed migration for 30 seconds, so the calls in that time answer the failure instead of trying again.
- A public call's check (`schemaIsCurrent`) is the same one read of `d1_migrations`, and never writes.
- Migrations are additive only ([RELEASING.md](../../RELEASING.md#database-migrations)); `scripts/check-migrations.test.mjs` fails `npm test` for a later migration that drops, renames, or adds a `NOT NULL` column without a default.
- `POST /__platform/scheduled` passes `cron` and `scheduledTime` to the same `runScheduled` the cron handler calls, then reports usage through `props.platform.reportUsage`.
  A malformed body answers 400 `invalid_request`.
  `d1Queries` counts the run's queries plus the migration check and the usage report.
- `lastRun` is the latest finished row of `scheduler_runs` (`at` is when it started); a `lease_busy` call writes no row.

## 7. The sign-in hand-off

A signed-in customer reaches their OpenPing through a redirect to `https://<slug>.<domain>/auth/hosted?t=<token>` (`HANDOFF_PATH`, `HANDOFF_QUERY_PARAM`).

### Token format

```
v1.<base64url(UTF-8 JSON claims)>.<base64url(Ed25519 signature)>
```

- base64url is RFC 4648 section 5, without padding.
- The signature is Ed25519 (RFC 8032) over the ASCII bytes of `v1.<payload>`, exactly as they appear in the token, and is 64 bytes.
- A token is at most 2048 characters (`HANDOFF_MAX_TOKEN_LENGTH`); anything longer is refused before decoding.
- The leading `v1` versions the format; a new format gets a new prefix, and old tenants refuse it as malformed.

Claims (`HandoffClaims`):

| Claim | Meaning |
| --- | --- |
| `v` | `1` |
| `iss` | `"openping-platform"` |
| `aud` | the tenant id the token is for |
| `sub` | the platform account id |
| `email` | the account's email |
| `role` | `customer`, or `support` when the owner signs in to help (always audited, and shown to the customer in Settings) |
| `nonce` | 16 random bytes, base64url (22 characters) |
| `iat`, `exp` | whole seconds since the epoch; `exp` is `iat + 60` |

### Keys

- The platform signs with `HANDOFF_SIGNING_KEY`, a platform secret holding base64url of the PKCS#8 DER private key (`importHandoffPrivateKey`).
- Each user Worker verifies with `HANDOFF_PUBLIC_KEY`, a plain var holding base64url of the raw 32-byte public key (`importHandoffPublicKey`).
- `generateHandoffKeyPair()` makes a pair in exactly these two forms (owner step O6).
- Rotation: the platform starts signing with the new key only after every tenant has the new public key; the release runner pushes the var, so a rotation is a release.

### Checks, in order (tenant side)

1. `verifyHandoffToken(token, publicKey, { tenantId: env.TENANT_ID, now })` checks the format, the signature, `iss`, `aud`, a lifetime of at most 60 seconds, and the times with 5 seconds of clock skew either way (`HANDOFF_CLOCK_SKEW_SECONDS`).
2. Single use: the user Worker inserts `nonce` into its `used_handoff_nonces` table (A2's migration) with an INSERT that fails on a duplicate, and refuses the token as `replayed` when it was already there.
   It keeps each nonce for `HANDOFF_NONCE_RETENTION_SECONDS` (65) past `exp`, then deletes it.
3. Only then does it create its normal session, record `session.created` through `props.platform.audit`, and redirect to the dashboard with the token gone from the URL.

Any failure shows one plain page, "This sign-in link has expired", with a button back to `props.tenant.urls.signIn`, and logs the `HandoffError` reason (`malformed`, `bad_signature`, `wrong_issuer`, `wrong_tenant`, `not_yet_valid`, `expired`, `lifetime_too_long`, `replayed`).
The reason is never shown to the visitor.
The answer carries `Referrer-Policy: no-referrer` and `Cache-Control: no-store`, so the token does not leak.

How OpenPing does each step (`src/worker/routes/hosted-auth.ts`):

- A request with no `t`, an empty one, or more than one is `malformed`.
- The single-use insert is `INSERT ... ON CONFLICT(nonce) DO NOTHING`, refused as `replayed` when it changes no row; it runs only after step 1, so nothing unsigned reaches the table.
  `used_handoff_nonces` (migration 0018) holds `nonce`, `used_at` and `expires_at` (epoch ms, `(exp + HANDOFF_NONCE_RETENTION_SECONDS) * 1000`), and the scheduler's expired-auth cleanup deletes expired rows.
- The session's identity is the token's `email`, with `identity_kind` `hosted` for a customer and `hosted_support` for support.
  A customer's session lasts 30 days, like every other sign-in; a support session lasts one hour.
  Any session the browser already had is ended first.
- `session.created` is recorded with `actor` `customer` or `support` and `detail` `{ method: "handoff", role, account: sub }`.
  A support sign-in that the platform can't record is refused; a customer's still signs in, and the failure is logged.
- The failure page answers 400 for a refused token, 429 when the hand-off's rate limit (30 a minute per IP, 600 in total) is hit, and 503 when `HANDOFF_PUBLIC_KEY` is missing or invalid or a support audit failed.

Signing out ends the tenant's session and redirects to `props.tenant.urls.signOut`.
That page (`GET /sign-out` on the platform) ends nothing by itself: signing out of the platform is a POST only, so no link or image on another site can sign anyone out.
When the browser still has a platform session, the page offers one tap to end it too, and a link to stay signed in; without one, it just says the customer is signed out.
`POST /api/auth/logout` and `/api/auth/logout-all` answer `{ ok: true, signOutUrl }` in hosted mode and leave a two-minute `op_signed_out` cookie (path `/login`), so the app's usual next step, loading `/login`, is redirected once to `signOutUrl`.

### Testing and local development

Props reach a user Worker only as `ctx.props`, which only the dispatcher sets.
Tests pass them the same way, by calling the Worker's `fetch(request, env, ctx)` with a context that carries `props`, so no header, cookie or query parameter can ever stand in for props.

`npm run dev` has no dispatcher, so for local work only, the `HOSTED_DEV_TENANT` var (TenantInfo JSON) stands in for `props.tenant`, with a platform capability that logs and sends nothing.
It is read only when Vite's compile-time `import.meta.env.DEV` is true, which a production build replaces with false, so a deployed Worker ignores it whatever its vars say.
`.dev.vars.example` has an example.

## 8. Error codes

| Status | `error` | When |
| --- | --- | --- |
| 402 | `plan_limit` | a create or update over the plan (section 5) |
| 403 | `tenant_suspended` | a write while `tenant.status` is `suspended` (reads and exports still work) |
| 400 | `managed_by_platform` | a change to `app_url` in hosted mode (section 2) |
| 404 | `managed_by_platform` | `/setup`, `/recover`, the GitHub OAuth configuration and the email magic link in hosted mode |
| 404 | `not_found` | an internal path without a valid platform call, the same as any unknown route |
| 503 | `hosted_unavailable` | hosted mode without valid props for this tenant (section 3) |
| 503 | `hosted_updating` | a public call while the database is older than the bundle, until the next platform call migrates it (section 6), with `Retry-After` |

The constants are in `HOSTED_ERRORS`.

## 9. What is deliberately not in the contract

- Slug rules and reserved names: only the platform needs them.
- Dispatch limits (`cpuMs`, `subRequests` per call): the platform sets them per invocation and plan; the user Worker just runs inside them.
- The platform database: the user Worker never sees it.
- Provisioning states (`requested` to `ready`): the platform never dispatches to a tenant that isn't ready.
