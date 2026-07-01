# OpenPing - Session Handoff

Zero-context handoff so any agent can continue without re-asking decided things.
Last updated at the end of the session that added monitor categories, multiple per-category status pages, three new monitor types, a public `/tools` suite, an embeddable widget/badge, and a marketing landing page - all on top of the already-shipped, deployed V1.

## Project summary

**OpenPing** is an open-source, self-hosted uptime monitor + public status page
that runs entirely in the user's own Cloudflare account. Signature feature:
**schedule-aware monitoring** - apps are checked/kept-awake only during operating
hours; outside them they show `Scheduled off` and don't count against uptime.

- **Stack:** Cloudflare Worker (Hono router, Zod) + D1 + static React/Vite/Tailwind v4 SPA.
  One Cron Trigger every 12 min (`wrangler.jsonc` → `triggers.crons`). Web Push, GitHub
  OAuth, Resend email, Discord, signed webhooks. Single-administrator (no public signup).
- **Source of truth for scope:** the full PRD (pasted into the first session message) and
  `BUILD_PLAN.md` (phase + §26 acceptance-criteria tracker - all checked).
- **Repo:** git, default branch `main`, pushed to `origin` (GitHub). Multiple post-build
  review passes **plus a live-deploy verification round** have landed (see `CODE_REVIEW.md`).
- **Runs at:** **DEPLOYED LIVE** to Cloudflare on a custom domain -
  `https://openping.n8builds.dev` (single-admin, GitHub-OAuth + email magic-link
  login, cron every 12 min, remote D1 migrated 0001→0007).
  Local dev still: `npm run dev` → `http://localhost:5173`.

## Latest session (categories, status pages, new monitor types, tools, widget, landing)

V1 had already shipped and deployed before this session; everything below builds on top of it.
It is all on `main`, pushed.
`tsc -b` + `vite build` clean, **397 tests pass** (32 test files).

1. **Monitor categories + multiple per-category public status pages** (see `docs/STATUS_PAGES.md`).
A monitor can be assigned a **category** and toggled onto public pages ("Show on public status pages") in the monitor editor (`client/pages/MonitorEditor.tsx`).
Categories and pages are managed at `/status-page` (list + an inline categories manager), `/status-page/new`, and `/status-page/:id` (`client/pages/StatusPageSettings.tsx`, `StatusPageEditor.tsx`).
Each page has its own slug, branding, kill switch, sort order, and monitor selection with three include modes: all visible / by category / specific monitors (`db/status-pages.ts` `selectPageMonitors`).
The single default page is served at `/status`; every other page at `/status/:slug`.
The public API (`routes/public.ts`) resolves the page by `?slug=` (a bad slug is a hard 404) and returns the same redacted shape as before.
Migration `0006_categories_status_pages.sql` adds the `categories` and `status_pages` tables.

2. **Three new monitor types** (see `docs/MONITOR_TYPES.md`): DNS record (A/AAAA/CNAME/MX/TXT over DoH, optional value assertion; `checks/dns.ts`), TCP port (connection-accepted; `checks/tcp.ts`), and domain-expiry (RDAP via `rdap.org`, early-warning `warnDays`; `checks/domain.ts`).
These join HTTP/API and heartbeat for **five** types total.

3. **A public, no-auth `/tools` suite** (see `docs/TOOLS.md`): uptime calculator, subnet calculator, cron tester, DNS lookup, MX lookup, and an **"Is it down?"** checker (`client/pages/tools/*`).
"Is it down?" is backed by `POST /api/tools/is-it-down` (`routes/is-it-down.ts`), which returns only reachability (`{up,status,durationMs,error?}` - never body/headers), is SSRF-guarded via `lib/ssrf.ts`, and is rate-limited (15/IP/min + 300 global/min) using `db/rate-limit.ts` backed by migration `0007_rate_limits.sql`.

4. **An embeddable status widget + SVG badge** (see `docs/WIDGET.md`): `/embed` (`client/pages/Embed.tsx`, iframed cross-origin) and `/api/public/badge.svg` (`routes/public.ts`), both scoped to a page with `?slug=`.
Framing is relaxed for `/embed` only via an allow-list in `index.ts` (`ALLOWED_FRAME_ANCESTORS`); every other route stays `frame-ancestors 'none'`.

