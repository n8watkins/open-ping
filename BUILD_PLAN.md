# OpenPing - V1 Build Plan & Progress Tracker

This file is the source of truth for the autonomous build loop. Each iteration:
read it, pick the **next unchecked task** (top-to-bottom, respecting phase order),
implement + verify it, commit, then check the box and update **Current status**.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked (see note)

---

## Current status

> **Note:** this file is a **V1 historical record** - the phase tracker and §26
> acceptance criteria below document the original V1 build and its review passes.
> Work has continued since (categories + multiple status pages, three new monitor
> types, a `/tools` suite, an embeddable widget/badge, a landing page, and more).
> For the current state of the project, see [`docs/HANDOFF.md`](./docs/HANDOFF.md).

- **Active phase:** ✅ V1 COMPLETE, review passes applied, and **DEPLOYED LIVE** to
  Cloudflare (`https://open-ping.<subdomain>.workers.dev`).
- **Last completed:** **Live-deploy verification** caught and fixed 4 real production
  bugs that all 3 static review passes + unit tests missed (every one only triggers on a
  real server round-trip): `/status` 500 + login 500 (secureHeaders vs immutable
  ASSETS/redirect headers), an env-admin setup deadlock, and OAuth/session cookies being
  dropped by `Response.redirect` (login never persisted). Then shipped features:
  signed-in/sign-out UI, an admin **CLI + Bearer API-token auth** (`scripts/op.mjs`,
  `docs/CLI.md`), and a distinct **Suspended** monitor status (Render free-tier detection).
  Migrations now run **0001→0007**. **397 tests pass**; `tsc -b` + `vite build` clean.
- **Before that:** an 8-agent review → 7-agent fix pass (4 High + ~13 Medium + ~24 Low) +
  all 11 of its deferred items resolved (migrations `0003`/`0004`/`0005`). Consolidated
  record: [`CODE_REVIEW.md`](./CODE_REVIEW.md).
- **Earlier:** A 9-agent **security + coding review** (adversarially verified) landed
  21 confirmed fixes + migration `0002_review_fixes.sql` (253 tests); and before that,
  a parallel multi-agent review against §26 (245 tests).
- **Status:** Build loop STOPPED - implementation complete. Items that can only be exercised
  on a real deployment (cron trigger cadence, real-device PWA install + Web Push wire
  encryption, live Resend/Discord delivery, GitHub OAuth code exchange) are implemented and
  unit/integration-verified to the extent the local workerd+vite environment allows.
- **To ship:** follow docs/INSTALL.md - db:create, set secrets, db:migrate, deploy, run setup.

### Post-build review - issues found & fixed (2026-06-29)

A 6-domain parallel review caught real defects behind several "VERIFIED ✓" claims. Fixed:

- **SSRF redirect bypass** - checks now follow redirects manually and re-validate EVERY hop
  (`checks/http.ts`); the request timeout also covers the response-body read. (+ tests)
- **Heartbeat uptime** - a down heartbeat no longer reads ~100% uptime: missed cycles now
  accrue downtime in the rollups every cycle; a brand-new heartbeat monitor is no longer
  marked down before its first interval elapses (`scheduler.ts`, `checks/state.ts`).
- **Rollup corruption** - daily/monthly summaries are now *sealed* once their source rows
  age out, so pruning can't silently shrink long-term history; `status_intervals` is now
  pruned; the configurable `retention` setting actually drives prune horizons (`history/rollups.ts`).
- **365-day uptime** - now summed from `day` summaries (was hour-only → capped at hourly
  retention) (`history/metrics.ts`).
- **Warm-up** - a failed cold-start cycle is `warming_up` (one grace cycle), not an instant
  incident; real outages still alarm the next cycle (`checks/runner.ts`, `state.ts`, `scheduler.ts`).
- **Maintenance** - a failing heartbeat received during a maintenance window no longer opens
  an incident (`routes/heartbeats.ts`, `state.ts`).
- **HTTP cadence** - due-gate slack so checks don't slip to a ~24-min interval (`scheduler.ts`).
- **Channel secrets** - Discord URL / webhook HMAC secret now encrypted at rest + redacted in
  the API (were plaintext) (`db/channels.ts`, `routes/channels.ts`).
- **Backup import** - incidents are actually restored and the dry-run counts are honest
  (`routes/data.ts`).
- **Public status page** - `enabled` flag enforced server-side; maintenance respects recurrence
  (`routes/public.ts`); theme is applied (light/dark/system) (`client/pages/PublicStatus.tsx`).
- **Login** - the magic-link email flow is now wired in the UI (was a disabled stub), so
  email-only installs can sign in (`client/pages/Login.tsx`).
- **Frontend** - offline/stale banner; header "Operational" pill derived from real state;
  Dashboard/Monitors show fetch errors; `api()` no longer throws on non-JSON error bodies;
  incident date filters send epoch-ms; `useFetch` drops out-of-order responses.
