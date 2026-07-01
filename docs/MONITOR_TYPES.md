# Monitor types

OpenPing supports several kinds of monitor. Most are **polled** — the scheduled
Worker runs them on a cadence and records `up` / `degraded` / `down`. One
(**Heartbeat**) is **push-based** — your job pings OpenPing, and OpenPing alerts
you when the ping *stops* arriving.

Every polled check runs **inside the Cloudflare Workers runtime**, from the edge
location near the cron isolate. That keeps the whole thing free and
zero-infrastructure, but it also sets some hard boundaries on what a check *can*
observe — see [Not supported (and why)](#not-supported-and-why) at the bottom for
the honest list.

| Type | What it watches | How it runs |
| --- | --- | --- |
| [HTTP / API](#http--api) | An HTTP(S) endpoint's status, body, latency | Polled (`fetch`) |
| [Heartbeat / cron](#heartbeat--cron) | A job that should check in on a schedule | Push (you ping us) |
| [DNS record](#dns-record) | A DNS record resolves (and optionally matches) | Polled (DNS-over-HTTPS) |
| [TCP port](#tcp-port) | A `host:port` accepts a connection | Polled (`connect()`) |
| [Domain expiry](#domain-expiry) | A domain's registration isn't lapsing | Polled (RDAP) |

Every monitor also shares the common settings — a **name**, an optional
**operating schedule** (schedule-aware monitoring), **notification** channels,
**public status-page** visibility, and an **enabled** toggle. This page focuses
on the per-type `config` that makes each kind distinct.

---

## HTTP / API

The classic uptime check: OpenPing sends an HTTP request and decides health from
the response status, its body, and how long it took.

**What it does.** Issues a request with your chosen method/headers/body/auth,
follows redirects (optionally), and evaluates the response against an expected
status range, optional keyword / JSON assertions, and optional latency
thresholds.

**Config fields.**

- `url` — the http(s) URL to check (required).
- `method` — HTTP method (default `GET`).
- `headers` — array of request headers.
- `body` — optional request body (replayed on every check).
- `auth` — `none`, or basic/bearer/header credentials (stored encrypted).
- `followRedirects` — follow 3xx (default `true`).
- `expectedStatus` — `{ min, max }` status range considered healthy
  (default `200`–`399`).
- `timeoutMs` — request timeout (default `60000`).
- `warmupTimeoutMs` — a longer timeout applied on the first check after a
  schedule warm-up, for hosts that cold-start (default `120000`).
- `degradedResponseMs` / `failResponseMs` — optional latency thresholds
  (`degradedResponseMs` must be `<=` `failResponseMs`).
- **Assertions** (separate from `config`) — keyword `contains` / `not_contains`
  and `json_path_equals` / `json_path_contains` checks on the response body.

**How up / degraded / down is decided.**

- **Down** — the request errored/timed out, the status fell outside
  `expectedStatus`, an assertion failed, or latency crossed `failResponseMs`.
  OpenPing also raises a distinct **Suspended** status when a host signals
  free-tier suspension (e.g. Render).
- **Degraded** — the request succeeded but latency crossed `degradedResponseMs`
  (and not `failResponseMs`).
- **Up** — status in range, all assertions pass, latency under any thresholds.

---

## Heartbeat / cron

For things that *push* to you instead of being polled: backups, cron jobs,
queue workers, batch pipelines. OpenPing gives you a URL to ping at the end of a
successful run and alerts you when a ping is **late**.

**What it does.** Records the time of each incoming ping and compares "now"
against the last ping plus your interval and grace window.

**Config fields.**

- `intervalSeconds` — how often you expect a ping (default `3600`, i.e. hourly;
  min 60s).
- `graceSeconds` — slack before a missing ping counts as late (default `300`).
- `acceptedMethods` — optionally restrict which HTTP methods the ping endpoint
  accepts.
- `secret` — optional shared secret that must accompany the ping.

**How up / degraded / down is decided.**

- **Up** — a ping arrived within `intervalSeconds + graceSeconds`.
- **Down (missed)** — no ping arrived by the deadline; OpenPing keeps it marked
  missed each cycle until a ping resumes.

> Heartbeats are the one type that isn't affected by the Workers *outbound*
> limits below — nothing is dialed out; you call in.

---

## DNS record

Confirms that a name resolves, and (optionally) that it resolves to the value
you expect — handy for catching a blown DNS change, a dropped `MX`, or a `TXT`
verification record that vanished.

**What it does.** Resolves the record over **Cloudflare's public
DNS-over-HTTPS** JSON API and, if you set an assertion, checks the resolved
values against it.

**Config fields.**

- `hostname` — the name to resolve, e.g. `example.com` or `_dmarc.example.com`
  (underscore labels are allowed for records like `_dmarc` / `_acme-challenge`).
- `recordType` — one of `A`, `AAAA`, `CNAME`, `MX`, `TXT`.
- `expected` (optional) — `{ mode, value }` where `mode` is `equals` or
  `contains`. The assertion passes if **any** resolved record matches.
- `timeoutMs` — query timeout (default `10000`, max `30000`).

Values are normalized before comparison: `TXT` payloads are unquoted, and
`CNAME`/`MX` targets have their trailing root dot stripped, so you can write
`equals` assertions naturally (`mail.example.com`, not `mail.example.com.`).

**How up / degraded / down is decided.**

- **Down** — the query timed out or errored, the name didn't resolve
  (NXDOMAIN / SERVFAIL), there were no records of the requested type, or your
  `expected` assertion didn't match any resolved value.
- **Up** — records of the requested type were returned and (if set) the
  assertion matched.
- DNS checks don't produce a `degraded` state.

> **Trusted resolver.** The resolver host is a **fixed constant**
> (`cloudflare-dns.com`), never your input, so this can't be turned into an SSRF
> vector — you're choosing the *name to look up*, not the server to query. Note
> that results reflect what Cloudflare's public resolver sees, which may differ
> from a split-horizon / internal DNS view.

---

## TCP port

The lowest-level reachability check: can something accept a TCP connection on a
given port? Good for databases, SMTP-submission ports, game servers, or any
service where "the socket opens" is a meaningful signal.

**What it does.** Opens a raw socket to `host:port` via the Workers
`cloudflare:sockets` `connect()` API and reports whether the connection is
**accepted** within the timeout. It does not send or read any bytes — success is
purely "the port accepted the connection."

**Config fields.**

- `host` — hostname or IP to connect to.
- `port` — TCP port, `1`–`65535` (but **not 25** — see below).
- `timeoutMs` — connection timeout (default `10000`, max `30000`).

**How up / degraded / down is decided.**

- **Up** — the connection opened within `timeoutMs`.
- **Down** — the connection was refused, or the timeout elapsed with no accepted
  connection (e.g. a filtered port silently dropping the SYN).
- TCP checks don't produce a `degraded` state.

> **Port 25 is blocked.** Outbound port 25 (SMTP) is blocked by the Cloudflare
> Workers runtime, so a check against it can never succeed. OpenPing rejects
> port 25 at validation time rather than let it fail forever. (For mail, monitor
> the submission ports — 465 / 587 — instead.)
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

Warns you *before* a domain silently lapses — the kind of outage that takes a
whole site down and is painful to recover from.

**What it does.** Looks up the domain's registration record over **RDAP** (the
modern, structured successor to WHOIS) via `rdap.org`, which redirects to the
authoritative registry's RDAP server, then reads the `expiration` event date.

**Config fields.**

- `domain` — a registrable domain such as `example.com` (must have at least one
  dot; underscores aren't allowed here, unlike DNS `hostname`).
- `warnDays` — how many days before expiry to flag the domain as **degraded**
  (default `30`, range `1`–`365`).
- `timeoutMs` — RDAP query timeout (default `15000`, max `30000`).

**How up / degraded / down is decided** — based purely on the expiration date:

- **Down** — the domain has already expired (`daysUntil <= 0`), or the RDAP
  lookup failed / returned no parseable expiration event.
- **Degraded** — expiry is within `warnDays` (your early warning).
- **Up** — expiry is further out than `warnDays`.

Each result carries the parsed `expiresAt` timestamp and `daysUntil` count for
display.

> **Trusted RDAP endpoint.** Like the DNS resolver, `rdap.org` is a **fixed
> constant** (never your input) — you supply the *domain to look up*, not the
> server. Redirects to the authoritative registry are followed within the
> runtime's hop cap. Coverage depends on the registry: most gTLDs (`.com`,
> `.net`, `.org`, and many others) publish RDAP with an expiration event; some
> ccTLDs expose limited or no RDAP data, in which case the check reports
> `rdap_no_expiry`. A few registries — notably Google's `.dev`/`.app` — reject
> automated RDAP requests from Cloudflare's network with an `rdap_error` (HTTP
> 403); domain-expiry monitoring isn't available for those TLDs. (DNS and TCP
> monitoring of hosts on those domains work fine — this only affects the
> registration-expiry lookup.)

---

## Not supported (and why)

OpenPing runs its checks inside the Cloudflare Workers runtime. That's what makes
it free and infrastructure-free — but the runtime genuinely can't do a few things
other monitoring tools offer. We'd rather be upfront than pretend:

- **SSL / TLS certificate expiry.** The Workers `fetch()` and `connect()` APIs do
  **not** expose the peer's TLS certificate to your code, so the certificate's
  `notAfter` (expiry) date is simply unreadable from inside the runtime. A TCP
  check to port 443 tells you the port is *open*, but not what the cert says.
  Real cert-expiry monitoring would require an **opt-in external certificate
  API** — a possible future addition, not something we can fake in-runtime today.

- **ICMP ping.** Classic `ping` uses ICMP echo, which needs a **raw socket**.
  Workers can't send ICMP or open raw sockets, so there's no true ICMP ping. Use
  a [TCP port](#tcp-port) check for reachability, or an [HTTP](#http--api) check
  for an actual service, instead.

- **UDP monitoring.** The runtime provides no **raw UDP egress**, so UDP-based
  services (e.g. plain DNS over UDP, QUIC probes, game protocols over UDP) can't
  be checked directly. DNS is covered via [DNS-over-HTTPS](#dns-record) instead;
  other UDP services aren't monitorable here.

- **User-selectable multi-region probes.** Checks originate from Cloudflare's
  edge **near the cron isolate that runs them** — not from arbitrary regions you
  pick. There's no "check from Frankfurt and Sydney" control. If you need
  explicit multi-region probing, that's outside what a single-Worker deployment
  can offer.

> The short version: OpenPing is honest about being an edge-Worker monitor. What
> it does — HTTP, heartbeat, DNS-over-HTTPS, TCP `connect()`, and RDAP domain
> expiry — it does well and for free. What needs raw sockets, the peer TLS cert,
> or region control lives outside the runtime, and we don't paper over that.
