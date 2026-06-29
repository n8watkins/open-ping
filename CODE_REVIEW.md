# OpenPing — Code Review

Consolidated review record for OpenPing (Cloudflare Worker + D1 + React status-page
app). This is the single source of truth for review findings; it supersedes the
earlier `SECURITY_REVIEW.md` (Pass 1, folded into the appendix below).

| Pass | Date | Method | Findings | Status |
|------|------|--------|----------|--------|
| 1 | 2026-06-29 | 9 reviewer agents + adversarial verifier | 21 confirmed | ✅ all fixed |
| 2 | 2026-06-29 | 8 reviewer agents (disjoint domains) → 7 fix agents (disjoint files) | 4 High · ~13 Medium · ~24 Low | ✅ fixed |
| 2b | 2026-06-29 | follow-up: resolve the 11 Pass-2 deferrals | 11 items (9 commits) | ✅ fixed (2 scoped) |

**Verification (Pass 2, post-fix):** `tsc -b` clean · `vitest` **277 passed** (was 253;
+24 tests) · `vite build` clean · new migration `0003` validated.

---

## Pass 2 (2026-06-29) — second detailed review

A fresh detailed pass after Pass 1. Eight reviewer agents each owned a disjoint
slice of the codebase (crypto/SSRF, authn/authz, DB, monitoring engine,
notifications/history, routes/API, React client, shared/schemas/migrations/config)
and were asked to find what Pass 1 missed, adversarially verifying every finding
against the actual code before reporting. Fixes were then applied by seven agents
over **disjoint file sets** (so parallel edits could not collide), followed by one
central verification pass (typecheck + full test suite + build).

**Headline:** the most impactful cluster was the interaction between **heartbeat
monitors, schedule-aware gating, and migration `0002`** — three independent
reviewers converged there. Pass 1 hardened the *pure* schedule functions; Pass 2
found that the heartbeat ↔ schedule *seams* still broke the defining
"scheduled-off must not count against uptime" invariant, and that `0002` shipped a
column with no backfill. None of these require an attacker — they degrade core
alerting accuracy for ordinary users.

### High (4) — all fixed

#### H1 — Migration `0002` added `last_beat_at` with no backfill → false DOWN storm on upgrade
`migrations/0002_review_fixes.sql` adds `monitor_state.last_beat_at` but never
backfills it, so existing rows are `NULL`. The scheduler bases the heartbeat
deadline on `last_beat_at ?? createdAt` (`scheduler.ts`); with `NULL` it falls back
to the (old) `createdAt`, making every heartbeat monitor instantly "overdue" on the
first post-upgrade cron — and the freshness guard in `markHeartbeatMissed` is
*bypassed* precisely because `last_beat_at` is `NULL`. Result: every healthy
heartbeat monitor flips DOWN, opens a spurious incident, dents uptime, and pages
the operator.
**Fix:** new migration `migrations/0003_heartbeat_backfill.sql` —
`UPDATE monitor_state SET last_beat_at = COALESCE(last_success_at, last_checked_at) WHERE last_beat_at IS NULL;`

#### H2 — Heartbeat missed-deadline ignored the schedule → false DOWN on every window reopen
`scheduler.ts` / `checks/state.ts`. After a `scheduled_off` period, the deadline
base was the pre-off `last_beat_at` (hours/days old), so the *first in-window tick*
after (e.g.) a weekend was instantly overdue → spurious incident + alert before the
job could send its first beat. Recurred on every reopen.
**Fix:** added `warmHeartbeat()` and a one-cycle warm-up on the
`scheduled_off|unknown → active` transition for heartbeat monitors (resets the
deadline base to `now`, state → `warming_up`). Genuine misses are still caught on
subsequent ticks.

#### H3 — Heartbeat *ingestion* was not schedule-aware → off-hours beats counted against uptime
`routes/heartbeats.ts` / `checks/state.ts`. The public `/hb/:token` path checked
maintenance but never the schedule, so an off-hours beat opened incidents, fired
alerts, and wrote `down_seconds` / `monitored_seconds` — violating the
scheduled-off invariant for the entire heartbeat monitor type.
**Fix:** `recordHeartbeat` now takes `opts.scheduledOff`; the route computes
`!isActiveAt(monitor.schedule, …)` and, when off-schedule, records the beat as
`scheduled_off` with no incident/notification/rollup side effects (mirroring
`setScheduledOff`) while still advancing `last_beat_at`.

