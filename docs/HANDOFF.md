# OpenPing — Session Handoff

Zero-context handoff so any agent can continue without re-asking decided things.
Last updated at the end of the V1 build session.

## Project summary

**OpenPing** is an open-source, self-hosted uptime monitor + public status page
that runs entirely in the user's own Cloudflare account. Signature feature:
**schedule-aware monitoring** — apps are checked/kept-awake only during operating
hours; outside them they show `Scheduled off` and don't count against uptime.

- **Stack:** Cloudflare Worker (Hono router, Zod) + D1 + static React/Vite/Tailwind v4 SPA.
  One Cron Trigger every 12 min (`wrangler.jsonc` → `triggers.crons`). Web Push, GitHub
  OAuth, Resend email, Discord, signed webhooks. Single-administrator (no public signup).
- **Source of truth for scope:** the full PRD (pasted into the first session message) and
  `BUILD_PLAN.md` (phase + §26 acceptance-criteria tracker — all checked).
- **Repo:** local git, default branch `main`. Post-build review passes have
  since landed (see `CODE_REVIEW.md`).
- **Runs at:** `http://localhost:5173` via `npm run dev` (vite + workerd). Not yet deployed
  to a real Cloudflare account.

## State

**V1 implementation COMPLETE**, plus follow-up review passes (see `CODE_REVIEW.md`).
All 6 PRD phases done; 253 unit tests pass; `tsc -b`
and `vite build` clean. The original build session's commits (oldest→newest), all on `main`:

| Phase | Commits |
|---|---|
| 1 Foundation | `2d49a08` scaffold · `6ff8cc9` D1 schema+settings+crypto · `f1a890d` sessions+OAuth · `e523861` setup wizard |
| 2 Monitoring | `ea6f213` zod schemas · `c37d2e2` http executor · `3e0f2f1` CRUD+assertions+schedule · `c3bc0cb` scheduled check cycle |
| 3 Incidents/history | `69580d6` incidents · `d3325a6` intervals · `7c98c63` metrics · `cf9a400` rollups · `1fbbf1f` wire into check cycle |
| 4 Notifications/PWA | `82994b8` channel senders · `3f098c0` outbox pipeline · `2976b45` Web Push+PWA+magic-link |
| 5 Dashboard/status | `be1b0d6` read APIs+overview · `653447d` detail/editor/incidents/settings · `09e097d` public API · `4be3234` public page+maintenance |
| 6 Hardening/release | `76c8001` SSRF validator · `37d079c` weekly · `d5c78cb` SSRF+import/export+weekly · `a062b16` docs · `89ac0e8` encryption+release prep |

**Verified locally** (via dev server + curl, or unit tests): setup wizard, GitHub
OAuth *start* flow, monitor CRUD (auth/CSRF/validation), HTTP checks + assertions
(up/down), heartbeat ingestion, incident open→resolve with intervals/summaries,
notification channel test-send + incident→outbox enqueue, VAPID gen, magic-link
generic response, all dashboard read APIs, public-API redaction (no URL/token leak),
maintenance CRUD, SSRF blocking, JSON export (no secrets), and **encryption-at-rest**
(secret stored as `v1:…` ciphertext, redacted in API, still usable by the checker).

