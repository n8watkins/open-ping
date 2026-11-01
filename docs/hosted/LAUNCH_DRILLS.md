# OpenPing Hosted: the launch drills

This is the runbook for the two drills the Hosted build plan asks for before launch ([build plan, section 9](../HOSTED_BUILD_PLAN.md#9-testing-and-staging) and [section 14](../HOSTED_BUILD_PLAN.md#14-definition-of-done-for-launch)): the load test and the restore drill.
Both run from the owner's machine against staging only, and both are built so that nothing in them can reach production.
The code is in [`scripts/hosted-drills/`](../../scripts/hosted-drills/).

Agents never run these against a real account.
The owner, or the main session with the owner, runs them once staging is up.

## Contents

1. [What each drill proves](#1-what-each-drill-proves)
2. [Safety](#2-safety)
3. [What you need](#3-what-you-need)
4. [The load test](#4-the-load-test)
5. [The restore drill](#5-the-restore-drill)
6. [With or without Workers for Platforms](#6-with-or-without-workers-for-platforms)
7. [Testing the drills themselves](#7-testing-the-drills-themselves)

## 1. What each drill proves

**The load test:** 200 tenants with 20 monitors each against staging for an hour.
It passes when all of these hold over the measured hour:

| Target | Pass | Where it is measured |
| --- | --- | --- |
| Missed scheduler runs | 0 | Every run of every load-test tenant, from `scheduler_stats` sampled every minute |
| Queue lag | under 60 seconds, the maximum of every run | The platform's own lag per run (`last_lag_ms`) and per minute (`scheduler_minutes.lag_max_ms`) |
| Runs without a clean answer | 0 (`failed`, `error` or `timeout`) | The same samples |
| `GET app.<staging domain>/__health` | 200 and `ok` on every check, every minute | The health endpoint, as an outside monitor sees it |
| Cost per tenant a month | at most $0.83 | D1 rows and Worker CPU from Cloudflare's GraphQL Analytics, priced as [the cost model](../HOSTED_PLAN.md#cost-per-customer-measured) does |

The $0.83 is the cost model's worst case for the base plan (20 monitors at 12-minute checks, launch pricing in [HOSTED_PLAN.md](../HOSTED_PLAN.md)).
It replaces the earlier 6-cent assumption, which the measurements of 2026-10-29 superseded.
The report also gives queue lag at p50 and p95, call durations, checks and failed checks, D1 rows read and written per tenant, and CPU per request at p50 and p99.

**The restore drill:** a staging tenant's database is deleted, then created again and restored from the platform's own export, with the key escrowed for it.
It passes when:

- every table has the same number of rows after the restore as before;
- every row of the key tables (monitors and their state, incidents, maintenance, channels, settings, categories, status pages, passkeys, API tokens, push subscriptions, the migration history) is the same, by SHA-256;
- every encrypted value in them (monitor configs, encrypted settings, channel credentials) decrypts with the escrowed `MASTER_KEY` to the same SHA-256 before and after;
- the key kept with the export is the tenant's escrowed key;
- the platform uploads the tenant again bound to the new database, it is `ready`, and its first scheduled run answers `ran`;
- after that run, its encrypted values still decrypt to the same hashes.

## 2. Safety

Every command checks these before it runs anything:

- `--env staging` is given, and nothing else is accepted.
- The `--config` file is a staging platform config: its Worker name, its D1 databases, its dispatch namespaces, its R2 buckets, its queues and its `DISPATCH_NAMESPACE` all end in `-staging`, and `HOSTED_DOMAIN` has a `staging` label.
  The repository's `platform/wrangler.jsonc`, the production config, fails every one of these checks.
- A run that changes anything also needs `--confirm <the staging Worker's name>`, for example `--confirm openping-platform-staging`.
- The restore drill only deletes a database whose name is `openping-t-<that staging tenant's id>` and whose id is the one the staging tenant row names, checked again just before the delete.
- The load test only touches tenants whose slug is `lt-<run>-...` and whose account email is on `loadtest.invalid`, a domain no mail is ever delivered to.

Every remote command is printed before it runs, marked `read` or `change`.
`--print` prints them all and runs none, `--dry-run` runs only the reads.
No secret is ever on a command line or in a printed line: `PLATFORM_KEY` is read from the environment and used in memory, the analytics token is printed as `<redacted>`, and SQL that carries ciphertext goes in a file.
The drills write their state, reports and downloads to `.hosted-drills/` (gitignored), with the restore drill's dump readable only by you and deleted when the drill passes.

## 3. What you need

- Staging up and working: the staging platform Worker, its database, its dispatch namespace (or, in starter mode, its Workers), its queues, its bundles and exports buckets, a release made current with `npm run tenant-release -- start` and the staging options ([RELEASING.md](../../RELEASING.md#openping-hosted)), and every provisioning setting set, so a sign-up becomes `ready`.
- The staging platform config on your machine, outside git, for example `platform/.wrangler.staging.jsonc`: the repository's `platform/wrangler.jsonc` with every name changed to its `-staging` form and `HOSTED_DOMAIN` set to `staging.<domain>`.
- `npx wrangler login` to the account, or `CLOUDFLARE_API_TOKEN` with D1 Edit, Workers Scripts Edit and R2 read on it.
- `OPENPING_PLATFORM_KEY`: the staging platform's `PLATFORM_KEY`, from the password manager.
  The load test opens each tenant's escrowed key with it to seal their monitors, and the restore drill to decrypt.
  Staging must have its own `PLATFORM_KEY`, never production's.
- For the load test's cost, `CLOUDFLARE_ANALYTICS_TOKEN` (a token with only **Account Analytics Read**) and `CLOUDFLARE_ACCOUNT_ID`.
  Without them the report says the cost wasn't measured and the verdict is "incomplete"; `report` fetches them again later.
- No release in progress on staging, for either drill.

Set the variables for the session only, for example:

```bash
read -rs OPENPING_PLATFORM_KEY && export OPENPING_PLATFORM_KEY
read -rs CLOUDFLARE_ANALYTICS_TOKEN && export CLOUDFLARE_ANALYTICS_TOKEN
export CLOUDFLARE_ACCOUNT_ID=<32 hex characters>
CONFIG=platform/.wrangler.staging.jsonc
```

## 4. The load test

```bash
npm run hosted-load -- plan --env staging --config $CONFIG
npm run hosted-load -- seed --env staging --config $CONFIG --confirm openping-platform-staging --tenants 200 --monitors 20
npm run hosted-load -- run --env staging --config $CONFIG --confirm openping-platform-staging --duration 60m
npm run hosted-load -- report --env staging --config $CONFIG
npm run hosted-load -- cleanup --env staging --config $CONFIG --confirm openping-platform-staging
```

**`plan`** prints what the run creates, how long each part takes and what it measures, then every command of `seed`, `run` and `cleanup` in order, and runs none.

**`seed`** takes about 30 minutes for 200 tenants:

1. It deploys the echo Worker (`scripts/hosted-drills/echo-worker/`, `openping-loadtest-echo-staging` on its workers.dev address) and checks it answers.
   It answers `/ok` at once, and fails on purpose on three of each tenant's 20 monitors: `/flaky` fails about 10% of minutes, `/slow` answers after 1.5 seconds, and `/window` is down from :20 to :29 every hour, so incidents open, confirm from another region and resolve.
   `--echo-url <url>` uses one already deployed instead.
2. It adds the tenants as rows of the staging platform database, each on the paid plan (`active`, `hosted`, so 20 monitors fit and no trial applies) with its welcome email recorded as sent.
3. It waits while the platform's own provisioning sets each one up, as for a sign-up: it generates and escrows its `MASTER_KEY`, creates its D1 database, uploads the current bundle, migrates it and checks its health.
   The sweep takes about 10 tenants a minute.
   If provisioning pauses one, the seed stops and names it: fix the cause, resume it in the admin console, then `seed --run <id>` carries on.
4. It adds each tenant's 20 monitors straight into its database, sealed with the tenant's own key, exactly as the app stores them (`test/integration/hosted-drills.test.ts` holds the SQL to `createMonitor`).

**`run`** samples for 13 minutes of warm-up (`--warmup`) and then the measured `--duration` (60 minutes), every `--every` (60 seconds): `/__health`, and one query of the run's tenants' `scheduler_stats`.
Afterwards it reads the platform's `scheduler_minutes` for the window (the Operations tab's numbers), the tenants' database ids, and the GraphQL Analytics for the window.
It writes `.hosted-drills/load-<run>-report.md` (and `.json`), prints it, and exits 0 for a pass, 1 for a fail, and 3 when something wasn't measured.
Watch the admin console's Operations tab meanwhile: it shows the same runs, failures, timeouts and lag.

**`report`** writes the report again from the saved samples, fetching the analytics if they were missing (Cloudflare's analytics can take a few minutes to arrive).

**`cleanup`** marks the run's tenants for removal, as the platform's own removal does, and waits while the platform's teardown deletes each one's Worker, database, escrowed key and row (about 20 minutes).
Then it deletes what the teardown keeps on purpose (the held slugs, the run's history rows and accounts) and the echo Worker.
Run it even after a failed run.
If Wrangler asks to confirm the echo Worker's deletion, answer yes, or delete `openping-loadtest-echo-staging` in the dashboard.

Reading the result:

- A failed check is expected on the three scripted monitors, about 3 in 20 at most.
  If nearly every check fails, the tenants can't reach the echo Worker on workers.dev: deploy it on a route of a zone in the account and pass `--echo-url`.
- Missed runs name the tenants; look at them in the admin console's Scheduler section.
- Queue lag over a minute is the signal in the build plan's risk table: shard the queue or move due tracking to a Durable Object per tenant group.
- Cost over $0.83 a tenant: compare the D1 rows written per tenant with the cost model's 199 rows a call.
  A new tenant's database has no history, so its reads are lower than a two-month-old install's.
  CPU is priced at its p99 per request, so it is a ceiling.

**Pass criteria for launch:** a report whose verdict is PASS for 200 tenants with 20 monitors over 60 minutes, kept with the launch notes, and `cleanup` done.

## 5. The restore drill

Pick a staging tenant with monitors (the canary works) and run:

```bash
npm run hosted-restore-drill -- --env staging --config $CONFIG --tenant <slug> --dry-run
npm run hosted-restore-drill -- --env staging --config $CONFIG --tenant <slug> --confirm openping-platform-staging
```

The dry run looks the tenant up, opens its escrowed key, fingerprints its database for real, and prints every change it would make.
The drill takes 10 to 30 minutes, mostly waiting for the platform's cron, and the tenant is off the air from step 2 to step 11.
Its steps, each saved to `.hosted-drills/restore-<slug>-<time>.json` before the next:

1. **preflight:** the tenant is `ready` and not suspended, no release or export is running, its escrowed key opens with `PLATFORM_KEY`, its database is the one its row names, and it holds encrypted values that open with that key (with none, there is nothing to prove: add a monitor).
2. **quiesce:** the tenant's provisioning state becomes `db_created`, paused, so the platform neither routes visitors to it nor runs its scheduler, and the drill waits out a run in flight and the route cache.
   The admin console shows it as paused provisioning, with the drill's note.
3. **fingerprint-before:** every table's rows, the key tables' checksums, and the hash of every encrypted value decrypted.
4. **export:** an export of the tenant's database, the same one a deletion and a customer's own export use, made by the platform's lifecycle job within 5 minutes; the drill waits for it.
5. **download:** the dump from the exports bucket, checked against the export's size and SHA-256, and the key kept with the export opened and compared with the tenant's.
6. **delete-database:** `wrangler d1 delete openping-t-<id>`.
7. **create-database:** `wrangler d1 create openping-t-<id>`, the same name with a new id.
8. **import:** `wrangler d1 execute openping-t-<id> --remote --file <the dump>`, the step an export's own README gives a customer.
9. **fingerprint-after:** must equal step 3, or the drill fails here.
10. **rebind:** the tenant row gets the new database id and its pause is lifted, so the platform's provisioning uploads it again as at sign-up: the current bundle, bound to the new database, with the escrowed `MASTER_KEY`.
11. **wait-ready:** provisioning reaches `ready` on the new database.
12. **wait-run:** the tenant's next scheduled run answers `ran`.
13. **verify-live:** after that run, its encrypted values still decrypt to the same hashes.

If anything fails before step 6, the drill puts the tenant back as it was.
If something fails after it, the tenant stays off the air and the drill prints how to finish: fix the cause, then run the same command with `--continue .hosted-drills/restore-<slug>-<time>.json` in place of `--tenant`.
The export stays in the exports bucket for 7 days either way, and `--keep-dump` keeps the local copy.

The tenant comes back on the current release, which may be newer than the one it ran; the drill says so.
Its Durable Object state (the second-region probe's, which keeps nothing a restore needs) starts again, as on any upload from scratch.

**Pass criteria for launch:** the drill ends with "Restore drill of <slug>: passed", and its summary (tables, rows, decrypted values, how long the tenant was off the air) goes into the launch notes.

## 6. With or without Workers for Platforms

Both drills work in either mode of the platform: with Workers for Platforms, and in starter mode (tenants as ordinary Workers with Workers Custom Domains).
Neither uploads, routes or deletes a tenant Worker itself: the load test's tenants are set up and torn down by the platform's provisioning, and the restore drill rebinds a tenant through provisioning's `db_created` step, so each does whatever the platform's mode does.
What they touch directly is the staging platform database, the tenants' D1 databases by name, the exports bucket and the echo Worker, which are the same in both modes.
The staging guard checks the dispatch namespace names only when the config has them.
GraphQL Analytics finds a tenant's CPU by its Worker's name, `t-<tenant id>`, in both modes.

## 7. Testing the drills themselves

```bash
npx vitest run scripts/hosted-drills/                                         # the commands end to end, the report's math, the guard
npx vitest run --config platform/vitest.config.ts platform/test/drills.test.ts   # their SQL against the real provisioning
npx vitest run --config vitest.integration.config.ts test/integration/hosted-drills.test.ts   # seeded monitors against createMonitor and the scheduler
```

The first runs both commands against a fake staging account (`scripts/hosted-drills/testing/fake-staging.mjs`): Wrangler's commands, the health endpoint, the echo Worker and GraphQL Analytics, over real SQLite with the real platform and OpenPing migrations, with the platform's cron played every time a drill waits.
It covers the order of every change, the refusals, a stop before and after the point of no return, `--continue`, `--print` and `--dry-run`, a missed run and a slow queue failing the report, and cleanup leaving nothing behind.