#### H4 — Setup write-lock keyed on `setup_complete`, not on an existing admin → bootstrap-window admin injection
`routes/setup.ts`. `guardWrite` rejected anonymous writes only when setup was
*complete*, so during the pre-completion window any anonymous caller could
`POST /api/setup/save` an `adminEmail`, `/complete`, then log in — even on a
deployment that had pre-seeded an env admin (per-key precedence left the *email*
identity unset). The intended guard, `hasAdminConfigured()`, was defined but never
called.
**Fix:** `guardWrite` now rejects anonymous writes when
`(isSetupComplete(env) || hasAdminConfigured(env)) && !session`. A truly fresh
instance still bootstraps anonymously; the first write that establishes an admin
still succeeds; every subsequent mutation requires a session.

### Medium (~13) — all fixed

- **`resolveIncident` was not idempotent** (`db/incidents.ts`) — no `status='open'`
  guard; a double/raced resolve (reachable from the unlocked heartbeat route)
  re-stamped `resolved_at`, inflated `duration_seconds`, and inserted a second
  "recovered" timeline event. **Fix:** `… WHERE id=? AND status='open'`; the
  recovered-event INSERT runs only when `meta.changes === 1`. (Pass 1 hardened the
  symmetric *open* path with a unique index but left *resolve* unguarded.)
- **Web Push endpoint not SSRF-validated** (`notifications/push/webpush.ts`) — the
  push path lacked the `assertSafeUrl` guard channels got in Pass 1, and the test
  route reflected ~200 B of the target response. **Fix:** validate
  `subscription.endpoint` before fetch (covers test + outbox); invalid/blocked →
  pruned, not retried.
- **Cross-origin redirect forwarded the request body** (`checks/http.ts`) — headers
  were stripped on a cross-origin hop but a 307/308 still re-sent the body (which
  may carry a secret) to the server-chosen target. **Fix:** drop the body on any
  cross-origin hop too.
- **No per-run batch cap** (`scheduler.ts`) — unbounded due-monitor fan-out could
  exhaust the Worker subrequest/CPU budget (→ mass false `network_error`) and run
  past the 12-min cadence / 5-min lease (→ overlapping crons double-count).
  **Fix:** order by `next_check_at`, cap at `MAX_CHECKS_PER_RUN=200`, `log` deferred
  work (no silent cap).
- **One monitor's DB error aborted the whole cycle** (`scheduler.ts`) — the
  `setScheduledOff`/`setMaintenanceState` skip-paths had no try/catch. **Fix:**
  per-monitor try/catch, matching the HTTP/heartbeat branches.
- **`url` schema accepted `javascript:`/`data:`/`file:`** (`shared/schemas.ts`) —
  `z.string().url()` passes them, and the value is rendered as a clickable admin
  link. **Fix:** `.max(2048)` + http(s)-scheme refine.
- **Public status-page URLs unvalidated** (`routes/settings.ts` +
  `client/pages/PublicStatus.tsx`, `MonitorDetail.tsx`) — `status_page_homepage` /
  `status_page_logo` had no server validator and were rendered as `href`/`src` on
  the *public* page. **Fix:** server validators mirroring `app_url`, plus a client
  `safeHttpUrl()` guard that only emits http(s) `href`/`src` (defense-in-depth — see
  note vs Pass 1 below).
- **Missing length/array bounds across schemas** (`shared/schemas.ts`) — a 2 MB
  `url` validated; arrays were uncapped. **Fix:** `.max()` on body (64 KB), header
  value (8 KB), public name/description/group (256), etc.; `.max()` counts on
  headers/assertions/weekdays/days/periods/excludedDates/channels; `weekdays.min(1)`
  (a no-weekday schedule silently never ran); `excludedDates` regex-validated.
- **No outbound timeouts on notifications** (`channels/discord|resend|webhook`,
  `push/webpush`) — one hung endpoint stalled the sequential outbox drain and the
  post-drain rollup/weekly/cleanup. **Fix:** `signal: AbortSignal.timeout(10000)` on
  all four.
- **Web Push bypassed per-monitor channel restriction** (`notifications/enqueue.ts`)
  — a monitor scoped to one channel still pushed to every device. **Fix:** push is
  suppressed under a restriction unless opted in via a `"push"` sentinel in
  `notify.channels`.