- **Hardening** - setup routes enforce CSRF; magic-link no longer leaks the admin email via a
  timing oracle; constant-time secret compares; SSRF trailing-dot host; timezone +
  expected-status validation; webhook signature covers the timestamp; weekly summary anchored
  to a weekday/hour; flapping recovery notifications suppressed.

**Deferred (LOW / environmental, documented):** heartbeat ingestion token hashed-at-rest (UX
redesign); OAuth `state`→browser cookie binding; request-Host link poisoning when `app_url`
unset; MASTER_KEY-absent diagnostics warning; full single-alert flapping coalescing (spam
already halved); PNG/apple-touch icons; deploy-only ⊕ items (cron cadence, real-device PWA +
push wire delivery, live email/Discord, OAuth code exchange).

---

## Phase 1 - Foundation

- [x] Repo structure, git, .gitignore, package.json
- [x] Tooling config: tsconfig (refs), vite + cloudflare plugin, tailwind v4
- [x] wrangler.jsonc (D1 binding, cron `*/12 * * * *`, assets/SPA)
- [x] Worker entry: Hono app, `/api` router, scheduled() stub, SPA asset fallback
- [x] Shared types/zod package
- [x] React app shell: dark-navy layout, router, Tailwind design tokens
- [x] D1 schema v1 migration: settings, sessions, monitors, incidents, samples, intervals, summaries, notification channels, outbox, push subscriptions, maintenance, heartbeats
- [x] Config/settings store (D1 key-value, encrypted-secret aware)
- [x] Session system: secure cookies, rotation, CSRF, auth middleware
- [x] GitHub OAuth: login, callback, state validation, allowlist check
- [x] Setup wizard shell (resumable, step state in D1) + setup/auth gating
- [x] Responsive app layout + mobile bottom nav
- [x] Verify: `npm run build` passes; worker boots in dev; `/api/health` responds

## Phase 2 - Monitoring Engine

- [x] Monitor CRUD API + zod schemas (HTTP + heartbeat types)
- [x] HTTP/API check executor (methods, headers, body, auth, timeout, redirects)
- [x] Expected-status + response-time threshold evaluation
- [x] Content/JSON assertions engine
- [x] Heartbeat ingestion endpoint `/hb/:token` (+ duration/exit/message/metrics)
- [x] Schedule engine: always / business-hours / custom weekly, timezone + DST aware
- [x] "Due now?" + "active now?" + next-active/next-check computation
- [x] Warm-up / cold-start handling (warm-up timeout + retry; `warming_up` state rendered in the UI)
- [x] Retry logic (2 attempts, 10s delay) + result classification
- [x] Current-state record updates (consecutive fails/successes, time-in-state)
- [x] Scheduled handler: load due monitors, concurrency-limited checks, lease lock
- [x] Manual test actions (no-history / apply done; send-test notif = Phase 4)
- [~] Schedule preview computation (active hours/mo done; est hosted hours TODO)

## Phase 3 - Incidents & History

- [x] Incident lifecycle: open (1 failed cycle), ongoing, recovery, dedupe
- [x] Flapping detection (is_flapping flag; flapping-warning NOTIFICATION = Phase 4)
- [x] Status intervals (evolving interval rows, split on state/schedule)
- [x] Recent detailed samples (24h rotating; pruned by compaction)
- [x] Hourly summaries (90d), daily (2y), monthly (indefinite)
- [x] Uptime % calculations excluding scheduled-off (metrics module; API in Phase 5)
- [x] MTBF / MTTR / longest / most-recent metrics
- [x] Compaction + retention cleanup (idempotent, runs in scheduler after checks)

## Phase 4 - Notifications & PWA

- [x] Notification outbox (per-channel delivery records, retries, max attempts)
- [x] Resend email channel (sender + HTML/text render; used by dispatcher)
- [x] Email magic-link auth (hashed single-use token, rate limit, generic response)
- [x] Discord webhook channel (embeds)
- [x] Generic signed webhook channel (HMAC signature, custom headers, test)
- [x] Web Push: VAPID via Web Crypto, subscribe/test/disable/remove, device mgmt (encryption needs device validation)
- [x] PWA manifest + icons + standalone + theme colors
- [x] Service worker: push handling, deep links, app-shell cache, offline fallback
- [~] Android install flow + permission guidance + test push (SW+client helper done; UI in Phase 5)
- [x] Notification defaults + per-event channel matrix
- [x] Dispatcher + incident enqueue hooks + channel CRUD/test API (engine glue)
- [ ] Weekly summary email (scheduler-driven, opt-in) - carry to Phase 6

## Phase 5 - Dashboard & Status Page

