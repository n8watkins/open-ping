# OpenPing — Security & Coding Review (2026-06-29)

A full security and code-quality review of OpenPing (Cloudflare Worker + React
status-page app). The review fanned out **9 parallel reviewer agents** across
distinct dimensions (auth/sessions, crypto/secrets, SSRF/HTTP, public surface,
SQL/DB, API validation, notifications, monitoring-engine correctness, frontend),
then **adversarially verified every raw finding** with an independent skeptic
agent that re-read the actual code before a finding was allowed to count.

**Result:** 24 raw findings → **21 confirmed**, **3 rejected as false positives**.
All 21 are fixed in this branch. Baseline and post-fix both: `tsc -b` clean,
full test suite green (245 → **253** tests after new cases added), `vite build`
clean, and the new migration validated against SQLite.

| Severity | Count | Status |
|----------|-------|--------|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 7 | ✅ fixed |
| Low | 12 | ✅ fixed |
| Info | 2 | ✅ fixed |

The codebase was already high quality (careful SSRF redirect re-validation,
timing-safe CSRF, hashed session tokens, redacted public API, encryption-at-rest).
No SQL injection, XSS sink (`dangerouslySetInnerHTML`), `eval`, or secret-logging
was found. The confirmed issues are subtler correctness, info-leak, resource, and
defense-in-depth gaps.

---

## Medium

### 1. Unauthenticated `GET /api/setup/state` leaked the admin identity
`src/worker/routes/setup.ts` — The setup router has no auth middleware (it must be
reachable during first-run bootstrap), but the `GET /state` read handler returned
the raw wizard `data`, which mirrors `adminGithubLogin` / `adminEmail`. Any
anonymous caller could read the admin's GitHub login or email **even long after
setup completed** — defeating the deliberate non-disclosure design of the
magic-link flow and the booleans-only `/api/auth/status` endpoint.
**Fix:** after setup is complete, redact `state.data` for unauthenticated callers
(wizard resumability during the bootstrap window is preserved).

