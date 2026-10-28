# Monitor types

OpenPing supports several kinds of monitor. Most are **polled** - the scheduled
Worker runs them on a cadence and records `up` / `degraded` / `down`. One
(**Heartbeat**) is **push-based** - your job pings OpenPing, and OpenPing alerts
you when the ping *stops* arriving.

Every polled check runs **inside the Cloudflare Workers runtime**, from the edge
location near the cron isolate. That keeps the whole thing free and
zero-infrastructure, but it also sets some hard boundaries on what a check *can*
observe - see [Not supported (and why)](#not-supported-and-why) at the bottom for
the honest list.

| Type | What it watches | How it runs |
| --- | --- | --- |
| [HTTP / API](#http--api) | An HTTP(S) endpoint's status, body, latency | Polled (`fetch`) |
| [Heartbeat / cron](#heartbeat--cron) | A job that should check in on a schedule | Push (you ping us) |
| [DNS record](#dns-record) | A DNS record resolves (and optionally matches) | Polled (DNS-over-HTTPS) |
| [TCP port](#tcp-port) | A `host:port` accepts a connection | Polled (`connect()`) |
| [Domain expiry](#domain-expiry) | A domain's registration isn't lapsing | Polled (RDAP) |

Every monitor also shares the common settings - a **name**, an optional
**operating schedule** (schedule-aware monitoring), **notification** channels,
**public status-page** visibility, and an **enabled** toggle. Polled monitors
also have **Confirm failures** (below). This page focuses on the per-type
`config` that makes each kind distinct.

## First check right away

A new monitor is checked as soon as you create it, from the web editor, the API (`POST /api/monitors`), MCP `create_monitor` or `op monitors create`.
The dashboard shows a real state within seconds instead of after the next cron run, up to 12 minutes later.
It makes the same decision the scheduler would: inside a maintenance window it shows Maintenance, outside its schedule it shows Scheduled off, and a polled monitor is checked once and the result stored.
That first check is a warm-up cycle, like the first check of any monitor: if it fails, the monitor shows Warming up, no incident opens and nothing alerts, and the next scheduled check is a normal one.
A heartbeat monitor waits for its first ping.
The create request waits up to 5 seconds for the check and returns it as `firstCheck` (`checked`, `scheduled_off`, `maintenance`, `skipped` or `running`); a slower check finishes in the background and the monitor page refreshes until its state arrives.
Imported backups are not checked on import; the next cron run checks them.

## Confirm before alerting

One failed request shouldn't page anyone.
When a polled check fails on a monitor that was up, OpenPing checks it once more about 5 seconds later, bypassing Cloudflare's cache (`cache: "no-store"`).
Only if that second check fails too does the monitor go down, open an incident and send alerts; the incident then shows "Confirmed by a second check before alerting".
If the second check passes, the monitor stays up and the sample is recorded as a blip (`retry_recovered`, and `"confirmation": "cleared"` in the sample's meta), with no incident and no alert.

The setting is **Confirm failures** in the monitor editor (`confirmFailures` in the API and MCP, `--confirm` in the CLI):

- **Retry once** (`retry`, the default): the behaviour above.
- **Off** (`off`): the first failed check opens the incident and alerts, one fetch per check.

Details:

- **Recovery isn't delayed.**
  A monitor that is already down gets no second check: one failure is enough to keep the incident open, and the first passing check resolves it.
- **Heartbeats aren't confirmed.**
  A missed heartbeat is the absence of a ping, so there is nothing to re-check; the grace period is the heartbeat's confirmation.
- **SSRF-blocked targets** (`blocked_url`, `blocked_host`) aren't re-checked: the answer can't change.
- **Domain monitors** re-check only a failed lookup with no recent read to fall back on, and not a rate-limited one (HTTP 429), which waits for the next run instead; an expired date isn't re-checked.
  See [Domain expiry](#when-a-lookup-fails).
- **It fits the free plan.**
  The re-check costs one more outbound fetch and no database queries.
  If a run has no fetch left for it, the failure is not recorded at all and the monitor stays due, so the next run (12 minutes later) checks and confirms it first; an unconfirmed failure never alerts.
  See [FREE_TIER.md](./FREE_TIER.md).
- **Where it's counted.**
  Settings > Diagnostics shows each scheduler run's re-checks ("Re-checks", with how many cleared and, in the tooltip, how many waited for budget); `/api/diagnostics` returns `confirmations`, `confirmationsCleared` and `confirmationsDeferred` per run.
- **Same location.**
  Both checks run from the same Cloudflare location, so a problem only on the path from that location still alerts.
  A check from a second location is possible on Workers (a Durable Object created with a `locationHint` makes its fetch from where it lives) and fits the Free plan, but it needs a Durable Object binding and migration in every install and can't be tested locally, so it is left for Hosted stage 2 ([HOSTED_PLAN.md](./HOSTED_PLAN.md)).

---

## HTTP / API

The classic uptime check: OpenPing sends an HTTP request and decides health from
the response status, its body, and how long it took.

**What it does.** Issues a request with your chosen method/headers/body/auth,
follows redirects (optionally), and evaluates the response against an expected
status range, optional keyword / JSON assertions, and optional latency
thresholds.

**Config fields.**

- `url` - the http(s) URL to check (required).
- `method` - HTTP method (default `GET`).
- `headers` - array of request headers.
- `body` - optional request body (replayed on every check).
- `auth` - `none`, or basic/bearer/header credentials (stored encrypted).
- `followRedirects` - follow 3xx (default `true`).
- `expectedStatus` - `{ min, max }` status range considered healthy
  (default `200`–`399`).
- `timeoutMs` - request timeout (default `60000`).
- `warmupTimeoutMs` - a longer timeout applied on the first check after a
  schedule warm-up, for hosts that cold-start (default `120000`).
- `degradedResponseMs` / `failResponseMs` - optional latency thresholds
  (`degradedResponseMs` must be `<=` `failResponseMs`).
- **Assertions** (separate from `config`) - keyword `contains` / `not_contains`
  and `json_path_equals` / `json_path_contains` checks on the response body.

**How up / degraded / down is decided.**

- **Down** - the request errored/timed out, the status fell outside
  `expectedStatus`, an assertion failed, or latency crossed `failResponseMs`.
  OpenPing also raises a distinct **Suspended** status when a host signals
  free-tier suspension (e.g. Render).
- **Degraded** - the request succeeded but latency crossed `degradedResponseMs`
  (and not `failResponseMs`).
- **Up** - status in range, all assertions pass, latency under any thresholds.

---

## Heartbeat / cron

Heartbeat monitors cover jobs that report their own completion, such as backups, cron jobs, queue workers, and batch pipelines.
OpenPing gives the job an ingestion URL and alerts when an expected ping is late.

**What it does.** OpenPing records each accepted ping and compares the current time with the last ping plus the configured interval and grace window.

**Config fields.**

- `intervalSeconds` - how often you expect a ping, with a default of `3600` seconds and a minimum of 60 seconds.
- `graceSeconds` - slack before a missing ping counts as late (default `300`).
- `acceptedMethods` - HTTP methods accepted by the endpoint.
- `secret` - optional shared secret that must accompany the ping.

### Copy and protect the ingestion URL

The full ingestion URL is shown once when a heartbeat monitor is created.
OpenPing stores only a SHA-256 hash of its token, so the URL cannot be recovered from the database or displayed again later.
Store it in the calling job's secret manager before leaving the monitor detail screen.

If the URL is lost or exposed, select **Generate new URL** or **Rotate** on the monitor detail screen.
Rotation shows the replacement once and immediately invalidates the previous URL.

An imported heartbeat monitor also receives a new token.
The data import API returns it once in the response's `heartbeatMonitors` array.

### Send a heartbeat

`POST` and `HEAD` are accepted when `acceptedMethods` is omitted or empty.
`GET` is intentionally rejected by default because link previews, browser prefetching, and address-bar visits could otherwise record false successes.
Add `GET` to `acceptedMethods` only when a client cannot send `POST` or `HEAD`.

Send a basic successful heartbeat with:

```bash
curl -X POST "https://status.example.com/hb/<token>"
```

Use `HEAD` when the caller does not need a response body:

```bash
curl --head "https://status.example.com/hb/<token>"
```

An accepted heartbeat returns HTTP `200` with an `ok` JSON response for ordinary requests.
Requests using a method outside the allowlist return `405`.

### Authenticate with an optional shared secret

The ingestion token in the URL is already a bearer capability.
The optional `secret` adds a second credential and can be supplied in one of three ways:

```bash
# Recommended header
curl -X POST "https://status.example.com/hb/<token>" \
  -H "X-Heartbeat-Secret: $HEARTBEAT_SECRET"

# Bearer header
curl -X POST "https://status.example.com/hb/<token>" \
  -H "Authorization: Bearer $HEARTBEAT_SECRET"

# Query parameter, which may be exposed in logs and history
curl -X POST "https://status.example.com/hb/<token>?secret=$HEARTBEAT_SECRET"
```

Prefer a header because query strings are commonly retained in access logs, shell history, and monitoring systems.
A missing or incorrect configured secret returns `401`.

### Report job metadata and failures

A JSON `POST` can include execution metadata:

```bash
curl -X POST "https://status.example.com/hb/<token>" \
  -H "Content-Type: application/json" \
  -d '{
    "durationMs": 1842,
    "exitStatus": 0,
    "message": "Backup completed",
    "runId": "backup-2026-07-15",
    "metrics": {
      "files": 4821,
      "bytesMb": 913.4
    }
  }'
```

- `durationMs` records the job duration.
- `exitStatus` marks the beat up when omitted or `0`, and down when nonzero.
- `message` stores a short diagnostic message with the sample.
- `runId` associates the sample with an external execution identifier.
- `metrics` accepts finite numeric values for up to 50 named metrics.

The same scalar fields can be supplied as query parameters for simple clients.
Supported aliases include `duration`, `durationMs`, or `ms`; `status`, `exitStatus`, or `exit`; `message` or `msg`; and `runId`, `run_id`, or `rid`.
JSON body values take precedence over query values.

**How up / degraded / down is decided.**

- **Up** - a ping arrived within `intervalSeconds + graceSeconds`.
- **Down (missed)** - no ping arrived by the deadline, and OpenPing keeps it marked missed each cycle until a ping resumes.

> Heartbeats are not affected by the Workers outbound connection limits below because OpenPing does not dial the monitored job.

---

## DNS record

Confirms that a name resolves, and (optionally) that it resolves to the value
you expect - handy for catching a blown DNS change, a dropped `MX`, or a `TXT`
verification record that vanished.

**What it does.** Resolves the record over **Cloudflare's public
DNS-over-HTTPS** JSON API and, if you set an assertion, checks the resolved
values against it.

**Config fields.**

- `hostname` - the name to resolve, e.g. `example.com` or `_dmarc.example.com`
  (underscore labels are allowed for records like `_dmarc` / `_acme-challenge`).
- `recordType` - one of `A`, `AAAA`, `CNAME`, `MX`, `TXT`.
- `expected` (optional) - `{ mode, value }` where `mode` is `equals` or
  `contains`. The assertion passes if **any** resolved record matches.
- `timeoutMs` - query timeout (default `10000`, max `30000`).

Values are normalized before comparison: `TXT` payloads are unquoted, and
`CNAME`/`MX` targets have their trailing root dot stripped, so you can write
`equals` assertions naturally (`mail.example.com`, not `mail.example.com.`).

**How up / degraded / down is decided.**

- **Down** - the query timed out or errored, the name didn't resolve
  (NXDOMAIN / SERVFAIL), there were no records of the requested type, or your
  `expected` assertion didn't match any resolved value.
- **Up** - records of the requested type were returned and (if set) the
  assertion matched.
- DNS checks don't produce a `degraded` state.

> **Trusted resolver.** The resolver host is a **fixed constant**
> (`cloudflare-dns.com`), never your input, so this can't be turned into an SSRF
> vector - you're choosing the *name to look up*, not the server to query. Note
> that results reflect what Cloudflare's public resolver sees, which may differ
> from a split-horizon / internal DNS view.

---

## TCP port

The lowest-level reachability check: can something accept a TCP connection on a
given port? Good for databases, SMTP-submission ports, game servers, or any
service where "the socket opens" is a meaningful signal.

**What it does.** Opens a raw socket to `host:port` via the Workers
`cloudflare:sockets` `connect()` API and reports whether the connection is
**accepted** within the timeout. It does not send or read any bytes - success is
purely "the port accepted the connection."

**Config fields.**

- `host` - hostname or IP to connect to.
- `port` - TCP port, `1`–`65535` (but **not 25** - see below).
- `timeoutMs` - connection timeout (default `10000`, max `30000`).

**How up / degraded / down is decided.**

- **Up** - the connection opened within `timeoutMs`.
- **Down** - the connection was refused, or the timeout elapsed with no accepted
  connection (e.g. a filtered port silently dropping the SYN).
- TCP checks don't produce a `degraded` state.

> **Port 25 is blocked.** Outbound port 25 (SMTP) is blocked by the Cloudflare
> Workers runtime, so a check against it can never succeed. OpenPing rejects
> port 25 at validation time rather than let it fail forever. (For mail, monitor
> the submission ports - 465 / 587 - instead.)
>
> **Private / internal hosts are rejected.** Before dialing, OpenPing runs an
> SSRF guard that refuses loopback (`localhost`, `127.0.0.0/8`, `::1`),
> `.local` / `.localhost` names, cloud-metadata endpoints
> (`169.254.169.254`, `metadata.google.internal`), and private/reserved IP
> ranges (RFC1918, link-local, etc.). The runtime independently blocks the same
> internal destinations as defense-in-depth. TCP monitors are for **public**
> services.

---

## Domain expiry

Warns you *before* a domain silently lapses - the kind of outage that takes a
whole site down and is painful to recover from.

**What it does.** Looks up the domain's registration record over **RDAP** (the modern, structured successor to WHOIS) via `rdap.org`, which redirects to the authoritative registry's RDAP server, then reads the `expiration` event date.
The date it read is cached on the monitor, so most checks are judged from that read without asking RDAP again (below).

**Config fields.**

- `domain` - a registrable domain such as `example.com` (must have at least one
  dot; underscores aren't allowed here, unlike DNS `hostname`).
- `warnDays` - how many days before expiry to flag the domain as **degraded**
  (default `30`, range `1`–`365`).
- `timeoutMs` - RDAP query timeout (default `15000`, max `30000`).

**How up / degraded / down is decided** - based on the expiration date:

- **Down** - the domain has already expired (`daysUntil <= 0`), or there is no usable expiry date at all: the lookup failed or returned no parseable expiration event, and there is no read from the last 7 days to fall back on.
- **Degraded** - expiry is within `warnDays` (your early warning).
- **Up** - expiry is further out than `warnDays`.

Each result carries the `expiresAt` timestamp and `daysUntil` count for display, plus `checkedAt` (when the date was read from RDAP) and `source` (`rdap` when it was read on this check, `cache` when an earlier read was used).

### How often RDAP is asked

An expiration date rarely changes, so asking RDAP every 12 minutes would only spend subrequests and invite rate limits.
Each domain monitor keeps its last successful read (`monitor_state.domain_cache`), and each check judges the date from it, making no request, while it is fresh:

- **Every 6 hours** normally: a read older than that is refreshed on the next check.
- **Every hour** while the domain is within `warnDays` of expiry, so a renewal clears the warning within the hour.
- **At once** when the cached date passes, since the registry may have renewed it at the last minute.
- **At once** when the monitor's `domain` changes, and on the monitor's first check right after it is created.
- **Test** in the monitor page always asks RDAP.

Days left are recomputed from the cached date on every check, so `daysUntil` and the up / degraded / down state stay current between lookups.
A check judged from the cache costs no outbound fetch: the scheduler reserves none for it, and it adds no database queries, because the cache rides on the state row every check already reads and writes.
Such a check records no response time, so the latency chart only shows real lookups.

### When a lookup fails

A failed lookup says nothing about the domain itself, so it does not take the monitor down while a recent read exists:

- If a refresh fails (HTTP 429 or another non-2xx answer, a timeout, a network error, or no parseable expiration event) and the monitor has a read from the last **7 days**, the check is judged from that read: no state change, no incident, no alert.
  The sample's meta carries `lookupError` (`code`, `message`, `at`), and the monitor page shows "Last lookup failed (...), using the expiry read 3h ago".
- After a failed refresh, RDAP is not asked again for an hour, or for as long as a `Retry-After` header asks (up to a day); checks in between use the cached read.
- Only with no usable read (never read, a different domain, or older than 7 days) does a failed lookup count as a failed check, with [Confirm before alerting](#confirm-before-alerting) as for any monitor.
  A 429 is not re-checked 5 seconds later, since it would only be refused again: the confirmation waits for the next run instead, so a rate limit alone never alerts.
- An expired date is down whatever the source, and isn't re-checked: RDAP already said so.

**Rate limits.** `rdap.org` and the registries behind it rate limit bursts: about 16 lookups at once from Cloudflare's network drew HTTP 429s from both `rdap.org` (Cloudflare error 1015) and Google's registry, while lookups a few seconds apart all succeeded.
Besides caching, each scheduler run spaces its RDAP lookups 2 seconds apart.

> **Trusted RDAP endpoint.** Like the DNS resolver, `rdap.org` is a **fixed
> constant** (never your input) - you supply the *domain to look up*, not the
> server. Redirects to the authoritative registry are followed within the
> runtime's hop cap. Coverage depends on the registry: most gTLDs (`.com`,
> `.net`, `.org`, Google's `.dev` and `.app`, and many others) publish RDAP with
> an expiration event; some ccTLDs expose limited or no RDAP data, in which case
> the check reports `rdap_no_expiry`.

---

## Not supported (and why)

OpenPing runs its checks inside the Cloudflare Workers runtime. That's what makes
it free and infrastructure-free - but the runtime genuinely can't do a few things
other monitoring tools offer. We'd rather be upfront than pretend:

- **SSL / TLS certificate expiry (not yet).** The Workers `fetch()` and TLS
  `connect()` APIs do **not** expose the peer's TLS certificate to your code. A
  TCP check to port 443 tells you the port is *open*, but not what the cert
  says. A hand-written TLS 1.2 handshake over a plain TCP socket can read the
  expiry date, with gaps (Cloudflare-proxied sites, TLS 1.3-only servers); see
  [SSL_EXPIRY_SPIKE.md](./SSL_EXPIRY_SPIKE.md) for the research and the plan.

- **ICMP ping.** Classic `ping` uses ICMP echo, which needs a **raw socket**.
  Workers can't send ICMP or open raw sockets, so there's no true ICMP ping. Use
  a [TCP port](#tcp-port) check for reachability, or an [HTTP](#http--api) check
  for an actual service, instead.

- **UDP monitoring.** The runtime provides no **raw UDP egress**, so UDP-based
  services (e.g. plain DNS over UDP, QUIC probes, game protocols over UDP) can't
  be checked directly. DNS is covered via [DNS-over-HTTPS](#dns-record) instead;
  other UDP services aren't monitorable here.

- **User-selectable multi-region probes.** Checks originate from Cloudflare's
  edge **near the cron isolate that runs them** - not from arbitrary regions you
  pick. There's no "check from Frankfurt and Sydney" control. If you need
  explicit multi-region probing, that's outside what a single-Worker deployment
  can offer.

> The short version: OpenPing is honest about being an edge-Worker monitor. What
> it does - HTTP, heartbeat, DNS-over-HTTPS, TCP `connect()`, and RDAP domain
> expiry - it does well and for free. What needs raw sockets, the peer TLS cert,
> or region control lives outside the runtime, and we don't paper over that.
