# OpenPing handoff

This document is the current zero-context handoff for continuing work on OpenPing.

Last updated: 2026-07-15.

## Project summary

OpenPing is an open-source, single-administrator uptime monitor and public status page that runs in the owner's Cloudflare account.
Its distinguishing feature is schedule-aware monitoring, so applications can be checked only during operating hours without scheduled downtime reducing uptime.

The stack is a Cloudflare Worker with Hono and Zod, Cloudflare D1, and a React 19, Vite, and Tailwind CSS v4 single-page application.
The Worker runs a scheduled monitoring cycle every 12 minutes and supports HTTP, heartbeat, DNS, TCP, and domain-expiry monitors.
Authentication supports GitHub OAuth, email magic links, and a separate bearer token for the administrative CLI.

The source branch is `main` in `https://github.com/n8watkins/open-ping.git`.
The reviewed application changes through `abb370b` are pushed and deployed.
The D1 integration-test commit `aa2cb16` and this handoff are intended to be pushed after verification, but do not change the deployed Worker bundle.
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

The documentation pass adds an explicit security and storage inventory, corrects installation and recovery instructions, documents heartbeat behavior, and labels historical review material as historical.

## Database and external state

Migrations `0008_push_subscription_secrets.sql` and `0009_heartbeat_token_hash.sql` were applied to the remote Cloudflare D1 database named `open-ping` on 2026-07-15.
The remote migration list was verified with no pending migrations.
The remote schema was verified to contain `push_subscriptions.endpoint_hash` and `monitors.heartbeat_token_hash`.

The reviewed application was deployed to the Cloudflare Worker `open-ping` on 2026-07-15 from commit `abb370b`.
The deployed Worker version is `db37e70c-8584-4b1f-b717-13c9edffc56c`.
The public custom domain and the workers.dev URL both returned HTTP `200` after deployment.
Production setup is complete, the setup wizard is locked, and the installation timezone is `America/Los_Angeles`.
The configured GitHub OAuth start flow redirects back to `https://openping.n8builds.dev/auth/github/callback`.
No temporary production monitor remains from verification.
No repository file contains the production D1 resource identifier.

The current encryption and storage model is documented in [SECURITY.md](./SECURITY.md).
Keep the active `MASTER_KEY` backed up outside D1 because changing it without re-encrypting existing ciphertext makes that data unreadable.

## Verification state

The final verification completed successfully on 2026-07-15:

- `npm run typecheck` passed.
- `npm test` passed with 457 Node tests across 40 files and four workerd/D1 integration tests in a separate file.
- `npm run build` passed.
- `npm audit` reported zero vulnerabilities.
- `git diff --check` passed.
- All relative link targets in the 17 repository Markdown documents were present.
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

Use the same gate after further changes:

```bash
npm run typecheck
npm test
npm run build
npm audit
git diff --check
git status --short --branch
```

## Known gaps and recommended next work

1. Expand D1-backed integration coverage.
   Monitor, heartbeat, backup import, missed-heartbeat scheduler transactions, and removed-channel dispatch are covered, but polled-check scheduling and successful provider delivery should also run against workerd and D1.

2. Close the remaining secret-management gaps.
   Define a safe `MASTER_KEY` rotation and re-encryption workflow, decide whether generic webhook capability URLs and notification outbox payloads require additional sealing, and document any accepted plaintext operational metadata.

3. Complete live delivery verification.
   Exercise a real browser push subscription, a real push delivery and deep link, a Resend down-and-recovery sequence, a Discord delivery, and at least one real production monitor incident.

4. Perform a pixel-level browser pass after deployment.
   Compare the deployed desktop and narrow layouts with the supplied UptimeRobot references, with particular attention to table density, side-panel width, sidebar visibility, control alignment, and empty or loading states.

## Inputs or authorization needed

There is no current blocker for additional local implementation or automated testing.