**Implemented but NOT yet validated on a real deploy** (environmental limits of local
workerd+vite — flagged `⊕` in `BUILD_PLAN.md` §26):
- The 12-min **cron cadence** (the vite dev plugin doesn't expose a scheduled trigger).
- **Real-device PWA install** + **Web Push wire encryption** (RFC 8291 aes128gcm is
  hand-rolled and unit-tested for structure only; needs a real browser/push service).
- **Live email/Discord delivery** (no `RESEND_API_KEY` / webhook locally — senders are
  verified to execute and handle errors, not to deliver).
- GitHub OAuth **code exchange** (needs a real GitHub app).

Nothing is half-done or broken. No known failing tests.

## Next steps (ordered)

> Focus for the next agent (if any was given): see top of this file; otherwise start here.

1. **Deploy to a real Cloudflare account and validate the `⊕` items.** Follow
   `docs/INSTALL.md`: `npm run db:create` → paste `database_id` into `wrangler.jsonc`
   → set Worker secrets → `npm run db:migrate` → `npm run deploy` → complete the setup
   wizard. Then confirm: cron fires every 12 min (check `scheduler_runs` / Diagnostics),
   GitHub OAuth round-trips, a real down→recovery sends email/Discord, PWA installs on
   Android and a test push arrives + deep-links. Acceptance = each `⊕` in `BUILD_PLAN.md`
   observed working.
2. **Full accessibility audit.** Baseline only so far (semantic HTML, `focus-visible`
   outlines in `src/client/index.css`, `aria-disabled`). Run axe/Lighthouse over the
   dashboard + public page; fix contrast/labels/keyboard-nav gaps.
3. **Optional polish:** integration tests for the scheduler/dispatcher using
   `@cloudflare/vitest-pool-workers` (currently D1-backed paths are verified via dev-server
   curls, not the workers test pool — see `vitest.config.ts` note); per-channel `events`
   editing UI in Integrations; richer custom-schedule editor; status-page service groups UI.
4. **Consider upgrading wrangler v3 → v4** (a dev warning prints; v3.114 works fine today).

## Conventions & gotchas (hard-won this session)

- **Commit style:** imperative subject; body explains what+why; **every commit ends with**
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` (per global
  CLAUDE.md "commit after every change"). Commit author name/email were set per-commit via
  `git -c user.name=... -c user.email=...` (no repo-level git identity configured).
- **Verify before commit:** `npm run typecheck` (`tsc -b`), `npx vitest run`, `npm run build`
  — all must be green. Then live-smoke via the dev server where it matters.
- **Dev server + local D1:** `npm run dev` serves at `:5173`; local D1 lives in
  `.wrangler/state`. Apply migrations locally with `npm run db:migrate:local`. The vite
  plugin and `wrangler d1 execute --local` share the same local D1 store.
- **Testing auth-protected routes locally without OAuth:** insert a session row whose `id`
  is `sha256(cookieToken)` and set `csrf_secret`; then send `Cookie: op_session=<token>` +
  `x-csrf-token: <csrf_secret>`. Example:
  `ID=$(printf '%s' "$TOKEN" | sha256sum | awk '{print $1}')` → INSERT into `sessions`.
- **`.dev.vars`** (gitignored) holds local secrets: `GITHUB_CLIENT_ID/SECRET`,
  `ADMIN_GITHUB_LOGIN`, `MASTER_KEY` (base64 32 bytes — enables config encryption locally).
  `.dev.vars.example` is the committed template (force-added past the `.dev.vars.*` ignore
  via a `!.dev.vars.example` negation in `.gitignore`).
- **Tailwind v4:** tokens defined in `src/client/index.css` `@theme` (canvas/surface/ink/
  accent + status colors up/down/degraded/scheduled/maint/paused/warming). **Never build
  Tailwind classes by string interpolation** (`text-${x}`) — extraction drops them; use
  explicit class maps. `--radius-card` → `rounded-card`.
- **Worker crypto typing:** `@cloudflare/workers-types` types `crypto.subtle` loosely;
  `generateKey`/`exportKey`/ECDH `deriveBits` need casts (`as CryptoKeyPair`,
  `as JsonWebKey`, `as ArrayBuffer`, and a `Parameters<typeof crypto.subtle.deriveBits>[0]`
  cast for the `{name:"ECDH",public}` algorithm). See `src/worker/notifications/push/webpush.ts`.
- **Hono routing:** `app.route()` merge means a sub-app's `notFound` never fires — the
  top-level catch-all in `src/worker/index.ts` returns JSON 404 for unmatched `/api/*`.
- **Encryption model:** secret config fields (`auth.password`, `auth.token`, heartbeat
  `secret`) are encrypted at rest in `db/monitors` (only when `MASTER_KEY` set, else
  plaintext), decrypted on read for checks, and **redacted to `""` in all API responses**.
  Updates use `mergeSecrets` so a redacted-then-resubmitted config keeps its secret. Don't
  remove the redaction in `routes/monitors.redactMonitor`.
- **Build approach used:** each iteration fanned out parallel subagents over **disjoint
  files** (agents must not touch shared wiring like `routes/api.ts`, `index.ts`, `App.tsx`);
  the main loop integrates + verifies serially. Keep that split if continuing.

## File map (what matters)

- `BUILD_PLAN.md` — phase tracker + §26 acceptance criteria (all checked; `⊕` = deploy-validate).
- `wrangler.jsonc` — Worker config: D1 binding `DB`, cron `*/12 * * * *`, SPA assets. Put real `database_id` here.
- `src/worker/index.ts` — Worker entry: Hono app, route mounts, `scheduled()` handler, SPA fallback.
- `src/worker/scheduler.ts` — the 12-min cycle: lease → maintenance/schedule eval → concurrent checks → missed heartbeats → outbox dispatch → compaction → weekly summary → expired-session/auth-token GC + `scheduler_runs` prune.
- `src/worker/routes/*` — API: `api.ts` (mounts), `auth`/`api-auth`/`magic` (auth), `monitors`, `channels`, `push`, `incidents`, `maintenance`, `overview`, `diagnostics`, `settings`, `data` (import/export), `public` (unauthenticated, redacted), `setup`, `heartbeats`.
- `src/worker/checks/*` — `http.ts` (executor + SSRF guard), `assertions.ts`, `runner.ts` (warm-up/retry/classify), `state.ts` (current state + incident/interval/rollup/notify hooks).
- `src/worker/db/*` — `monitors`, `incidents`, `intervals`, `channels`, `push`, `outbox`, `maintenance`, `settings`, `setup`.
- `src/worker/history/*` — `rollups.ts` (compaction), `metrics.ts` (uptime/MTBF/MTTR).
- `src/worker/notifications/*` — `dispatcher.ts`, `enqueue.ts`, `payload.ts`, `channels/{resend,discord,webhook}.ts`, `push/{webpush,vapid}.ts`, `weekly.ts`.
- `src/worker/lib/*` — `crypto.ts`, `secret-config.ts`, `ssrf.ts`, `sessions.ts`, `admin.ts`, `ids.ts`, `lease.ts`, `schedule.ts` (timezone/DST).
- `src/client/*` — `App.tsx` (routes), `components/AppLayout.tsx` (shell+nav), `components/ui/*` (primitives), `lib/{api,useFetch,bootstrap,format,types}.ts`, `pages/*` (Dashboard, Monitors, MonitorDetail, MonitorEditor, Incidents, Integrations, Settings, Maintenance, StatusPageSettings, PublicStatus, Setup, Login).
- `migrations/0001_init.sql` — full v1 D1 schema (16 tables).
- `migrations/0002_review_fixes.sql` — security-review additions: `monitor_state.last_beat_at` + unique partial index `idx_incidents_one_open`.
- `docs/*` — INSTALL, UPGRADE, BACKUP, TROUBLESHOOTING, CUSTOM_DOMAIN, FREE_TIER (+ this HANDOFF).
