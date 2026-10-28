# Spike: an SSL certificate expiry monitor

Status: research done and measured on a deployed Worker 2026-10-28, no monitor type shipped yet.
Roadmap item: stage 2, "SSL certificate expiry monitor" ([ROADMAP.md](./ROADMAP.md)).

## The question

UptimeRobot, StatusCake and HetrixTools warn days before a site's certificate expires.
OpenPing runs on Cloudflare Workers, and a Worker's `fetch()` never shows the certificate it was served.
So the question is where else a Worker can learn a certificate's expiry date, reliably, for free, and within each source's terms.

## Short answer

There is a source that is free, needs no third party and breaks no terms: read the certificate straight from the server with a TLS 1.2 handshake over a raw TCP socket.
A prototype of it works against real sites (below), but two gaps keep it from shipping in this PR.
Workers can't open TCP sockets to Cloudflare's own IP ranges, so it can't see the certificate of any site proxied by Cloudflare, which is a large share of the sites OpenPing users run.
And it can only be measured on Cloudflare's network, not in local development, so its real coverage is unknown until it runs on a deployed Worker.

Recommendation: build the "SSL certificate" monitor type on the TLS 1.2 handshake as its own PR, after a one-day measurement on a throwaway deployed Worker, and show a clear "can't be checked from Workers" state for Cloudflare-proxied hosts rather than a wrong answer.
Certificate Transparency services are not a good primary source for a self-hosted install: the free ones are rate-limited, unreliable or for evaluation only, and they show certificates that were issued, not the one the server actually serves.

## Sources considered

### Workers `fetch()`

`fetch()` returns status, headers and body only.
A certificate problem shows up as a failed request (OpenPing already reports it as `tls_error`), so an HTTP monitor goes down when a certificate has expired, but there is no way to warn before that.
The `cf` object on a request (`request.cf`) describes the incoming visitor's TLS connection, not the outbound one.
Source: [Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/), checked 2026-10-28.

### TCP sockets: `connect()` with `secureTransport: "on"` or `startTls()`

`connect()` from `cloudflare:sockets` can do TLS itself (`secureTransport: "on"`, or `"starttls"` and then `startTls()`).
The socket it returns exposes `readable`, `writable`, `closed` and `opened`, and `opened` resolves to `SocketInfo` with only `remoteAddress` and `localAddress`.
There is no peer certificate, no expiry date and no TLS version on it.
A TLS socket does refuse an invalid or expired certificate, so it could tell "valid now" from "invalid now", which an HTTP monitor already does.
Source: [TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/), checked 2026-10-28.

### TCP sockets: a TLS 1.2 handshake done by hand (the promising one)

