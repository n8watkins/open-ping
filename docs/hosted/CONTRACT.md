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
- signs in only through the hand-off (section 7) and the customer's own passkeys;
- takes its limits from `props.tenant.limits` instead of `WORKERS_PLAN`;
- sends email only through `props.platform.sendEmail`;
- shows "Managed by OpenPing Hosted" in Settings, with links to `props.tenant.urls.account` and `props.tenant.urls.billing`;
- runs its scheduler only when the platform calls `POST /__platform/scheduled` (a user Worker in a namespace has no Cron Trigger);
- keeps every other feature identical to a plain install.

A plain install never reads props, never answers an internal path, and behaves exactly as it does today.

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
It answers `HealthResponse` with HTTP 200 when `ok`, 503 when not:
`{ "ok": boolean, "version": string, "schemaVersion": number, "bundledSchemaVersion": number, "migrating": boolean, "lastRun": { "at", "outcome", "durationMs" } | null }`.
`ok` means the database answers, `schemaVersion` equals `bundledSchemaVersion`, and no migration is in progress.

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

Signing out ends the tenant's session and redirects to `props.tenant.urls.signOut`, which ends the platform session too.

## 8. Error codes

| Status | `error` | When |
| --- | --- | --- |
| 402 | `plan_limit` | a create or update over the plan (section 5) |
| 403 | `tenant_suspended` | a write while `tenant.status` is `suspended` (reads and exports still work) |
| 404 | `managed_by_platform` | `/setup`, `/recover`, the GitHub OAuth configuration in hosted mode |
| 404 | `not_found` | an internal path without a valid platform call, the same as any unknown route |

The constants are in `HOSTED_ERRORS`.

## 9. What is deliberately not in the contract

- Slug rules and reserved names: only the platform needs them.
- Dispatch limits (`cpuMs`, `subRequests` per call): the platform sets them per invocation and plan; the user Worker just runs inside them.
- The platform database: the user Worker never sees it.
- Provisioning states (`requested` to `ready`): the platform never dispatches to a tenant that isn't ready.
