# OpenPing — V1 Build Plan & Progress Tracker

This file is the source of truth for the autonomous build loop. Each iteration:
read it, pick the **next unchecked task** (top-to-bottom, respecting phase order),
implement + verify it, commit, then check the box and update **Current status**.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked (see note)

---

## Current status

- **Active phase:** Phase 4 — Notifications & PWA (outbound pipeline DONE; push/PWA next)
- **Last completed:** outbound notification pipeline. 3 parallel agents built outbox,
  channel senders (Resend/Discord/signed-webhook), and channel CRUD; wired event matrix,
  payload builder, dispatcher, and incident→outbox enqueue hooks (incl flapping warning)
  into checks/state + scheduler. 136 tests pass. Verified LIVE: channel test-send executes
  (webhook POST, errors captured), incident open enqueues a 'down' outbox entry.
- **Next up (Phase 4b):** Web Push (VAPID keygen + aes128gcm encryption via Web Crypto,
  subscribe/test/disable/remove + device mgmt), PWA (manifest, icons, service worker w/
  push + offline), magic-link auth (Resend), weekly summary email.
- **Notes:** Web Push must be hand-rolled with Web Crypto (no node web-push lib). Push
  channel kind exists in matrix but is delivered via a separate subscription path, not the
  channel-based dispatcher. Email sender not live-tested (no Resend key locally).

---

## Phase 1 — Foundation

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

## Phase 2 — Monitoring Engine

- [x] Monitor CRUD API + zod schemas (HTTP + heartbeat types)
- [x] HTTP/API check executor (methods, headers, body, auth, timeout, redirects)
- [x] Expected-status + response-time threshold evaluation
- [x] Content/JSON assertions engine
- [x] Heartbeat ingestion endpoint `/hb/:token` (+ duration/exit/message/metrics)
- [x] Schedule engine: always / business-hours / custom weekly, timezone + DST aware
- [x] "Due now?" + "active now?" + next-active/next-check computation
- [x] Warm-up / cold-start handling (warm-up timeout + retry; warming_up display TODO)
- [x] Retry logic (2 attempts, 10s delay) + result classification
- [x] Current-state record updates (consecutive fails/successes, time-in-state)
- [x] Scheduled handler: load due monitors, concurrency-limited checks, lease lock
- [x] Manual test actions (no-history / apply done; send-test notif = Phase 4)
- [~] Schedule preview computation (active hours/mo done; est hosted hours TODO)

## Phase 3 — Incidents & History

- [x] Incident lifecycle: open (1 failed cycle), ongoing, recovery, dedupe
- [x] Flapping detection (is_flapping flag; flapping-warning NOTIFICATION = Phase 4)
- [x] Status intervals (evolving interval rows, split on state/schedule)
- [x] Recent detailed samples (24h rotating; pruned by compaction)
- [x] Hourly summaries (90d), daily (2y), monthly (indefinite)
- [x] Uptime % calculations excluding scheduled-off (metrics module; API in Phase 5)
- [x] MTBF / MTTR / longest / most-recent metrics
- [x] Compaction + retention cleanup (idempotent, runs in scheduler after checks)

## Phase 4 — Notifications & PWA

- [x] Notification outbox (per-channel delivery records, retries, max attempts)
- [x] Resend email channel (sender + HTML/text render; used by dispatcher)
- [ ] Email magic-link auth (hashed single-use token, rate limit, generic response)
- [x] Discord webhook channel (embeds)
- [x] Generic signed webhook channel (HMAC signature, custom headers, test)
- [ ] Web Push: VAPID via Web Crypto, subscribe/test/disable/remove, device mgmt
- [ ] PWA manifest + icons + standalone + theme colors
- [ ] Service worker: push handling, deep links, app-shell cache, offline fallback
- [ ] Android install flow + notification permission guidance + test push
- [x] Notification defaults + per-event channel matrix
- [x] Dispatcher + incident enqueue hooks + channel CRUD/test API (engine glue)
- [ ] Weekly summary email (scheduler-driven, opt-in)

## Phase 5 — Dashboard & Status Page

- [ ] Overview dashboard (counts, channel health, uptime bars, latest latency)
- [ ] Monitor cards (state, time-in-state, last/next check, 24h uptime, actions)
- [ ] Monitor detail (uptime bars 24h/7d/30d/365d, latency chart, metrics, incidents)
- [ ] Incident explorer (filters, search, notes, public update, CSV/JSON export)
- [ ] Maintenance UI (one-time/recurring, global/per-monitor, public msg)
- [ ] Integrations UI (status, test, edit, last success/failure, health)
- [ ] Settings UI (all sections per PRD §16)
- [ ] Status-page customization (name, logo, favicon, accent, theme, footer, groups)
- [ ] Public status page (overall banner, groups, uptime bars, incidents, maint)
- [ ] Public-safety: never leak URLs/creds/headers/bodies/internal errors
- [ ] Mobile navigation polish

## Phase 6 — Hardening & Release

- [ ] Encryption: AES-GCM authenticated, master key secret, per-value nonce, redaction
- [ ] SSRF protection (reject loopback/link-local/metadata/private/creds/redirects)
- [ ] Idempotency (runs, incidents, recovery, rollups, deliveries, heartbeats)
- [ ] Execution lease / overlap protection
- [ ] Accessibility pass
- [ ] Import/export (JSON full backup, CSV incidents/summaries, validate+preview, no secrets)
- [ ] Usage estimates dashboard + diagnostics panel
- [ ] Automated tests (schedule/DST, classification, assertions, SSRF, compaction)
- [ ] Docs: install, upgrade, backup, troubleshooting, custom domain
- [ ] Free-tier budget validation (3 monitors @ 12min)
- [ ] Open-source release prep (LICENSE, CONTRIBUTING, screenshots)

---

## Acceptance criteria (PRD §26) — final gate

Loop stops only when all are satisfied:

- [ ] 1 deployable to a fresh Cloudflare account
- [ ] 2 GitHub OAuth works
- [ ] 3 magic-link login works
- [ ] 4 unauthorized identities rejected
- [ ] 5 first-run setup completes
- [ ] 6 HTTP monitors: methods/headers/body/auth/status/assertions
- [ ] 7 heartbeat monitors work
- [ ] 8 checks run every 12 min
- [ ] 9 timezone schedules survive DST
- [ ] 10 scheduled-off not counted as downtime
- [ ] 11 warm-up doesn't create false incidents
- [ ] 12 failed cycle creates one incident
- [ ] 13 recovery resolves correct incident
- [ ] 14 flapping protection limits spam
- [ ] 15 PWA installs on Android
- [ ] 16 push subs create/test/disable/remove
- [ ] 17 push deep-links into incident
- [ ] 18 Resend sends test/down/recovery/weekly
- [ ] 19 Discord sends test/down/recovery
- [ ] 20 generic signed webhooks work
- [ ] 21 notification failures retry without breaking monitoring
- [ ] 22 dashboard polished desktop + mobile
- [ ] 23 monitor details: bars/charts/incidents/MTBF/MTTR
- [ ] 24 incidents filter/annotate/export
- [ ] 25 maintenance suppresses incidents
- [ ] 26 public status page polished + configurable
- [ ] 27 private details never leak
- [ ] 28 successful checks auto-compacted
- [ ] 29 history doesn't grow indefinitely
- [ ] 30 sensitive config protected
- [ ] 31 usage estimates + diagnostics visible
- [ ] 32 cached PWA identifies stale/offline data
- [ ] 33 install/upgrade/backup/troubleshoot docs complete
- [ ] 34 3 monitors @ default cadence within free-tier budget
