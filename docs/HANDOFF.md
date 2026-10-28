# OpenPing handoff

This document is the current zero-context handoff for continuing work on OpenPing.

Last updated: 2026-10-28.

## Current state (2026-10-28): start here

- `main` has round 2 (rebuilt landing page, signed-in app UI, a scheduler that stays inside Cloudflare's free-plan limits, Cloudflare Web Analytics allowed in the CSP, no em dashes) and Hosted stage 1 (PR #12: "Runs in your own Cloudflare account" wording, a pricing section, a waitlist at `/api/waitlist`, the `/install` guide, the waitlist count and CSV in Settings).
- **Live:** v0.2.0 was deployed to https://openping.n8builds.dev on 2026-10-28, with migrations through 0011 applied and the waitlist on.
  It adds the off-hours fix (#15), one strict security header policy for every page and the widget on the bare n8builds.dev (#16), idle scheduler runs of 3 database calls instead of about 160 (#17), and the `deploy:prod` flow (#14).
  A D1 export taken just before the deploy is in `../open-ping-backups/` on the owner's machine.
- The paid hosted version is planned in [the Hosted plan](./HOSTED_PLAN.md): stages 0 to 7, each with a go/no-go gate.
  Chosen pricing: $24 a year (20 monitors, 12-minute checks, 2 status pages), plus $12 a year for 1-minute checks; no free hosted plan.
  Gate after stage 1: about 20 waitlist sign-ups within 8 weeks.
- **MCP server and wider CLI (branch `feat/mcp-and-cli`, not yet deployed):** `/mcp` is a stateless Streamable HTTP MCP server built on the official `@modelcontextprotocol/server` SDK (v2), with 20 tools that reuse the REST API's validation and data functions; see [MCP.md](./MCP.md).
  It needs `API_TOKEN` (404 without it), accepts only the bearer token, refuses cross-origin browser requests and allows 120 authenticated requests a minute.
  `scripts/op.mjs` now covers status, monitors, incidents, uptime, diagnostics, channels, pages, categories and maintenance, with `--json`, per-command `--help`, errors on unknown flags and `--yes` for deletes; see [CLI.md](./CLI.md).
  New REST routes back both: `PATCH /api/monitors/:id`, `PATCH /api/status-pages/:id`, `GET /api/monitors/uptime` and `POST /api/maintenance/:id/end`.
  The Worker grew from 173 KiB to 272 KiB gzipped (Free plan limit: 3 MB).
  After deploying, connect with `claude mcp add --transport http openping https://openping.n8builds.dev/mcp --header "Authorization: Bearer $OPENPING_TOKEN"` and call `get_status`.
- **Confirm before alerting and first check right away (branch `feat/confirm-before-alert`, not yet deployed, migration 0014):** a failed check is re-checked once 5 seconds later before it opens an incident ("Confirm failures", per monitor, default on), and a new monitor is checked as it is created; SSL expiry research is in [SSL_EXPIRY_SPIKE.md](./SSL_EXPIRY_SPIKE.md).
- **Landing and sign-in, stage 1 (branch `feat/landing-two-paths`, not yet deployed):** the hero shows both paths (free in your own Cloudflare, Hosted at $24 a year, "Not open yet"), sign-in is out of the header and is "Owner sign-in" in the footer, and every sign-in screen says whose OpenPing it is ([the landing plan](./LANDING_AND_LOGIN_PLAN.md), section 6, items 1.0 to 1.9).
  `HOME_PAGE` (wrangler var) picks what signed-out visitors see at `/`: `"status"` (default) for the install's own status page, `"landing"` for the marketing page, which only openping.n8builds.dev sets.
  Landing click counts go to `POST /api/events` (allow-listed names, daily totals in `page_events`, migration 0012, rate limited by the `EVENT_LIMITER` binding) and show in Settings; only a `"landing"` install counts.
  Before deploying it: add `"HOME_PAGE": "landing"` to `vars` in `deploy.local.json`, and run `npm run db:migrate:prod` for 0012.
- **Status communication (branch `feat/incident-updates-feeds`, not yet deployed):** incident status updates on the public page, RSS/Atom feeds per status page, the monthly uptime report (Settings > Reports, CSV, opt-in email, REST, MCP, CLI), never-checked services show "No data yet", and hourly rollups are kept 64 days; migration 0013 adds `incident_updates` ([STATUS_PAGES.md](./STATUS_PAGES.md)).
- Tagline everywhere: "Uptime monitoring on your own Cloudflare".
- `v0.1.0` is a baseline tag at `5ff032c`; releases since then are cut with release-kit.

### How production is deployed

Production's own values live in a gitignored `deploy.local.json` in the main checkout: the real D1 `database_id` and `"vars": { "WAITLIST_ENABLED": "true", "HOME_PAGE": "landing" }`.
Without `HOME_PAGE` "landing", openping.n8builds.dev would show its status page at `/` instead of the marketing page.
`wrangler.jsonc` keeps the template's placeholder, so never run the plain `db:migrate` or `deploy` scripts for production.

1. Cut a release from an up-to-date `main`: `npm run release -- --dry-run`, then `npm run release -- --push` (see RELEASING.md).
2. `npm run db:migrate:prod` applies any pending migrations to the remote D1.
3. `npm run deploy:prod` builds and deploys with the generated `.wrangler.prod.jsonc`.
4. Verify: `/` shows the marketing page signed out, `/api/public/status`, `/status`, `/embed`, `/install`, `POST /api/waitlist`, sign-in at https://openping.n8builds.dev/login, and `GET /api/diagnostics` with the bearer token after the next cron run.
   Off-hours, check that https://portfolio.n8builds.dev shows the three Render apps as "Asleep"; it reads the public feed.
5. Optional: `RESEND_API_KEY` for waitlist confirmations; `WORKERS_PLAN` "paid" if on Workers Paid.

### Next

1. During operating hours (weekdays 08:00 to 17:00 Los Angeles), check that the three Render monitors return to `operational` within one cron run, and that `GET /api/diagnostics` shows `d1Queries` per run.
2. Watch the waitlist and the landing counts in Settings for 8 weeks; start stage 2 (batched writes, second-region confirmation) and stage 3 (a Workers for Platforms prototype) only when the owner says so.

The sections below describe the July pass and are still accurate for architecture, verification and conventions.

## Project summary

OpenPing is an open-source, single-administrator uptime monitor and public status page that runs in the owner's Cloudflare account.
Its distinguishing feature is schedule-aware monitoring, so applications can be checked only during operating hours without scheduled downtime reducing uptime.

The stack is a Cloudflare Worker with Hono and Zod, Cloudflare D1, and a React 19, Vite, and Tailwind CSS v4 single-page application.
The Worker runs a scheduled monitoring cycle every 12 minutes and supports HTTP, heartbeat, DNS, TCP, and domain-expiry monitors.
Authentication supports GitHub OAuth, email magic links, and a separate bearer token for the administrative CLI.

The source branch is `main` in `https://github.com/n8watkins/open-ping.git`.
The production custom domain is `https://openping.n8builds.dev`.

## Work completed in the current pass

The monitoring workspace was restyled toward the UptimeRobot reference with a permanent side navigation, compact monitor table, current-status summary, recent analytics, search, filtering, sorting, and responsive behavior.
The uptime and incident summaries now use real metrics instead of placeholders.
The setup flow now supports GitHub-only, email-only, or combined administrator identity configuration.
The setup wizard now contains only actionable prerequisite steps and gives clear monitor and integration guidance on its finish screen.
The monitor workspace now has URL-aware search, category grouping, pause/resume/delete bulk actions, per-row action menus, a monitor-type split menu, type-specific editor entry, and a mobile layout without horizontal overflow.

The security pass made these changes:

- First-run setup now requires both a valid `SETUP_TOKEN` and a valid 32-byte `MASTER_KEY`.
- Public authentication and setup flows now have rate limits and stricter input limits.
- Untrusted URLs, CSV output, headers, and request boundaries received additional validation and hardening.
- Complete monitor configuration blobs are sealed with AES-GCM under `MASTER_KEY`.
- Web Push endpoint and key material are encrypted at rest, with a SHA-256 endpoint hash used for identity and deletion.
- Heartbeat ingestion bearer tokens are stored as SHA-256 hashes and are returned only when created or rotated.
- Backup import now returns replacement heartbeat credentials once and remaps scoped maintenance windows to the newly created monitor IDs.
- Vitest was upgraded beyond the dependency advisories reported by the previous audit.

The principal implementation commits are:

- `c0c75dd` fixes nested SPA development routes.
- `caf06a0` refreshes the monitoring workspace.
- `71c8cdd` upgrades Vitest past known advisories.
- `2635b22` protects first-run setup from takeover.
- `1bab1ec` hardens untrusted input boundaries.
- `350d379` rate-limits public authentication flows.
- `91c8cb4` supports email administrators during setup.
- `6418a11` shows real monitor analytics.
- `ae29ba4` requires encryption for setup.
- `079af6f` seals complete monitor configurations.
- `0c8ded6` encrypts push subscription secrets.
- `0f36f4f` hashes heartbeat ingestion tokens.
- `cd381cb` preserves relationships and one-time credentials during restore.
- `763cb64` refreshes setup and operator guidance.
- `ce97a17` documents secret storage boundaries.
- `3882beb` updates secure backup and heartbeat workflows.
- `e35b5fa` removes unportable category references from backups.
- `991eada` documents local build secret artifacts.
- `65c96d5` completes monitor-list workspace actions and responsive behavior.
- `192de3d` makes the build restrict generated development-secret artifacts.
- `70a05b9` streamlines the setup wizard and accepts an empty unused administrator identity field.
- `aa2cb16` adds workerd integration tests that apply the real D1 migrations and exercise an authenticated heartbeat-monitor lifecycle.
- `c18b7b1` verifies backup restore credentials and related-record remapping against D1.
- `0b5f847` verifies missed-heartbeat scheduler transactions, incident deduplication, rollups, and run diagnostics against D1.
- `a83e08d` adds removed-channel notification outbox integration coverage.
- `4764547` exercises that coverage through the authenticated channel lifecycle after `no-mistakes` review.
- `cbf8db4` merges the validated notification dispatcher PR into `main`.
- `62ca537` covers successful provider delivery and due polled-monitor scheduling against workerd and D1.
- `4da7174` encrypts generic webhook capabilities and notification outbox payloads, upgrades legacy plaintext records, and fails closed on unreadable payload ciphertext.
- `1e41ddb` rejects structurally invalid notification payloads before any external provider call.

The documentation pass adds an explicit security and storage inventory, corrects installation and recovery instructions, documents heartbeat behavior, and labels historical review material as historical.

## Database and external state

Migrations `0008_push_subscription_secrets.sql` and `0009_heartbeat_token_hash.sql` were applied to the remote Cloudflare D1 database named `open-ping` on 2026-07-15.
The remote migration list was verified with no pending migrations.
The remote schema was verified to contain `push_subscriptions.endpoint_hash` and `monitors.heartbeat_token_hash`.

The reviewed application was deployed to the Cloudflare Worker `open-ping` on 2026-07-15.
The public custom domain and the workers.dev URL both returned HTTP `200` after deployment.
Production setup is complete, the setup wizard is locked, and the installation timezone is `America/Los_Angeles`.
The configured GitHub OAuth start flow redirects back to `https://openping.n8builds.dev/auth/github/callback`.
No temporary production monitor remains from verification.
No repository file contains the production D1 resource identifier.

The current encryption and storage model is documented in [SECURITY.md](./SECURITY.md).
Keep the active `MASTER_KEY` backed up outside D1 because Cloudflare cannot reveal it and changing it without re-encrypting existing ciphertext makes that data unreadable.

## Verification state

The final verification completed successfully on 2026-07-15:

- `npm run typecheck` passed.
- `npm test` passed with 458 Node tests across 41 files and six workerd/D1 integration tests in a separate file.
- `npm run build` passed.
- `npm audit` reported zero vulnerabilities.
- `git diff --check` passed.
- All relative link targets in the 18 repository Markdown documents were present.
- `.dev.vars` and the generated `dist/open_ping/.dev.vars` copy have owner-only local file permissions.
- The build lifecycle now reapplies owner-only permissions automatically through `postbuild`.
- The authenticated monitor workspace was verified in a real browser at 1920 by 900 and 390 by 844 viewports with no console errors or error overlay.
- URL search, category grouping, the monitor-type split menu, the row action menu, and a pause-then-resume mutation were exercised against local D1.
- The mobile browser pass verified that document width equals viewport width after the responsive row fix.
- The authenticated setup wizard was browser-verified with five actionable steps, finish-screen guidance, and no error overlay.
- The GitHub-only administrator path was reproduced end to end, which exposed and verified the fix for rejected empty optional email values.
- The deployed authenticated overview, monitor list, and diagnostics APIs returned HTTP `200` with the configured bearer token.
- A temporary heartbeat monitor was created in production, read back with its token redacted, triggered through the public heartbeat endpoint, deleted, and confirmed absent.
- The deployed public status page was browser-verified with all three services and no console errors or error overlay.
- The local workerd integration suite now repeats the authenticated heartbeat lifecycle against D1 with all nine migrations applied and verifies ciphertext storage, one-way token storage, redaction, state and sample writes, and cascade deletion.
- The same integration suite verifies replacement heartbeat credentials, maintenance-window remapping, incident remapping, restored incident privacy, and cleanup during backup import.
- Two consecutive scheduler runs against an overdue heartbeat were verified to keep one open incident and one transition sample while accruing downtime and recording run diagnostics on both cycles.
- Notification outbox idempotency and terminal handling for removed channels are verified against D1 without making an outbound request.
- A due HTTP monitor is verified through the real scheduler, check runner, sample persistence, state update, and run diagnostics against workerd and D1.
- A signed generic webhook is verified through authenticated channel creation, encrypted capability storage, encrypted outbox storage, provider dispatch, and durable success bookkeeping.
- Legacy plaintext webhook capabilities and outbox payloads are verified to upgrade to ciphertext when read or claimed.
- Corrupt or wrong-key outbox ciphertext is verified to fail closed without making an outbound request or blocking the rest of the dispatcher.
- Valid JSON with an invalid notification shape is verified to fail closed without making an outbound request.
- A real production Resend test was accepted by the configured email channel and recorded a fresh successful delivery with no failure or provider error.
- The local and deployed monitor workspaces were browser-verified at 1920 by 900 and 390 by 844 with no runtime errors and no horizontal overflow.
- The latest completed `no-mistakes` review, testing, documentation, lint, push, PR, and CI run finished with outcome `passed`, and GitGuardian passed.

Use the same gate after further changes:

```bash
npm run typecheck
npm test
npm run build
npm audit
git diff --check
git status --short --branch
```

Commit future work on a feature branch, then run `no-mistakes axi run --intent "..."` before merging it into `main`.

## Known gaps and recommended next work

0. The off-hours status fix is live (v0.2.0).
   The public feed, status page, widget and badge used to report off-hours monitors as "operational".
   They now report `scheduled_off` with a `since` time, an all-off page reads "All services are scheduled off" (`all_off`, badge "off hours"), and the `showScheduledOff` option is removed (still accepted and ignored on input).
   The stored `showScheduledOff` key is left in each monitor's `public` JSON and dropped on read; no migration.
   Details: [docs/BUG-public-scheduled-off.md](./BUG-public-scheduled-off.md) and [docs/STATUS_PAGES.md](./STATUS_PAGES.md#off-hours-scheduled-off).

1. `MASTER_KEY` rotation is implemented (dual-key reads, `POST /api/admin/rekey`, Settings > Encryption keys) but has not been run in production; follow [the runbook](./SECURITY.md#rotating-master_key) once the owner has the current key (DEFERRED_INPUTS item 1).

2. Complete live delivery verification.
   Exercise a real browser push subscription, a real push delivery and deep link, a Resend down-and-recovery sequence, a Discord delivery, and at least one real production monitor incident.

3. Add configured-provider integration fixtures.
   The successful webhook path is fully automated and a real Resend test has passed, but Discord and Web Push still need configured test destinations before their live flows can be exercised.

## Inputs or authorization needed

There is no current blocker for additional local implementation or automated testing.
See [Deferred operator inputs](./DEFERRED_INPUTS.md) for the authoritative checklist of production work awaiting operator decisions, credentials, destinations, or devices.

## Important decisions and constraints

- `MASTER_KEY` and `SETUP_TOKEN` are mandatory Worker secrets for a new installation.
- Administrator identities and `APP_URL` may be preconfigured or saved by the setup wizard.
- Raw heartbeat tokens are one-time credentials and cannot be recovered from D1 after creation, rotation, or import.
- Older monitor records are sealed when updated, older notification capabilities are encrypted when read, older outbox payloads are encrypted when claimed, older push subscriptions are encrypted when registered again, and older heartbeat tokens are hashed after successful use or rotation.
- Backup exports exclude credentials but still contain operationally sensitive URLs, names, schedules, settings, and incident history.
- `BUILD_PLAN.md` and `CODE_REVIEW.md` are historical records, not authoritative descriptions of current branch or deployment state.
- Do not commit a real Cloudflare D1 database identifier, `.dev.vars`, `.op-token`, or any production credential.
- Use explicit Tailwind class maps instead of interpolated class names so Tailwind v4 can extract them.
- Preserve the top-level API 404 handling because Hono sub-application `notFound` handlers do not run after route merging.
- Keep `/mcp` mounted before the SPA catch-all in `src/worker/index.ts`, keep MCP tool output at least as redacted as backups (`redactMonitorForMcp`), and keep destructive tools behind `confirm: true`.

## Working conventions

Commit each verified logical change separately with a clear imperative message.
Do not add an automated agent as a co-author.
Do not push or deploy unless the user authorizes that external change.
Do not edit generated changelogs.
Keep every full sentence on its own physical line when substantially editing long Markdown documents.
Use `npm run db:migrate:local` for local D1 migrations and `npm run db:migrate:prod` for the production D1.
Squash-merge PRs with a body you write (`gh pr merge --squash --body "..."`): the default body lists every commit, and one `Release-note: skip` line in it hides the whole PR from the release notes.
release-kit ignores flags it doesn't know, so `npm run release -- --help` cuts a real release; read node_modules/release-kit/README.md instead.

## File map

- `src/worker/index.ts` contains Worker entry points, route mounting, scheduled execution, security headers, and SPA fallback behavior.
- `src/worker/scheduler.ts` orchestrates monitoring checks, maintenance, incidents, notifications, compaction, summaries, and cleanup.
- `src/worker/routes/` contains authenticated, public, setup, heartbeat, push, and import/export APIs.
- `src/worker/mcp/` is the MCP server: `handler.ts` (auth, origin, rate limit, transport), `tools.ts` (the tools) and `format.ts` (ISO times, redaction, result shape).
- `scripts/op.mjs` is the zero-dependency admin CLI; `scripts/op.test.mjs` tests its parser and commands.
- `src/worker/db/` contains D1 access and persistence boundaries.
- `src/worker/lib/secret-config.ts` and `src/worker/lib/crypto.ts` implement sealed configuration storage.
- `src/worker/lib/ssrf.ts` implements outbound target validation.
- `src/worker/notifications/` contains outbox dispatch, email, Discord, Slack, Teams, Telegram, webhook, and Web Push behavior; `src/shared/channel-targets.ts` holds the provider destination checks.
- `test/integration/` contains workerd route tests backed by an isolated migrated D1 database; `mcp.test.ts` drives `/mcp` over JSON-RPC.
- `vitest.integration.config.ts` defines explicit test-only Worker bindings and does not load `.dev.vars`.
- `src/client/pages/Monitors.tsx` is the UptimeRobot-inspired monitoring workspace.
- `src/client/pages/Setup.tsx` is the protected first-run wizard.
- `src/client/pages/MonitorDetail.tsx` exposes one-time heartbeat token rotation.
- `migrations/0008_push_subscription_secrets.sql` adds hashed push identity and encrypted subscription columns.
- `migrations/0009_heartbeat_token_hash.sql` adds hashed heartbeat-token storage.
- `docs/SECURITY.md` is the authoritative secret and storage inventory.
- `docs/INSTALL.md`, `docs/UPGRADE.md`, `docs/BACKUP.md`, and `docs/TROUBLESHOOTING.md` are the primary operator guides.
- `BUILD_PLAN.md` and `CODE_REVIEW.md` are historical snapshots.

## Suggested kickoff prompt

Continue OpenPing from `docs/HANDOFF.md`.
First inspect `git status`, `git log origin/main..HEAD`, and the current verification state without discarding any user changes.
Then complete the highest-priority unblocked next step, keep security boundaries intact, verify the full affected flow, and commit each logical change separately.