### 2. VAPID private key could leak into `GET /api/settings`
`src/worker/db/settings.ts` — `getExportableSettings()` filtered only on the
`encrypted` column. In best-effort mode (no `MASTER_KEY`) the VAPID **private**
key is stored with `encrypted=0`/plaintext, so it was serialized into the settings
API response (and the `/export` route relied on a separate denylist the settings
routes didn't share). **Fix:** centralized a name-based secret denylist
(`isSecretSettingKey`) inside `getExportableSettings()` so every consumer (export,
GET, PUT) is protected uniformly regardless of the `encrypted` flag.

### 3. Response body buffered before the size cap (memory-exhaustion DoS)
`src/worker/checks/http.ts` — `MAX_BODY_CHARS` was applied *after* `res.text()`
fully buffered the body, so a monitored endpoint returning hundreds of MB could
exhaust the ~128 MB isolate and abort the whole cron check cycle. **Fix:** added
`readCappedText()` which streams via `res.body.getReader()` and cancels the reader
once the cap is hit — peak memory bounded to ~cap + one chunk.

### 4. Cross-origin redirect leaked configured credential headers
`src/worker/checks/http.ts` — On a cross-origin redirect only `Authorization` was
stripped; other admin-configured headers (`Cookie`, `X-Api-Key`, bearer-style
secrets) were carried to the redirect target chosen by the untrusted remote
server. **Fix:** drop **all** headers on any cross-origin hop.

### 5. `createMonitor` wrote two non-atomic INSERTs (orphan monitors)
`src/worker/db/monitors.ts` — The `monitors` and `monitor_state` inserts ran as
two separate transactions. A failure between them left a monitor with no state
row; since every other path only `UPDATE`s `monitor_state` (0 rows when absent),
that monitor's state/incidents/next-check could never persist — permanently dead,
yet visible in the UI. **Fix:** wrap both inserts in one `env.DB.batch([...])`,
mirroring `deleteMonitor`.

### 6. Open incidents inflated downtime across off-hours / maintenance
`src/worker/checks/state.ts` — When a monitor went `down` (open incident) and its
schedule window then closed (or maintenance started), `setScheduledOff` /
`setMaintenanceState` never resolved the incident. It stayed open across the whole
un-monitored gap and, on the next successful check, recorded a duration spanning
the gap — corrupting `duration_seconds`, MTTR and total-downtime metrics, and
disagreeing with uptime accounting (which excludes those windows). **Fix:** resolve
any open incident at the moment monitoring pauses (no "recovered" alert fires) and
clear `active_incident_id`.

### 7. Heartbeat overdue test keyed off last *success*, not last *beat*
`src/worker/scheduler.ts` + `src/worker/checks/state.ts` — A heartbeat job that
kept checking in **on time but failing** never advanced `last_success_at`, so the
scheduler also declared it "missed" every cycle — overwriting the real
`exit_status_N` error with `heartbeat_missed` and double-counting downtime.
**Fix:** added a `last_beat_at` column (migration `0002`) written on every received
beat (success *or* failure); the scheduler now bases the deadline on it. A freshness
re-check in `markHeartbeatMissed` also closes a scheduler-vs-ingestion race.

---

## Low

8. **`auth_tokens` / sessions never garbage-collected** (`scheduler.ts`,
   `lib/sessions.ts`) — `cleanupExpiredSessions` had no caller and `auth_tokens`
   (oauth_state / magic_link) were only deleted on a matching callback, so scripted
   hits to `/auth/github/start` grew D1 without bound. **Fix:** wired
   `cleanupExpiredSessions` + a new `cleanupExpiredAuthTokens` into the cron
   retention pass (both index-backed).

9. **Encryption-at-rest bypass for `v1:`-prefixed plaintext**
   (`lib/secret-config.ts`, `db/channels.ts`) — The idempotency guard was a bare
   `startsWith("v1:")` prefix sniff, so a secret the admin chose to begin with
   `v1:` was mistaken for ciphertext and stored in plaintext. **Fix:** a structural
   `isCiphertext()` check requiring the full `v1:<base64>:<base64>` shape.

10. **SSRF IPv6 encoding gaps** (`lib/ssrf.ts`) — `isBlockedIPv6` covered
    IPv4-mapped (`::ffff:…`) but not IPv4-compatible (`::a.b.c.d`), 6to4
    (`2002:<v4>::`), or NAT64 (`64:ff9b::<v4>`) encodings of internal addresses.
    **Fix:** decode and block all three (with unit tests).

11. **Maintenance window internal `title` exposed publicly** (`routes/public.ts`,
    `client/pages/PublicStatus.tsx`) — `toPublicMaint` returned `w.title` despite
    the file's own contract ("only `public_message` is exposed") and the admin UI
    giving Title no "public" hint. **Fix:** drop `title` from the public payload;
    the page uses a generic "Scheduled maintenance" heading (matching how incident
    titles are already anonymized).

12. **No security headers** (`worker/index.ts`) — No CSP / X-Frame-Options /
    nosniff, so the authenticated admin SPA was framable (clickjacking). **Fix:**
    `hono/secure-headers` globally — `frame-ancestors 'none'`, `X-Frame-Options:
    DENY`, `nosniff`, `Referrer-Policy: no-referrer`, and a tailored CSP.

13. **Missing maintenance-window invariants** (`routes/maintenance.ts`) —
    `endsAt <= startsAt` and `scope:"monitors"` with no `monitorIds` both passed
    validation but silently never activated / suppressed nothing. **Fix:** Zod
    refinements + a merged-result check in the update handler.

14. **Notification webhook/Discord URLs bypassed the SSRF guard**
    (`notifications/dispatcher.ts`) — Channel delivery `fetch`ed the configured URL
    with no validation, so a channel could point at `169.254.169.254`/localhost and
    reflect internal responses into `last_error`. **Fix:** run `assertSafeUrl` on
    every delivery (per-delivery, no TOCTOU).

15. **Bookkeeping failure could re-deliver a sent notification**
    (`notifications/dispatcher.ts`, `db/outbox.ts`) — If `recordChannelResult`
    threw after `markSent`, the outer catch flipped the already-sent row back to
    `failed` → duplicate delivery. **Fix:** `markFailed` now guards
    `WHERE status NOT IN ('sent','dead')`, and the bookkeeping is wrapped in its
    own try/catch.

16. **Email `href` not escaped** (`notifications/payload.ts`) — Every value was
    HTML-escaped except `p.url` in the `href` attribute, so a malformed admin
    `app_url` could break out of the attribute. **Fix:** `escapeHtml(p.url)` + an
    `app_url` http(s) validator in `routes/settings.ts`.

17. **Weekly-summary defaults unreachable** (`notifications/weekly.ts`) —
    `Number(null) === 0` made an unset day/hour look valid (Sunday/midnight) instead
    of the documented Monday 09:00. **Fix:** read the raw string and only coerce
    when present.

18. **`scheduler_runs` grew unbounded** (`history/rollups.ts`) — ~120 rows/day were
    inserted but never pruned (unlike samples/summaries/intervals). **Fix:** prune
    past the daily horizon in the retention pass (index-backed).

19. **Heartbeat ingestion vs scheduler race** (`checks/state.ts`, migration) — Beat
    ingestion held no lease, so it could race `markHeartbeatMissed` and orphan an
    incident. **Fix:** a unique partial index `idx_incidents_one_open` (one open
    incident per monitor) as a hard backstop + the `last_beat_at` freshness re-check.

---

## Info

20. **Unbounded incident-annotation fields** (`routes/incidents.ts`) — The PATCH
    schema had no length caps (inconsistent with maintenance's 2000-char caps).
    **Fix:** `.max(2000)` on the free-text fields.

21. **Heartbeat secret input not masked** (`client/pages/MonitorEditor.tsx`) — The
    "Shared secret" field lacked `type="password"` (the basic-auth/bearer fields
    have it). **Fix:** added `type="password"`.

---

## Rejected as false positives (verified NOT real)

- **Magic-link base URL from request origin** — Host-header poisoning is prevented
  by the Cloudflare Workers deployment model (the request URL's origin is the real
  deployed origin), and `APP_URL`/`app_url` takes precedence anyway.
- **Unbounded maintenance recurrence duration** — By design under the trusted
  single-admin model; maintenance exists precisely to suppress alerts for
  operator-chosen periods.
- **Public status page renders unvalidated `homepage`/logo URL** — These are
  writable only by the authenticated single admin (the app's sole trusted user);
  not a cross-user injection vector. (An `app_url` validator was still added as
  defense-in-depth for the email path.)

---

## Schema migration

`migrations/0002_review_fixes.sql`:
- `ALTER TABLE monitor_state ADD COLUMN last_beat_at INTEGER;` (findings 7, 19)
- `CREATE UNIQUE INDEX idx_incidents_one_open ON incidents(monitor_id) WHERE status='open';` (finding 19)

Validated by applying `0001` then `0002` to an in-memory SQLite DB and confirming
the partial index blocks a second open incident per monitor.

## Tests added
- `lib/ssrf.test.ts` — IPv4-compatible / 6to4 / NAT64 internal-address encodings.
- `lib/secret-config.test.ts` — `isCiphertext` structural check + a `v1:`-prefixed
  plaintext secret is still encrypted at rest.

## Verification
`npm run typecheck` ✅ · `npm test` → **253 passed** ✅ · `npm run build` ✅ ·
migration applied & index enforcement proven ✅