5. **A marketing landing page at `/`** for signed-out visitors (`client/pages/Landing.tsx` + `client/components/landing/*`); authenticated admins still get the Dashboard at `/` (gated by `RootIndex` in `App.tsx`).

6. **Polish shipped this session:** branded transactional emails (`notifications/email-layout.ts`), an app-wide mobile pass, an upgrade to **wrangler v4** (`^4.106.0`, retiring the old v3 dev warning), and a new **`ADMIN_EMAIL`** secret that enables email magic-link admin sign-in alongside GitHub OAuth.
Also from the earlier deploy round (still relevant): an admin **CLI** (`scripts/op.mjs`, Bearer `API_TOKEN` auth, `docs/CLI.md`) and a distinct **Suspended** monitor status (Render free-tier: 503 + `x-render-routing: suspend`).

> ⚠️ `wrangler.jsonc` holds the placeholder `database_id` in the repo; the live install's real id is set in the deployer's **local** working copy only (never committed - keeps the public template clean).
> The `API_TOKEN` value lives in a gitignored `.op-token`.

## State

**V1 is complete and deployed** to the custom domain `https://openping.n8builds.dev`, and this session's features (categories, multiple per-category status pages, DNS/TCP/domain-expiry monitors, the `/tools` suite, the widget/badge, and the landing page) are all merged on `main`.
All 6 original PRD phases are done, plus the post-V1 work above; **397 unit tests pass** (32 files); `tsc -b` and `vite build` are clean.
The original V1 build commits (oldest→newest), all on `main`:

| Phase | Commits |
|---|---|
| 1 Foundation | `2d49a08` scaffold · `6ff8cc9` D1 schema+settings+crypto · `f1a890d` sessions+OAuth · `e523861` setup wizard |
| 2 Monitoring | `ea6f213` zod schemas · `c37d2e2` http executor · `3e0f2f1` CRUD+assertions+schedule · `c3bc0cb` scheduled check cycle |
| 3 Incidents/history | `69580d6` incidents · `d3325a6` intervals · `7c98c63` metrics · `cf9a400` rollups · `1fbbf1f` wire into check cycle |
| 4 Notifications/PWA | `82994b8` channel senders · `3f098c0` outbox pipeline · `2976b45` Web Push+PWA+magic-link |
| 5 Dashboard/status | `be1b0d6` read APIs+overview · `653447d` detail/editor/incidents/settings · `09e097d` public API · `4be3234` public page+maintenance |
| 6 Hardening/release | `76c8001` SSRF validator · `37d079c` weekly · `d5c78cb` SSRF+import/export+weekly · `a062b16` docs · `89ac0e8` encryption+release prep |

**Unit-tested modules** (`npx vitest run`, no live D1 needed): schedule/DST, check classification, HTTP assertions, SSRF, outbox, metrics, crypto, heartbeat ingestion, and the weekly summary - plus the new-this-session `db/categories`, `db/status-pages` (including the pure `selectPageMonitors` selector), `db/rate-limit`, and the `checks/dns` / `checks/tcp` / `checks/domain` executors, as well as `routes/public` redaction and page resolution.

**Validated on the live deploy:** the 12-min **cron cadence**, **GitHub OAuth** full round-trip, the public status page (default at `/status` and per-slug at `/status/:slug`), the **Suspended** detector, and the admin **CLI** over the Bearer API.

**Still NOT exercised end-to-end:**
- **Real-device PWA install** + **Web Push wire encryption** (RFC 8291 aes128gcm is hand-rolled and unit-tested for structure only; needs a real browser/push service).
- **Live email (Resend) / Discord delivery** of a real down→recovery alert: `RESEND_API_KEY` is set and emails are branded, but **no Discord webhook is configured** yet.
- **Real production monitors:** the live install is still validated with test/sample monitors, not a full production set (see Next steps).

Nothing is half-done or broken. No known failing tests.

## Next steps (ordered)

> Focus for the next agent (if any was given): see top of this file; otherwise start here.
> The big V1-era items - the custom domain, the accessibility pass, wrangler v4, and status-page grouping - are all shipped; what remains is below.