- **No coalescing → flapping notification storm** (`notifications/enqueue.ts`) — a
  flapping monitor emitted one alert per incident (dozens/hour). **Fix:** per-monitor
  per-event-type cooldown (1 h, mirrors `FLAP_WINDOW`) checked against the outbox;
  fails *open*; never suppresses `recovered`.
- **Unbounded heartbeat payload** (`routes/heartbeats.ts`) — the one public write
  path persisted uncapped `message`/`metrics` into `samples.meta`, so a leaked token
  could bloat storage / exhaust the D1 write budget. **Fix:** cap `message` (1000),
  `runId` (200), `metrics` (50 keys). *(Per-token rate-limiting deferred — see
  below.)*
- **Encryption silently failed open when `MASTER_KEY` unset** (`lib/secret-config.ts`)
  — all secrets stored plaintext with no signal. **Fix:** a one-time `console.warn`
  when a real secret is persisted without a key (kept best-effort — does not throw,
  so no-key deploys still run).

### Low (~24) — fixed

Monitoring/schedule: excluded-overnight divergence between `isActiveAt` and
`nextActivePeriod` + clamp `setScheduledOff` `nextAt` to `max(start, now)`
(`lib/schedule.ts`, `checks/state.ts`); warm-up after maintenance ends
(`scheduler.ts`); heartbeat recovery no longer double-counts monitored seconds
(`checks/state.ts`); lease no longer leaks if `recordRunStart` throws
(`scheduler.ts`); heartbeats default to POST/HEAD only so link-preview GETs can't
forge beats (`routes/heartbeats.ts`, intentional behavior change).
DB: removed dead exports (`markNotified`/`setFlapping`/`isFlapping`,
`getOpenInterval`); weekly maintenance recurrence now respects its `[startsAt,
endsAt)` range (`db/maintenance.ts`); `failures`/`last_failure_at` reset on
re-subscribe (`db/push.ts`).
Notifications/history: `avgResponseMs` numerator/denominator now agree (ok-only
latency, `history/rollups.ts` + `weekly.ts`); Discord embeds truncated to limits +
markdown-escaped (`payload.ts`); embed color reflects the real event state; VAPID
first-keygen made atomic (`push/vapid.ts`); malformed push key returns
`invalid_subscription` instead of throwing (`push/webpush.ts`); stale retention
comment corrected.
SSRF/crypto: blocked `fec0::/10` + single-hextet IPv4-compatible IPv6 +
multicast/reserved IPv4, with encoded-loopback regression tests (`lib/ssrf.ts`).
Auth: magic-link single-use made atomic via `DELETE … RETURNING` (`routes/magic.ts`);
`app_url` required at setup completion (`routes/setup.ts`, wizard already collects
it).
Routes/validation: per-type channel `config` validation (`routes/channels.ts`);
`Cache-Control` on the public `/status` endpoint (`routes/public.ts`).
Client: bootstrap no longer swallows auth-status errors → Login shows an error +
retry instead of a silent "no providers" dead-end (`lib/bootstrap.tsx`,
`pages/Login.tsx`); `api()` error message uses the status code, not the
empty-over-HTTP/2 `statusText` (`lib/api.ts`); `useFetch.reload()` got an
unmount/stale guard (`lib/useFetch.ts`); Maintenance badges tick with wall-clock
time (`pages/Maintenance.tsx`); accent input validates/normalizes with the server's
hex pattern (`pages/StatusPageSettings.tsx`).

### Deferred items — now resolved (follow-up pass)

All 11 Pass-2 deferrals were subsequently fixed in a sequence of focused, verified
commits (each `tsc -b` + tests green; migrations validated on SQLite via the full
0001→0005 chain). Two have a deliberately scoped resolution, noted below.

