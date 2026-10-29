# OpenPing Hosted: observability and alerting

Status: built in C4 ([build plan](../HOSTED_BUILD_PLAN.md#c-shared-and-cross-cutting)), 2026-10-28; nothing is deployed yet, and none of the monitors below exist yet.
This is how the owner finds out that Hosted is unwell, before a customer does, and how customers see that it is well.

## Contents

1. [The pieces](#1-the-pieces)
2. [Logs](#2-logs)
3. [The health endpoint](#3-the-health-endpoint)
4. [The Operations tab](#4-the-operations-tab)
5. [Alerting: the monitors to create](#5-alerting-the-monitors-to-create)
6. [The public status page](#6-the-public-status-page)
7. [The outside checker](#7-the-outside-checker)
8. [Costs](#8-costs)
9. [What to do when it alerts](#9-what-to-do-when-it-alerts)

## 1. The pieces

| Piece | Where | For |
| --- | --- | --- |
| Workers Logs | Cloudflare dashboard, Observability | The owner, after the fact: what happened, to which tenant, and why. |
| `GET app.<domain>/__health` | The platform Worker (`platform/src/observability/health.ts`) | Machines: 200 when well, 503 when not, with JSON detail. |
| `GET app.<domain>/healthz` | The platform Worker | Machines: the Worker runs and its database answers, nothing more. |
| Operations tab | `app.<domain>/admin/operations` (`platform/src/admin/operations.ts`) | The owner, now: the same checks, plus run metrics and the tenants in trouble. |
| The owner's OpenPing | `openping.n8builds.dev` | Alerts the owner, and serves the public status page. |
| An outside checker | UptimeRobot (free) | Alerts the owner when Cloudflare itself, or the owner's install, is the problem. |

The owner's install and Hosted run on the same provider, and probably the same Cloudflare account, so the owner's install alone can't see a Cloudflare-wide outage or an account problem.
That is what the outside checker is for: it watches both.

## 2. Logs

### Turned on

- **The platform Worker:** `observability.logs` in `platform/wrangler.jsonc`, with invocation logs and a head sampling rate of 1 (everything).
- **Every customer's user Worker:** the `observability` block of each upload's metadata (`tenantObservability` in `platform/src/cloudflare/upload.ts`), as Cloudflare documents for [Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/observability/): logs on, invocation logs on, head sampling at `TENANT_LOG_SAMPLING` (a platform var, 0 to 1, empty means 1).
  A change to `TENANT_LOG_SAMPLING` reaches each tenant with its next upload, which is the next release.
  A value that isn't a number from 0 to 1 turns provisioning off and names the setting, so a typo can't quietly stop the logs.

Head sampling keeps or drops a whole invocation, its errors included, so both stay at 1 until the volume costs more than it is worth (section 8).

### Finding things

Logs are kept 7 days and searched in the dashboard's Query Builder (Workers and Pages, Observability).

- The platform's own lines: Worker `openping-platform`, then filter on `event`, `tenant`, `release`, `stripeEvent` and so on.
- One customer's OpenPing: dataset `cloudflare-workers`, `$metadata.service` equal to `t-<tenant id>` (the tenant id is on the console's tenant page).
- Every customer at once: `$metadata.service` starts with `t-`.

### The format

Every line the platform writes is one flat object, from `platform/src/log.ts`:

```json
{ "event": "schedule.no_answer", "level": "warn", "tenant": "k3x9...", "run": "s-1793...", "outcome": "timeout", "error": "no answer in 90 s" }
```

- `event` is `<area>.<what>`, dotted lowercase; `level` is `info`, `warn` or `error` and matches the console method, so the dashboard's severity is right.
- Fields are strings (cut at 300 characters), numbers, booleans and short lists; an error becomes its message, never its stack.
- No secret can be logged: a field named like one (`token`, `secret`, `key`, `password`, `cookie`, `authorization`, `jwt`, `private`, `signing`) is always written as `"[redacted]"`, and nested objects are flattened to text first.
- No customer data: ids and counts, never an email address, a subject or a body.

### The events

| Area | Events | Level |
| --- | --- | --- |
| Provisioning | `provision.step` (from, to), `tenant.provisioned`, `tenant.removed`, `tenant.provision_paused`, `provision.step_failed`, `provision.run_threw`, `provision.first_run_failed`, `provision.sweep`, `provision.off` (the missing settings) | info, error for failures, warn for off |
| Scheduler | `schedule.enqueued` (sent, returned, rounds), `schedule.batch` (one per consumer batch: runs, errors, timeouts, skipped, max duration, max lag), `schedule.no_answer` (one per tenant without a clean answer), `schedule.queue_refused`, `schedule.unclaim_failed`, `schedule.run_threw`, `schedule.bookkeeping_failed`, `schedule.metrics_failed`, `schedule.malformed_message` | info; `schedule.batch` is warn when a run failed |
| Billing | `billing.webhook_processed` (Stripe event id and type), `billing.tenant_changed`, `billing.trials_ended`, `billing.webhook_refused`, `billing.webhook_wrong_mode`, `billing.webhook_failed`, `billing.webhook_while_off`, `billing.needs_attention`, `billing.duplicate_subscription`, `billing.checkout_failed`, `billing.portal_failed`, `billing.addon_failed`, `billing.email_not_sent`, `billing.lock_not_released` | info, warn, error |
| Releases | the audit log's release actions as events: `release.started`, `release.canary_passed`, `release.paused`, `release.done`, `release.rolled_back`, `release.refused`, `release.rollback_started`, `tenant.updated`; plus `release.request_handled`, `release.tick`, `release.stopped`, `release.request_failed`, `release.tick_failed` | info, warn for stopped |
| Lifecycle | `lifecycle.email_sent`, `lifecycle.run`, `lifecycle.deletion_waiting`, `lifecycle.email_not_sent`, `lifecycle.teardown_failed`, `lifecycle.export_failed`, `export.failed`, `export.first_run_failed`, `export.key_notice_not_sent` | info, warn, error |
| Mail | `mail.sent` (category, tenant, Resend's id), `mail.send_failed` (status and class), `mail.tenant_not_sent`, `mail.tenant_partly_sent`, `mail.recipients_unconfirmed`, `mail.reply_to_dropped`, `mail.confirmation_not_sent` | info, warn, error |
| Routing | `dispatch.script_missing`, `dispatch.tenant_threw`, `platform.unhandled`, `queue.unknown` | error |
| Sign-in and console | `signin.email_not_sent`, `signin.github_failed`, `signin.passkey_notice_not_sent`, `signin.handoff_key_missing`, `admin.tenant_health_failed`, `admin.provision_run_failed`, `admin.release_push_failed` | error |
| Health | `health.degraded` (the problems, at most once per isolate per 15 seconds), `health.db_failed`, `cron.cleanup_failed` | warn, error |

Saved queries worth making once the platform is live: `level = "error"` over the last hour; `event = "schedule.batch" AND errors > 0`; `event = "health.degraded"`.

## 3. The health endpoint

`GET https://app.<domain>/__health` is public, needs no sign-in, is served only on the platform's own host, and answers `cache-control: no-store`.

- **200** when every check passes, **503** when any doesn't, so a plain HTTP monitor alerts on the status code alone.
- The JSON says which check failed, so a monitor can also assert on one part (the public status page does, section 6).

```json
{
  "ok": true,
  "status": "ok",
  "service": "openping-platform",
  "checkedAt": "2026-11-02T14:07:31.000Z",
  "maxAgeSeconds": 15,
  "problems": [],
  "checks": {
    "database": { "ok": true },
    "cron": { "ok": true, "lastTickAt": "2026-11-02T14:07:00.512Z", "ageSeconds": 31 },
    "queue": { "ok": true, "lastEnqueueAt": "2026-11-02T14:07:02.020Z", "ageSeconds": 29, "sent": 57, "returned": 0 },
    "scheduler": { "ok": true, "oldestOverdueSeconds": 48, "overdueTenants": 0, "lastRunAt": "2026-11-02T14:06:00.000Z" },
    "tenants": { "ok": true, "failing": 1, "threshold": 5 },
    "release": { "ok": true, "inProgress": true, "kind": "rollout", "state": "rolling", "version": "0.17.0", "batch": 3 },
    "config": { "ok": true, "mail": true, "billing": true, "provisioning": true }
  }
}
```

| Check | Fails when | Why that line |
| --- | --- | --- |
| `database` | The platform database doesn't answer the batch. The other checks are then `null`. | Nothing works without it. |
| `cron` | The cron's heartbeat is older than 3 minutes, or there is none. | The cron runs every minute; it writes `platform_heartbeats` in the cleanup batch it already sends. |
| `queue` | The scheduler's enqueue heartbeat is older than 3 minutes. | Tells "the cron stopped" from "the cron runs but can't reach the queue". |
| `scheduler` | The oldest due tenant has waited more than 5 minutes past its due time. | A healthy run is called within about 10 seconds, holds a tenant for at most 90, and a lost message frees it after the 3-minute queue lease. Tenants 2 minutes late are counted in `overdueTenants`, not alarmed on. Tenants that can't run (suspended, not ready) never count. |
| `tenants` | 5 or more tenants have failed 3 runs in a row (about 7 minutes with the backoff). | One broken tenant is that customer's bundle; five at once is the platform. |
| `release` | A rollout or rollback is paused. | The runner stopped on a failure and waits for the owner (RELEASING.md). |
| `config` | Mail, billing or provisioning is missing a setting. | Yes or no only: the endpoint never says which setting, or anything about its value. |

Cheap by construction (`platform/test/observability.test.ts` checks each query plan and the rows read):

- one D1 batch of six reads, each by primary key or over a partial index that holds only the rows in trouble, so a healthy platform reads about a dozen rows whatever its size;
- the overdue and failing counts stop at 1,000;
- the report is kept 15 seconds in the isolate, so a flood of checks costs about one batch per isolate per 15 seconds;
- never a per-tenant scan, never a call to a tenant, Cloudflare's API, Stripe or Resend.

## 4. The Operations tab

`app.<domain>/admin/operations`, for the owner only (the console's usual passkey rules), designed phone first and checked at 390x844, 360x800 and 1440x900:

- the same checks as `/__health`, computed fresh, with what is wrong in plain words;
- right now: queue lag, tenants overdue, tenants failing, runs a minute;
- for the last 15 minutes, hour and day: runs a minute, failed runs (and their share), timeouts, p95 and average duration, average and worst queue lag, failed checks;
- the last 24 hours by hour;
- the 10 longest failing tenants and the 10 longest overdue, each linked to its tenant page.

The run metrics come from `scheduler_minutes` (migration 0010): one row per UTC minute, added to once per queue consumer batch, with each run's duration counted in fixed buckets (250 ms up to 60 s).
The p95 is the upper bound of the bucket the 95th percentile falls in ("up to 2.0 s"), which shows a slowdown without storing every run.
Rows are kept 8 days.

## 5. Alerting: the monitors to create

On the owner's OpenPing at `https://openping.n8builds.dev`, once Hosted is deployed (staging first, with `staging.<domain>`).
The main session runs these from the owner's machine after review; agents never do.
A plain install checks every monitor on its 12-minute cron, so the owner's install notices within about 12 minutes plus the 5-second confirmation; the outside checker (section 7) is every 5 minutes.

### Before: the variables

```sh
# The owner's install and an API token from its Developers page (docs/CLI.md).
export OPENPING_URL=https://openping.n8builds.dev
export OPENPING_TOKEN=...            # from Developers > Create token, kept in the password manager
export HOSTED_DOMAIN=...             # decision D2, once bought
export CANARY_SLUG=...               # the owner's own test tenant, the same as RELEASE_CANARY

# The notification channels to alert (the owner's email or push channel): their ids.
npm run op -- channels list
export CHANNELS='["ch_..."]'         # a JSON array of channel ids

api() { curl -fsS -H "authorization: Bearer $OPENPING_TOKEN" -H "content-type: application/json" "$OPENPING_URL$1" "${@:2}"; }
```

### The category the public page shows

```sh
CATEGORY=$(api /api/categories -X POST -d '{
  "name": "OpenPing Hosted",
  "slug": "openping-hosted",
  "description": "The managed OpenPing service at '"$HOSTED_DOMAIN"'"
}' | jq -r .category.id)
echo "$CATEGORY"
```

### The five monitors

1. **Hosted platform health** (private, the one that pages the owner): any failing check is a 503.

   ```sh
   api /api/monitors -X POST -d '{
     "type": "http",
     "name": "Hosted platform health",
     "config": { "url": "https://app.'"$HOSTED_DOMAIN"'/__health", "expectedStatus": { "min": 200, "max": 200 }, "timeoutMs": 15000 },
     "assertions": [{ "kind": "json_path_equals", "path": "ok", "value": "true" }],
     "notify": { "channels": '"$CHANNELS"' },
     "public": { "visible": false },
     "confirmFailures": "retry"
   }'
   ```

2. **Checks and alerts** (public): only the parts customers feel, whether their checks run on time; a paused release or missing billing setting stays off the public page.

   ```sh
   api /api/monitors -X POST -d '{
     "type": "http",
     "name": "Hosted scheduler",
     "categoryId": "'"$CATEGORY"'",
     "config": { "url": "https://app.'"$HOSTED_DOMAIN"'/__health", "expectedStatus": { "min": 200, "max": 503 }, "timeoutMs": 15000 },
     "assertions": [
       { "kind": "json_path_equals", "path": "checks.database.ok", "value": "true" },
       { "kind": "json_path_equals", "path": "checks.cron.ok", "value": "true" },
       { "kind": "json_path_equals", "path": "checks.queue.ok", "value": "true" },
       { "kind": "json_path_equals", "path": "checks.scheduler.ok", "value": "true" }
     ],
     "notify": { "channels": '"$CHANNELS"' },
     "public": { "visible": true, "name": "Checks and alerts", "description": "Customers' monitors are checked on time" },
     "confirmFailures": "retry"
   }'
   ```

3. **Sign-in and accounts** (public): the platform Worker and its database, through the simplest path.

   ```sh
   api /api/monitors -X POST -d '{
     "type": "http",
     "name": "Hosted app",
     "categoryId": "'"$CATEGORY"'",
     "config": { "url": "https://app.'"$HOSTED_DOMAIN"'/healthz", "expectedStatus": { "min": 200, "max": 200 }, "timeoutMs": 15000 },
     "assertions": [{ "kind": "json_path_equals", "path": "db", "value": "ok" }],
     "notify": { "channels": '"$CHANNELS"' },
     "public": { "visible": true, "name": "Sign-in and accounts", "description": "app.'"$HOSTED_DOMAIN"'" },
     "confirmFailures": "retry"
   }'
   ```

4. **Dashboards and status pages** (public): a real customer path end to end, through the dispatch namespace, the canary's user Worker and its own database.
   It reads the canary's public status API, so the canary's status page must be turned on (its Settings, Status page, Enabled).

   ```sh
   api /api/monitors -X POST -d '{
     "type": "http",
     "name": "Hosted canary tenant",
     "categoryId": "'"$CATEGORY"'",
     "config": { "url": "https://'"$CANARY_SLUG"'.'"$HOSTED_DOMAIN"'/api/public/status", "expectedStatus": { "min": 200, "max": 200 }, "timeoutMs": 15000 },
     "assertions": [{ "kind": "json_path_equals", "path": "enabled", "value": "true" }],
     "notify": { "channels": '"$CHANNELS"' },
     "public": { "visible": true, "name": "Dashboards and status pages", "description": "Customers'"'"' OpenPing at <name>.'"$HOSTED_DOMAIN"'" },
     "confirmFailures": "retry"
   }'
   ```

5. **The Hosted domain's registration** (private): a lapsed domain takes every customer down at once.

   ```sh
   npm run op -- monitors create --type domain --name "Hosted domain expiry" --domain "$HOSTED_DOMAIN" --warn-days 30 --channels "$(echo "$CHANNELS" | jq -r 'join(",")')"
   ```

Check them with `npm run op -- monitors list` and `npm run op -- status`; each create prints its first check.
Before launch, with no customers and billing still in test mode, monitor 1 is red only if a setting is missing, which is what it should say.

## 6. The public status page

Served from the owner's install, so it stays up when Hosted is down, at `https://openping.n8builds.dev/status/hosted`.

```sh
api /api/status-pages -X POST -d '{
  "slug": "hosted",
  "name": "OpenPing Hosted status",
  "description": "Live status of OpenPing Hosted. Incidents and maintenance are posted here.",
  "enabled": true,
  "includeMode": "categories",
  "categoryIds": ["'"$CATEGORY"'"],
  "theme": "system",
  "homepage": "https://app.'"$HOSTED_DOMAIN"'"
}'
```

- It shows the three public monitors of section 5 (Checks and alerts, Sign-in and accounts, Dashboards and status pages) and nothing about the owner's other apps, since it includes only the `openping-hosted` category.
- Incidents opened by those monitors appear on it; the owner posts updates with `npm run op -- incidents update <id> --status identified --message "..."`, and schedules maintenance (for example before a release with migrations) with `npm run op -- maintenance create --title "..." --monitors <ids>`.
- Feeds come with it: `/status/hosted/feed.rss` and `/status/hosted/feed.atom` (docs/STATUS_PAGES.md).
- Link it from the Hosted footer and the account pages once it exists (a later small PR in `platform/src/ui.ts`).

Optional, a short address: `status.<domain>` as a Cloudflare Redirect Rule on the Hosted zone (Rules, Redirect Rules, "Static", `https://openping.n8builds.dev/status/hosted`, 302, with a proxied DNS record for `status`).
A redirect, not a second install, keeps one source of truth.

## 7. The outside checker

**UptimeRobot, free plan** (checked 2026-10-28: 50 monitors, 5-minute interval, keyword monitors, email alerts, "good for personal and commercial projects").
It runs outside Cloudflare, so it sees what neither the platform nor the owner's install can: a Cloudflare outage, a broken account, a DNS or certificate problem on the Hosted domain.
Create in its dashboard (an owner action, one time):

| Monitor | Type | URL | Alert when |
| --- | --- | --- | --- |
| Hosted health | Keyword, "alert if not exists" | `https://app.<domain>/__health` | `"status":"ok"` is missing (a 503, a timeout or a degraded report) |
| Hosted canary | Keyword, "alert if not exists" | `https://<canary>.<domain>/api/public/status` | `"enabled":true` is missing |
| The status page itself | HTTP(s) | `https://openping.n8builds.dev/status/hosted` | not 2xx: the watcher is down |

Alerts go to the owner's email (and the UptimeRobot app, for push).
If the 5-minute interval or the 5-integration limit ever matters, Better Stack's free plan is the next choice; either way, keep it a service that doesn't run on Cloudflare.

## 8. Costs

Prices from Cloudflare's docs on 2026-10-28: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [Workers Logs pricing](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#pricing) and, from December 1, 2026, [Cloudflare Observability pricing](https://developers.cloudflare.com/observability/pricing/) (Paid: 50 GB of ingestion included per billing cycle, then $0.25 per GB; 10 GB-month of storage included, then $0.10 per GB-month).

### Per checker checking once a minute

| Item | A month (43,200 checks) | Cost |
| --- | --- | --- |
| Platform Worker requests | 43,200 | $0: Workers Paid includes 10 million (then $0.30 a million, so $0.013) |
| CPU | about 2 ms each, 86,400 ms | $0: 30 million ms included |
| D1 rows read | at most 6 statements and about 12 rows per computation, so at most 520,000 | $0: 25 billion included |
| D1 rows written | none | $0 |
| Workers Logs | one invocation log each (a healthy check writes no line of its own), about 43,000 events, about 45 MB | $0 inside 20 million events (to December 1) or 50 GB (after) |

So a checker costs nothing measurable, and the 15-second cache means extra checkers cost even less: five checkers at once still read the database about four times a minute per isolate.
The real monitors check far less often: the owner's install every 12 minutes, UptimeRobot every 5.

### What C4 adds to the platform's own running cost

- **Heartbeats:** 2 rows written a minute, 86,400 a month, against 50 million included.
- **Run metrics:** one `scheduler_minutes` upsert per consumer batch, which is at most one per run when batches are small (low traffic) and about one per 25 runs when they are full.
  At 2,000 tenants on 1-minute checks that is about 3.5 million rows a month, about $3.50 past the included 50 million; at 200 tenants it is inside the free allowance.
- **The failing index:** written only when a tenant's failure streak changes from or to 0, so a healthy tenant's runs never write it.
- **Logs:** the platform writes one `schedule.batch` line per consumer batch, plus a line per tenant only when its run fails.
  The volume that matters is each user Worker's own invocation log, one per scheduled call and per visitor request: at 200 tenants on 12-minute checks about 0.7 million a month (free); at 2,000 tenants on 1-minute checks about 86 million a month, about $40 before December 1, 2026 at $0.60 a million past 20 million, and about $9 a month after it at 1 KB each (86 GB against 50 GB included).
  The lever is `TENANT_LOG_SAMPLING`: 0.1 cuts the tenants' logs tenfold, at the price of seeing one failure in ten; only worth it at that scale.

## 9. What to do when it alerts

| Alert | First look | Usually |
| --- | --- | --- |
| Health 503, `cron` | Workers dashboard, `openping-platform`, Triggers and Logs (`event = "cron.cleanup_failed"`) | A deploy without the cron trigger, or the Worker throwing at the start of `scheduled`. |
| Health 503, `queue` | Logs, `event = "schedule.enqueue_failed"` or `"schedule.queue_refused"` | The queue or its binding; the claims free themselves after 3 minutes. |
| Health 503, `scheduler` | Operations tab, Overdue tenants; logs `schedule.batch` | The consumer is down or slow (a batch near 90 seconds); see the risk "One cron can't reach every customer in time" in the build plan. |
| Health 503, `tenants` | Operations tab, Failing tenants, their errors | A bad release (look at Releases, roll back), or a Cloudflare problem in the namespace. |
| Health 503, `release` | Admin console, Releases | Resume, skip the failures, or roll back (RELEASING.md). |
| Health 503, `config` | `wrangler secret list` for the platform, from the owner's machine | A secret lost in a redeploy. |
| Health 503, `database` | Cloudflare status page, D1 | A D1 incident; nothing to do but wait and post an incident. |
| Canary down, health fine | The canary's tenant page in the console (its live health), logs with `$metadata.service = "t-<canary id>"` | The canary's own bundle or database; customers on the same version may be next. |
| Only the outside checker alerts | Cloudflare's status page | A Cloudflare or DNS problem; post an incident on the status page by hand. |