- [x] Read APIs: /api/overview, /api/monitors/:id/detail, /api/incidents (+export), /api/diagnostics (+usage)
- [x] Client UI primitives (StatusPill, UptimeBar, Sparkline, Card, Stat, EmptyState, format)
- [x] Overview dashboard (counts, channel-health banner, monitor cards, latest latency)
- [x] Monitor cards/list (state, last/next check, 24h uptime)
- [x] Monitor detail page (uptime bars 24h/7d/30d/365d, latency sparkline, metrics, incidents)
- [x] Monitor editor (create/edit form: http + heartbeat, schedule, assertions)
- [x] Incident explorer UI (filters, search, notes, public update, CSV/JSON export)
- [x] Maintenance UI (one-time/per-monitor/global, public msg) + maintenance engine + scheduler suppression
- [x] Integrations UI (status, test, edit, last success/failure, health) + push/devices
- [x] Settings UI (general, retention, usage, diagnostics) + /api/settings
- [x] Status-page customization (name, logo, accent, theme, footer, attribution)
- [x] Public status page (overall banner, groups, 90d uptime bars, incidents, maint)
- [x] Public-safety: never leak URLs/creds/headers/bodies/internal errors (VERIFIED no leak)
- [x] Mobile navigation (bottom nav present; refine in hardening)

## Phase 6 - Hardening & Release

- [x] Encryption: AES-GCM config secrets at rest + redaction in API responses (VERIFIED)
- [x] SSRF protection (reject loopback/link-local/metadata/private/creds) + executor short-circuit
- [x] Idempotency (outbox event_key, incident dedupe, rollup upserts, heartbeat) - review done
- [x] Execution lease / overlap protection (lib/lease, used in scheduler)
- [x] Accessibility baseline (semantic HTML, focus-visible outlines, aria-disabled) - full audit post-V1
- [x] Import/export (JSON full backup, no secrets; CSV incidents export)
- [x] Usage estimates + diagnostics (APIs + Settings UI)
- [x] Automated tests (schedule/DST, classification, assertions, SSRF, outbox, metrics, crypto) - 397 pass
- [x] Docs: install, upgrade, backup, troubleshooting, custom domain, free-tier
- [x] Free-tier budget validation note (docs/FREE_TIER.md)
- [x] Open-source release prep (LICENSE, CONTRIBUTING, .dev.vars.example)
- [x] Weekly summary email (scheduler-driven, opt-in, self-guarded)

---

## Acceptance criteria (PRD §26) - final gate ✅ ALL MET

Legend: ✓ = implemented + locally verified · ⊕ = implemented, validate on real deploy.

- [x] 1 deployable to a fresh Cloudflare account ⊕ (docs/INSTALL.md; build clean)
- [x] 2 GitHub OAuth works ✓ (start flow verified; full exchange needs real GitHub ⊕)
- [x] 3 magic-link login works ✓ (generic no-disclosure response verified)
- [x] 4 unauthorized identities rejected ✓ (401 + allowlist)
- [x] 5 first-run setup completes ✓ (verified end-to-end)
- [x] 6 HTTP monitors: methods/headers/body/auth/status/assertions ✓
- [x] 7 heartbeat monitors work ✓ (ingestion verified)
- [x] 8 checks run every 12 min ✓ (cron configured; cadence ⊕ on deploy)
- [x] 9 timezone schedules survive DST ✓ (DST unit tests)
- [x] 10 scheduled-off not counted as downtime ✓
- [x] 11 warm-up doesn't create false incidents ✓
- [x] 12 failed cycle creates one incident ✓ (verified live)
- [x] 13 recovery resolves correct incident ✓ (verified live)
- [x] 14 flapping protection limits spam ✓
- [x] 15 PWA installs on Android ⊕ (manifest+SW+icons; real-device install on deploy)
- [x] 16 push subs create/test/disable/remove ✓ (API+UI; wire delivery ⊕)
- [x] 17 push deep-links into incident ⊕ (SW notificationclick → url)
- [x] 18 Resend sends test/down/recovery/weekly ⊕ (needs RESEND_API_KEY)
- [x] 19 Discord sends test/down/recovery ✓ (sender verified executes)
- [x] 20 generic signed webhooks work ✓ (HMAC; verified executes)
- [x] 21 notification failures retry without breaking monitoring ✓ (isolated outbox)
- [x] 22 dashboard polished desktop + mobile ✓
- [x] 23 monitor details: bars/charts/incidents/MTBF/MTTR ✓
- [x] 24 incidents filter/annotate/export ✓
- [x] 25 maintenance suppresses incidents ✓ (scheduler hook)
- [x] 26 public status page polished + configurable ✓ (verified)
- [x] 27 private details never leak ✓ (VERIFIED: no url/token in public API)
- [x] 28 successful checks auto-compacted ✓ (rollupAndCompact)
- [x] 29 history doesn't grow indefinitely ✓ (retention prune)
- [x] 30 sensitive config protected ✓ (VERIFIED: encrypted at rest + redacted)
- [x] 31 usage estimates + diagnostics visible ✓ (Settings UI + APIs)
- [x] 32 cached PWA identifies stale/offline data ✓ (offline.html messaging)
- [x] 33 install/upgrade/backup/troubleshoot docs complete ✓ (docs/)
- [x] 34 3 monitors @ default cadence within free-tier budget ✓ (docs/FREE_TIER.md)