| Item | Resolution |
|------|------------|
| `timingSafeEqual` length leak (`lib/timing.ts`) | Now SHA-256-hashes both inputs and compares fixed-length digests (no content or length leak). Made async; all 4 call sites await it. |
| Per-token heartbeat rate-limiting (`routes/heartbeats.ts`) | Min-interval throttle (5s, ≪ the 60s schema minimum) via an indexed `last_beat_at` read; over-rate beats are acked but skip writes. Fails open. |
| Recurring windows in public "upcoming" (`db/maintenance.ts`) | Added `nextRecurringOccurrence()`; recurring windows are projected to their next occurrence (within the validity range) and shown in `upcoming`. +5 tests. |
| `deleteMonitor` outbox purge (`db/monitors.ts`) | Migration `0004` adds `notification_outbox.monitor_id` (+ index); enqueue stamps it, deleteMonitor purges it, and flap-coalescing now matches the indexed column. |
| OAuth `state` browser-binding (`routes/auth.ts`) | Bound to an HttpOnly cookie set at `/start` and verified (constant-time) on callback (double-submit). |
| Session revocation beyond self-logout (`lib/sessions.ts`) | Added `revokeAllSessions()` + `POST /api/auth/logout-all`. *Scope:* the capability/endpoint exists; no client account-menu UI was wired (none exists today — a separate follow-up). |
| `noUncheckedIndexedAccess` | Enabled in all 3 tsconfig projects; fixed all 27 resulting errors (regex groups, loop indices, `SORT_COLUMNS as const`, count defaults, a `STEPS[step]` crash guard). |
| `CHECK` constraints on enum columns | Migration `0005` adds `BEFORE INSERT/UPDATE` triggers enforcing `incidents.status ∈ {open,resolved}` (no risky table rebuild). *Scope:* only the index-backing `status` column; other enums are left to the TS types. |
| Placeholder `database_id` (`wrangler.jsonc`) | Replaced the zero-UUID with `REPLACE_WITH_YOUR_D1_DATABASE_ID` + comment so a missed step fails loudly; verified the build still loads (id is remote-only). |
| `@cloudflare/workers-types` pin bump | Switched the worker types from the stale `2023-07-01` entrypoint to the undated default (tracks the installed `4.20260629.x`, aligned with the runtime). |
| Code-split admin SPA off the public bundle (`client/App.tsx`) | Admin pages `React.lazy`-loaded behind `Suspense`; the bundle anonymous `/status` visitors download dropped ~400 kB → ~297 kB. |

### Note: two findings revisited from Pass 1

Pass 1 explicitly *rejected* two items as "by design under the single-admin model."
Pass 2 added **defense-in-depth** for both (cheap, and they align the schema/render
boundary with what the code already assumes) — not a reversal, a hardening:

- **Public-page `homepage`/`logo` URL** — Pass 1: only the trusted admin can set it.
  Pass 2: added http(s) scheme validation (server + client) so a `javascript:` value
  can never reach a public-page `href`/`src`, consistent with the `app_url` validator
  Pass 1 itself added for the email path.
- **Magic-link base URL from request `Host`** — Pass 1: the Workers model fixes the
  origin. Pass 2: require `app_url` at setup completion so the security-sensitive
  sign-in link never depends on the request `Host`.

---

## Appendix — Pass 1 (2026-06-29) summary

Full security + coding review via 9 parallel reviewer agents + an adversarial
verifier; 24 raw → 21 confirmed (0 Critical, 0 High, 7 Medium, 12 Low, 2 Info),
all fixed. Migration `0002_review_fixes.sql` (`last_beat_at` column +
`idx_incidents_one_open` unique partial index). Tests 245 → 253.

**Medium:** unauth `GET /api/setup/state` leaked the admin identity · VAPID private
key could leak into `GET /api/settings` · response body buffered before the size
cap (memory DoS) · cross-origin redirect leaked credential *headers* · `createMonitor`
wrote two non-atomic INSERTs (orphan monitors) · open incidents inflated downtime
across off-hours/maintenance · heartbeat overdue test keyed off last *success* not
last *beat*.
**Low:** `auth_tokens`/sessions never GC'd · encryption-at-rest bypass for
`v1:`-prefixed plaintext · SSRF IPv6 encoding gaps (compat/6to4/NAT64) · maintenance
`title` exposed publicly · no security headers (clickjacking) · missing
maintenance-window invariants · notification webhook/Discord URLs bypassed SSRF
guard · bookkeeping failure could re-deliver a sent notification · email `href` not
escaped · weekly-summary defaults unreachable · `scheduler_runs` grew unbounded ·
heartbeat-ingestion vs scheduler race.
**Info:** unbounded incident-annotation fields · heartbeat secret input not masked.

(Several Pass 2 findings are the *seams left by* Pass 1 fixes — e.g. the `0002`
column without a backfill, and the open-incident hardening that covered `open` but
not `resolve`.)