- Push, deploy, and production smoke-test authorization was granted in the current session.
- Live Web Push verification requires a real browser or installed mobile PWA whose notification permission the user can approve.
- Live Resend and Discord verification requires valid production service configuration plus approval to send test notifications to the configured recipients.
- Creating real production monitors requires the service targets, schedules, notification assignments, and public-page choices from the user.
- A production `MASTER_KEY` rotation requires a maintenance window, a verified backup of the current key and D1 database, and explicit approval before any re-encryption operation.

## Important decisions and constraints

- `MASTER_KEY` and `SETUP_TOKEN` are mandatory Worker secrets for a new installation.
- Administrator identities and `APP_URL` may be preconfigured or saved by the setup wizard.
- Raw heartbeat tokens are one-time credentials and cannot be recovered from D1 after creation, rotation, or import.
- Older monitor records are sealed when updated, older push subscriptions are encrypted when registered again, and older heartbeat tokens are hashed after successful use or rotation.
- Backup exports exclude credentials but still contain operationally sensitive URLs, names, schedules, settings, and incident history.
- `BUILD_PLAN.md` and `docs/CODE_REVIEW.md` are historical records, not authoritative descriptions of current branch or deployment state.
- Do not commit a real Cloudflare D1 database identifier, `.dev.vars`, `.op-token`, or any production credential.
- Use explicit Tailwind class maps instead of interpolated class names so Tailwind v4 can extract them.
- Preserve the top-level API 404 handling because Hono sub-application `notFound` handlers do not run after route merging.

## Working conventions

Commit each verified logical change separately with a clear imperative message.
Do not add an automated agent as a co-author.
Do not push or deploy unless the user authorizes that external change.
Do not edit generated changelogs.
Keep every full sentence on its own physical line when substantially editing long Markdown documents.
Use `npm run db:migrate:local` for local D1 migrations and `npm run db:migrate` for remote migrations.

## File map

- `src/worker/index.ts` contains Worker entry points, route mounting, scheduled execution, security headers, and SPA fallback behavior.
- `src/worker/scheduler.ts` orchestrates monitoring checks, maintenance, incidents, notifications, compaction, summaries, and cleanup.
- `src/worker/routes/` contains authenticated, public, setup, heartbeat, push, and import/export APIs.
- `src/worker/db/` contains D1 access and persistence boundaries.
- `src/worker/lib/secret-config.ts` and `src/worker/lib/crypto.ts` implement sealed configuration storage.
- `src/worker/lib/ssrf.ts` implements outbound target validation.
- `src/worker/notifications/` contains outbox dispatch, email, Discord, webhook, and Web Push behavior.
- `test/integration/` contains workerd route tests backed by an isolated migrated D1 database.
- `vitest.integration.config.ts` defines explicit test-only Worker bindings and does not load `.dev.vars`.
- `src/client/pages/Monitors.tsx` is the UptimeRobot-inspired monitoring workspace.
- `src/client/pages/Setup.tsx` is the protected first-run wizard.
- `src/client/pages/MonitorDetail.tsx` exposes one-time heartbeat token rotation.
- `migrations/0008_push_subscription_secrets.sql` adds hashed push identity and encrypted subscription columns.
- `migrations/0009_heartbeat_token_hash.sql` adds hashed heartbeat-token storage.
- `docs/SECURITY.md` is the authoritative secret and storage inventory.
- `docs/INSTALL.md`, `docs/UPGRADE.md`, `docs/BACKUP.md`, and `docs/TROUBLESHOOTING.md` are the primary operator guides.
- `BUILD_PLAN.md` and `docs/CODE_REVIEW.md` are historical snapshots.

## Suggested kickoff prompt

Continue OpenPing from `docs/HANDOFF.md`.
First inspect `git status`, `git log origin/main..HEAD`, and the current verification state without discarding any user changes.
Then complete the highest-priority unblocked next step, keep security boundaries intact, verify the full affected flow, and commit each logical change separately.