1. **Wire up the real production monitors.**
The live install is still running with test/sample monitors.
Add the actual services (with schedules, categories, and public-page assignments), then confirm a real down→recovery cycle behaves as expected.

2. **Configure a Discord channel.**
The Discord webhook sender is built and wired into the dispatcher (`notifications/channels/discord.ts`), but **no webhook is configured** on the live install.
Add one under Integrations and send a test to close the loop on live Discord delivery.

3. **Optional: integration tests via `@cloudflare/vitest-pool-workers`.**
D1-backed paths (scheduler/dispatcher, route handlers) are currently covered by pure/unit tests, not the workers test pool - see the note in `vitest.config.ts`.

4. **Finish the remaining live-delivery checks:** a real-device **PWA install + Web Push** arriving and deep-linking, and observing a live **email (Resend)** down→recovery alert.

> **Known limitation - domain-expiry on `.dev`/`.app`.**
> Google's registry rejects automated RDAP requests from Cloudflare's network with an HTTP 403 (`rdap_error`), so domain-expiry monitoring isn't available for those TLDs.
> DNS and TCP monitors still work for `.dev`/`.app` hosts. See `docs/MONITOR_TYPES.md`.

## Conventions & gotchas (hard-won this session)

- **Commit style:** imperative subject; body explains what+why; **every commit ends with**
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` (per global
  CLAUDE.md "commit after every change"). Commit author name/email were set per-commit via
  `git -c user.name=... -c user.email=...` (no repo-level git identity configured).
- **Verify before commit:** `npm run typecheck` (`tsc -b`), `npx vitest run`, `npm run build`
  - all must be green. Then live-smoke via the dev server where it matters.
- **Dev server + local D1:** `npm run dev` serves at `:5173`; local D1 lives in
  `.wrangler/state`. Apply migrations locally with `npm run db:migrate:local`. The vite
  plugin and `wrangler d1 execute --local` share the same local D1 store.
- **Hitting auth-protected routes without a browser session:** set the `API_TOKEN` Worker
  secret and send `Authorization: Bearer <API_TOKEN>` - `requireAuth` treats it as admin
  (no CSRF, since Bearer isn't ambient). The `scripts/op.mjs` CLI uses exactly this (see
  `docs/CLI.md`). (The old trick - inserting a `sessions` row with `id = sha256(token)` and
  sending the cookie + `x-csrf-token` - still works but is rarely needed now.)
- **`.dev.vars`** (gitignored) holds local secrets: `GITHUB_CLIENT_ID/SECRET`,
  `ADMIN_GITHUB_LOGIN`, `MASTER_KEY` (base64 32 bytes - enables config encryption locally).
  `.dev.vars.example` is the committed template (force-added past the `.dev.vars.*` ignore
  via a `!.dev.vars.example` negation in `.gitignore`).
- **Tailwind v4:** tokens defined in `src/client/index.css` `@theme` (canvas/surface/ink/
  accent + status colors up/down/degraded/scheduled/maint/paused/warming). **Never build
  Tailwind classes by string interpolation** (`text-${x}`) - extraction drops them; use
  explicit class maps. `--radius-card` → `rounded-card`.
- **Worker crypto typing:** `@cloudflare/workers-types` types `crypto.subtle` loosely;
  `generateKey`/`exportKey`/ECDH `deriveBits` need casts (`as CryptoKeyPair`,
  `as JsonWebKey`, `as ArrayBuffer`, and a `Parameters<typeof crypto.subtle.deriveBits>[0]`
  cast for the `{name:"ECDH",public}` algorithm). See `src/worker/notifications/push/webpush.ts`.
- **Hono routing:** `app.route()` merge means a sub-app's `notFound` never fires - the
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

- `BUILD_PLAN.md` - V1 phase tracker + §26 acceptance criteria (historical record; it now points here for the current state).
- `wrangler.jsonc` - Worker config: D1 binding `DB`, cron `*/12 * * * *`, SPA assets (wrangler v4). Put the real `database_id` here.
- `src/worker/index.ts` - Worker entry: Hono app, route mounts, `scheduled()` handler, SPA fallback, and the `/embed` frame-ancestors allow-list (`ALLOWED_FRAME_ANCESTORS`).
- `src/worker/scheduler.ts` - the 12-min cycle: lease -> maintenance/schedule eval -> concurrent checks -> missed heartbeats -> outbox dispatch -> compaction -> weekly summary -> expired-session/auth-token GC + `scheduler_runs` prune.
- `src/worker/routes/*` - API: `api.ts` (mounts), `auth`/`api-auth`/`magic` (auth), `monitors`, `categories` (NEW), `status-pages` (NEW), `channels`, `push`, `incidents`, `maintenance`, `overview`, `diagnostics`, `settings`, `data` (import/export), `public` (unauthenticated, redacted; status payload + `badge.svg`, both `?slug=`-aware), `is-it-down` (NEW; public SSRF-guarded + rate-limited checker), `setup`, `heartbeats`.
- `src/worker/checks/*` - `http.ts` (executor + SSRF guard), `dns.ts` / `tcp.ts` / `domain.ts` (NEW check executors), `assertions.ts`, `runner.ts` (warm-up/retry/classify), `state.ts` (current state + incident/interval/rollup/notify hooks).
- `src/worker/db/*` - `monitors`, `categories` (NEW), `status-pages` (NEW; includes the pure `selectPageMonitors`), `rate-limit` (NEW), `incidents`, `intervals`, `channels`, `push`, `outbox`, `maintenance`, `settings`, `setup`.
- `src/worker/history/*` - `rollups.ts` (compaction), `metrics.ts` (uptime/MTBF/MTTR).
- `src/worker/notifications/*` - `dispatcher.ts`, `enqueue.ts`, `payload.ts`, `email-layout.ts` (branded HTML shell), `channels/{resend,discord,webhook}.ts`, `push/{webpush,vapid}.ts`, `weekly.ts`.
- `src/worker/lib/*` - `crypto.ts`, `secret-config.ts`, `ssrf.ts`, `sessions.ts`, `admin.ts`, `ids.ts`, `lease.ts`, `schedule.ts` (timezone/DST).
- `src/client/*` - `App.tsx` (routes, incl. `/status/:slug`, `/embed`, `/tools/*`, and `RootIndex` gating `/`), `components/AppLayout.tsx` (shell+nav), `components/landing/*` (NEW landing sections), `components/ui/*` (primitives), `lib/{api,useFetch,bootstrap,format,types}.ts`.
- `src/client/pages/*` - Dashboard, Monitors, MonitorDetail, MonitorEditor (adds the category picker + "Show on public status pages" toggle), Incidents, Integrations, Settings, Maintenance, StatusPageSettings (page list + inline categories manager), StatusPageEditor (NEW), PublicStatus, Landing (NEW), Embed (NEW widget), Setup, Login, and `pages/tools/*` (NEW: ToolsIndex, IsItDown, UptimeCalculator, SubnetCalculator, CronTester, DnsLookup, MxLookup, shared ToolLayout).
- `migrations/0001_init.sql` - full v1 D1 schema (16 tables).
- `migrations/0002_review_fixes.sql` - `monitor_state.last_beat_at` + unique partial index `idx_incidents_one_open`.
- `migrations/0003_heartbeat_backfill.sql` - backfills `last_beat_at` (avoids false-DOWN on upgrade).
- `migrations/0004_outbox_monitor_id.sql` - `notification_outbox.monitor_id` (+ index) so deletes purge queued alerts.
- `migrations/0005_incident_status_check.sql` - triggers enforcing `incidents.status ∈ {open,resolved}`.
- `migrations/0006_categories_status_pages.sql` - NEW: `categories` + `status_pages` tables and `monitors.category_id` (FK, ON DELETE SET NULL).
- `migrations/0007_rate_limits.sql` - NEW: `rate_limits` table backing the `is-it-down` fixed-window limiter.
- `scripts/op.mjs` - admin CLI (Bearer API-token auth); see `docs/CLI.md`.
- `docs/*` - INSTALL, MONITOR_TYPES, STATUS_PAGES (NEW), TOOLS (NEW), WIDGET, CLI, UPGRADE, BACKUP, TROUBLESHOOTING, CUSTOM_DOMAIN, FREE_TIER (+ this HANDOFF).