With `secureTransport: "off"` a Worker gets a plain TCP socket and can write the first TLS message itself.
If the ClientHello offers only TLS 1.2, a server that supports TLS 1.2 answers with ServerHello and then its Certificate message, and in TLS 1.2 that message is not encrypted ([RFC 5246 section 7.4.2](https://www.rfc-editor.org/rfc/rfc5246#section-7.4.2)).
In TLS 1.3 the certificate is encrypted ([RFC 8446 section 4.4.2](https://www.rfc-editor.org/rfc/rfc8446#section-4.4.2)), which is why the hello must not offer 1.3.
No key exchange, no cryptography and no library is needed: the Worker reads the leaf certificate's `notAfter` from its DER encoding and closes the socket before the handshake finishes.

Prototype, 2026-10-28: about 120 lines of JavaScript (ClientHello with SNI, record and handshake framing, a minimal DER walk to `notAfter`), run with Node's `net` socket standing in for `connect()`.
Results against real hosts, each matching `openssl s_client` where compared:

| Host | Result |
| --- | --- |
| github.com | notAfter 2026-11-29T23:59:59Z (openssl agrees) |
| www.google.com | notAfter 2026-12-30T19:09:53Z |
| letsencrypt.org | notAfter 2026-12-03T14:34:31Z (openssl agrees) |
| example.com | notAfter 2026-12-25T22:56:35Z |
| www.wikipedia.org | notAfter 2027-01-02T18:34:50Z |
| render.com | notAfter 2026-12-18T09:19:05Z |
| tls13.1d.pw (TLS 1.3 only) | alert 70, protocol_version: detected cleanly |

Limits found:

- **Cloudflare-proxied sites can't be reached.**
  "Outbound TCP sockets to Cloudflare IP ranges are blocked."
  A hostname behind Cloudflare's proxy resolves to those ranges, so the probe fails for it.
  Its edge certificate is managed and renewed by Cloudflare, so the risk there is lower, but the monitor must say it can't check such a host instead of reporting a date.
  Source: [TCP sockets, Considerations](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/), checked 2026-10-28.
- **TLS 1.3-only servers can't be read.**
  They answer the 1.2-only hello with a protocol_version alert, which the probe recognises, so the monitor can report "TLS 1.3 only, expiry not readable" instead of failing silently.
  Almost every public site still accepts TLS 1.2; servers that refuse it are rare today, but the share will grow.
- **It only shows what one Cloudflare location is served.**
  Behind a load balancer or a CDN, different edges can serve different certificates; HTTP checks have the same limitation.
- **Cost:** one `connect()` per check and a few kilobytes read.
  A TCP socket counts toward the six simultaneous connections a Worker may have waiting, like a `fetch()`, and the scheduler budgets it like the existing TCP monitor.
  Source: [Workers limits, simultaneous open connections](https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections), checked 2026-10-28.
- **Terms:** it connects only to the user's own server on port 443, like any HTTPS client; no third-party service is involved.
- **Not verifiable locally.**
  `wrangler dev` runs `connect()` from the developer's machine, so neither the Cloudflare-IP block nor the egress behaviour of the real network applies there.

### Certificate Transparency: crt.sh

crt.sh (run by Sectigo) has an unofficial JSON output (`https://crt.sh/?q=example.com&output=json`).
It has no published API or terms for automated use.
In June 2023 its operators said the web interface was limited to 5 requests a minute per IP address and that it was frequently overloaded, and users have reported 502 and timeout errors for years.
All Cloudflare Workers share egress addresses, so a per-IP limit would be shared with everyone else's Workers.
Sources: [crt.sh group, "Rate limits", 2023](https://groups.google.com/g/crtsh/c/QXQFoy331pE), [crt.sh group, 502 errors](https://groups.google.com/g/crtsh/c/V16OrB494d4), checked 2026-10-28.

### Certificate Transparency: SSLMate Cert Spotter API

`GET https://api.certspotter.com/v1/issuances?domain=...` lists unexpired certificates for a domain with `not_after`.
Unauthenticated queries are allowed only "for personal or evaluation purposes" with an unstated hourly limit; production use needs an API key, and SSLMate may change the free tier at any time.
SSLMate's CT search pricing lists a free plan of 100 single-hostname queries an hour with a key.
It shows certificates that were logged, not the one being served: a renewed certificate that was never installed looks fine.
It could be an optional, bring-your-own-key fallback for Cloudflare-proxied hosts, not the default.
Sources: [Cert Spotter API v1 reference](https://sslmate.com/help/reference/ct_search_api_v1), [CT search API pricing](https://sslmate.com/pricing/ct_search_api), checked 2026-10-28.

### Cloudflare's CT tooling

Cloudflare Radar's Certificate Transparency API gives issuance statistics, CA and log details, not a lookup by domain.
Cloudflare's CT monitoring for a zone (SSL/TLS > Certificate Transparency Monitoring) emails the zone owner about new certificates; it has no expiry API for arbitrary hosts.
Sources: [Radar CT insights changelog, 2025-08-06](https://developers.cloudflare.com/changelog/post/2025-08-04-radar-ct-insights/), checked 2026-10-28.

### Other services (SSL Labs and similar)

Full TLS scanners such as Qualys SSL Labs need registration, are slow (a scan takes minutes) and restrict automated and commercial use.
Paying for a certificate API breaks OpenPing's "runs free on your own account" promise.

## Measurement on Cloudflare's network (2026-10-28)

The probe ran from a throwaway Worker (`openping-probe-tmp`, deleted afterwards) against 160 hosts: popular sites across categories, the owner's own apps, and test hosts.
Requests were served from several Cloudflare locations (MAN, MRS, LAX, YYZ).

| Result | Hosts | Share |
| --- | --- | --- |
| Expiry read | 125 | 78% |
| Blocked: the host is behind Cloudflare's proxy | 34 | 21% |
| TLS 1.3 only (alert 70, recognised) | 1 | 1% |

- **Accuracy:** five hosts checked against `openssl s_client` (n8builds.dev, wikipedia.org, vercel.com, python.org, nytimes.com) matched to the second, and `expired.badssl.com` read its real 2015 expiry.
- **No hello was refused:** every host that wasn't behind Cloudflare answered the hand-written TLS 1.2 hello with its certificate, except the one TLS 1.3-only test host.
- **The Cloudflare block is a clear error:** `connect()` fails at once with "proxy request failed, cannot connect to the specified address", so the monitor can show "behind Cloudflare, can't be checked" reliably.
- **Render apps are behind Cloudflare:** all three of the owner's monitored apps (on `onrender.com`), openping.n8builds.dev itself, and render.com, railway.app, openai.com and similar were blocked.
  Their certificates are issued and renewed automatically by the platform, so the risk the monitor covers is lowest exactly where it can't see.
- **Vercel and most self-managed hosts work:** n8builds.dev (Vercel), github.com, wikipedia.org and the major news, university and government sites were read.

What this means for the monitor: it is worth building for people who run their own servers or certificates (the case where expiry actually bites), and it must present the Cloudflare-proxied case as a neutral, non-alerting "can't be checked from Workers" state, since about a fifth of hosts, and every Render app, land there.

## Recommendation

1. Next PR: a `cert` monitor type built on the TLS 1.2 handshake probe.
   Config: host, port (default 443), warn days (default 14).
   States: up with the expiry date and days left in the sample meta (like the domain monitor), degraded inside the warning window, down when expired or when the handshake fails.
   Two explicit, non-alerting results: "behind Cloudflare, can't be checked from Workers" and "TLS 1.3 only".
   Check once a day per monitor, not every 12 minutes: expiry changes slowly, and it keeps the budget for HTTP checks.
2. Done 2026-10-28: the measurement above (78% readable, 21% behind Cloudflare, 1% TLS 1.3 only, no refused hellos).
3. Optional later: let a user add a Cert Spotter API key to cover Cloudflare-proxied hosts through CT, clearly labelled as "issued", not "served".
