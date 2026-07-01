# Free tools (`/tools`)

OpenPing ships a small suite of free, no-sign-up utility tools at `/tools`, aimed
at people who keep things online.
They are public (no authentication) and are code-split from the admin app, so they
don't weigh on the dashboard bundle.

Index page: `/tools`.
Each tool has its own route below.

---

## The tools

| Tool | Route | What it does | Where it runs |
| --- | --- | --- | --- |
| **Is it down?** | `/tools/is-it-down` | Checks whether a URL is reachable right now and reports its HTTP status and response time. | Server (calls the API below) |
| **Uptime calculator** | `/tools/uptime-calculator` | Converts an SLA percentage into allowed downtime per day/week/month/year, and back. | In the browser |
| **Subnet calculator** | `/tools/subnet-calculator` | Breaks down any IPv4 CIDR: network, broadcast, mask, and host range. | In the browser |
| **Cron expression tester** | `/tools/cron-tester` | Validates a cron expression and previews its next run times. | In the browser |
| **DNS lookup** | `/tools/dns-lookup` | Queries A, AAAA, CNAME, MX, TXT, NS, and SOA records. | In the browser (DNS-over-HTTPS via `dns.google`) |
| **MX lookup** | `/tools/mx-lookup` | Finds a domain's mail servers and their priorities. | In the browser (DNS-over-HTTPS via `dns.google`) |

Everything except "Is it down?" runs entirely client-side: the calculators and the
cron tester are pure computation, and the DNS/MX lookups query a public
DNS-over-HTTPS resolver straight from the visitor's browser.
"Is it down?" is the one tool that needs the server, because a browser can't
reliably probe an arbitrary third-party URL (CORS) and the result should reflect
the public internet, not the visitor's network.

---

## The "Is it down?" API

`POST /api/tools/is-it-down` is public and unauthenticated.
It performs a single `GET` against a caller-supplied URL and reports **only
reachability** - never the response body or headers - so it can't be abused as a
content proxy.

### Request

```jsonc
{ "url": "https://example.com" }
```

The `url` must be an `http(s)` URL of at most 2048 characters.

### Response

```jsonc
{
  "up": true,        // true when the server answered with a non-5xx status
  "status": 200,     // the HTTP status code, or null if nothing answered
  "durationMs": 137, // how long the probe took
  "error": "..."     // present only when up=false (e.g. timeout, dns_error, unreachable, server_error)
}
```

`up` is `true` only when the target answered with an HTTP status below 500.
A 5xx response, or any connection/DNS/timeout failure (no status at all), is
reported as down with an `error` code.

### Guards

Because it fetches arbitrary URLs on behalf of anonymous callers, two guards are
applied before any outbound request:

- **SSRF protection.**
The URL is validated up front (and every redirect hop is re-validated), rejecting
loopback, private, link-local, and cloud-metadata targets as well as credentialed
URLs.
A blocked target returns `400 { "error": "blocked_url" }`; a malformed URL returns
`400 { "error": "invalid_url" }`.
- **Rate limiting.**
Fixed one-minute windows counted in D1 cap each client IP at **15 requests/min**
and enforce a **global ceiling of 300 requests/min** across all callers.
When either limit is hit the API returns `429 { "error": "rate_limited" }` with a
`Retry-After` header.

This is the same rate-limit table added by migration `0007_rate_limits.sql`.
