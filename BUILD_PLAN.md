# OpenPing — V1 Build Plan & Progress Tracker

This file is the source of truth for the autonomous build loop. Each iteration:
read it, pick the **next unchecked task** (top-to-bottom, respecting phase order),
implement + verify it, commit, then check the box and update **Current status**.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked (see note)

---

## Current status

- **Active phase:** Phase 6 — Hardening & Release (6a done)
- **Last completed:** Phase 6a. 3 parallel agents built the SSRF guard (lib/ssrf), import/
  export (routes/data, secrets stripped), and weekly summary (notifications/weekly); I wired
  SSRF into runHttpCheck (+ no-retry on blocked_url), mounted /api/data, and hooked the
  self-guarding weekly summary into the scheduler. 228 tests pass. Verified LIVE: SSRF blocks
  metadata host (169.254.169.254) + localhost (blocked_url), export backup has no secrets.
- **Next up (Phase 6b — final):** encryption-at-rest for monitor secret config + API
  redaction (acceptance #30), docs (install/upgrade/backup/troubleshoot/custom-domain),
  LICENSE + CONTRIBUTING + .dev.vars.example, free-tier budget note, accessibility sweep,
  then the FINAL §26 acceptance-criteria review → if all met, STOP the loop.
- **Notes:** encryption — encrypt config.auth password/token, body, header values, heartbeat
  secret on write in db/monitors (only if MASTER_KEY set, else plaintext + warn); decrypt in
  getMonitor for checks; redact those fields in routes/monitors GET responses.

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
- [x] Email magic-link auth (hashed single-use token, rate limit, generic response)
- [x] Discord webhook channel (embeds)
- [x] Generic signed webhook channel (HMAC signature, custom headers, test)
- [x] Web Push: VAPID via Web Crypto, subscribe/test/disable/remove, device mgmt (encryption needs device validation)
- [x] PWA manifest + icons + standalone + theme colors
- [x] Service worker: push handling, deep links, app-shell cache, offline fallback
- [~] Android install flow + permission guidance + test push (SW+client helper done; UI in Phase 5)
- [x] Notification defaults + per-event channel matrix
- [x] Dispatcher + incident enqueue hooks + channel CRUD/test API (engine glue)
- [ ] Weekly summary email (scheduler-driven, opt-in) — carry to Phase 6

## Phase 5 — Dashboard & Status Page

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

## Phase 6 — Hardening & Release

- [ ] Encryption: AES-GCM authenticated config secrets at rest + redaction in API responses
- [x] SSRF protection (reject loopback/link-local/metadata/private/creds) + executor short-circuit
- [x] Idempotency (outbox event_key, incident dedupe, rollup upserts, heartbeat) — review done
- [x] Execution lease / overlap protection (lib/lease, used in scheduler)
- [ ] Accessibility pass
- [x] Import/export (JSON full backup, no secrets; CSV incidents export)
- [x] Usage estimates + diagnostics (APIs + Settings UI)
- [x] Automated tests (schedule/DST, classification, assertions, SSRF, outbox, metrics) — 228 pass
- [ ] Docs: install, upgrade, backup, troubleshooting, custom domain
- [ ] Free-tier budget validation note (3 monitors @ 12min)
- [ ] Open-source release prep (LICENSE, CONTRIBUTING, .dev.vars.example)
- [x] Weekly summary email (scheduler-driven, opt-in, self-guarded)

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
