# OpenPing roadmap

One checklist for everything still to do, in stages.
Tick items as they land and link the PR.
The owner's own to-dos (accounts, devices, decisions) live in [Deferred operator inputs](./DEFERRED_INPUTS.md); this list links to them instead of repeating them.
The paid hosted version has its own detailed plan with go/no-go gates in [the Hosted plan](./HOSTED_PLAN.md); stage 4 below follows it.
Last updated: 2026-10-28.

## How installs relate to each other

Every OpenPing install is its owner's own, independent setup: its own Cloudflare account, Worker, database, monitors and status pages.
Installs never talk to each other, and nobody, including us, can see anyone else's install.
openping.n8builds.dev is simply the owner's install, which also hosts the project's marketing page.
The only shared things are the source code on GitHub and, if an install chooses to link to it, the OpenPing website.

## Stage 1: solid and honest (now)

- [x] Off-hours monitors show "Scheduled off", never "operational" (#15).
- [x] One strict security header policy on every page; the widget embeds on n8builds.dev (#16).
- [x] Idle scheduler runs take 3 database calls instead of about 160 (#17).
- [x] Repeatable releases and production deploys (`deploy:prod`, release-kit, CI on every PR) (#14, #16).
- [x] Missing files return 404, a real robots.txt, readable widget footer, wide-screen header (#21).
- [x] Plan for the landing page, Hosted and sign-in ([LANDING_AND_LOGIN_PLAN.md](./LANDING_AND_LOGIN_PLAN.md)) (#22).
- [x] MCP server at `/mcp` and a full admin CLI, so Claude and scripts can run OpenPing (#24).
- [x] Safe `MASTER_KEY` rotation (two keys during a re-encryption pass, then a verified switch) (#25).
- [ ] Back up the production `MASTER_KEY` or set a fresh one ([owner to-do 1](./DEFERRED_INPUTS.md)).
- [x] Landing page shows both paths (free in your own Cloudflare, or Hosted), honest waitlist, owner-only sign-in in the footer, click counts (plan section 6, items 1.0 to 1.8).
- [x] Other people's installs show their own status page at `/`, not OpenPing's marketing page (plan item 1.9, `HOME_PAGE` setting).
- [x] Sweep the remaining em dashes out of code comments (#32).
- [x] Dependency upkeep: release-kit 2.0.1, `@cloudflare/vitest-pool-workers` renamed to `@cloudflare/vitest-plugin` (#32).

## Stage 2: close the feature gaps that matter

Competitors checked on 2026-10-28 (see section 5 of the landing plan).
OpenPing already has HTTP with keyword and JSON assertions, heartbeat (cron), DNS, TCP port and domain-expiry monitors, slow-response "degraded" thresholds, maintenance windows, incidents with public notes and CSV export, many status pages, an embeddable widget and badge, email, Slack, Microsoft Teams, Discord, Telegram, signed webhooks and web push alerts, a weekly summary email, and free tools.
These are the gaps a buyer is likely to notice, most valuable first:

- [x] **Slack, Telegram and Microsoft Teams alerts** (S each) (#29).
  Native channels with setup help, a test button, encrypted capabilities and provider rate-limit handling ([Alert channels](./ALERT_CHANNELS.md)).
- [x] **Confirm before alerting** (M, overlaps Hosted stage 2) (#31).
  A failure is re-checked once, 5 seconds later, before it opens an incident, so one bad request doesn't page anyone; "Confirm failures" per monitor, on by default.
  The re-check runs from the same Cloudflare location; a second-location check (a Durable Object with a location hint) stays in Hosted stage 2.
- [ ] **Second-region confirmation** (M, Hosted stage 2, built, waiting on measurement).
  The re-check runs from a Durable Object in another region, and the incident says where ("Confirmed from Frankfurt") ([Second-region confirmation](./SECOND_REGION.md)).
- [ ] **SSL certificate expiry monitor** (M, spike and measurement done).
  UptimeRobot, StatusCake and HetrixTools warn before a certificate expires.
  A Worker's `fetch()` doesn't expose the certificate; a TLS 1.2 handshake over a plain TCP socket can read it, except for Cloudflare-proxied and TLS 1.3-only hosts.
  Measured 2026-10-28 on a deployed Worker: 78% of 160 hosts readable, 21% behind Cloudflare (including every Render app), 1% TLS 1.3 only.
  Next: build the monitor type, with "behind Cloudflare, can't be checked" as a neutral state ([SSL_EXPIRY_SPIKE.md](./SSL_EXPIRY_SPIKE.md)).
- [x] **Incident updates on the status page** (M) (#30).
  A timeline of posts ("Investigating", "Identified", "Fixed") instead of a single message, as Instatus and Better Stack show.
- [x] **Status page feeds** (S): RSS and Atom for incidents, so people can follow a page without an account (#30).
- [ ] **Status page email subscribers** (M, double opt-in, unsubscribe links, sending limits).
  Do this after the feeds, and only if people ask.
- [x] **Monthly uptime report** (S): a CSV and an email per monitor, for SLAs and clients (#30).
- [x] Notify channels when an incident update is posted: a new `incident_update` alert with the status and message, on by default and switchable per update ([Alert channels](./ALERT_CHANNELS.md#incident-updates)).
- [x] **Passkeys for the admin sign-in** (M, landing plan item 2.1), which makes the GitHub OAuth app optional (2.2) (#34).
  Created in the setup wizard or Settings > Passkeys, usernameless sign-in with autofill, recovery with a new `SETUP_TOKEN` at `/recover`; verified with Web Crypto, no dependency ([SECURITY.md](./SECURITY.md#passkeys)).
- [x] **"Deploy to Cloudflare" button** (M spike, plan items 2.3 and 2.4), to cut the 20-minute install (#33); the owner's one-time click test is in [DEFERRED_INPUTS.md](./DEFERRED_INPUTS.md).
  Built in #33: the button on the README and `/install`, a deploy that creates the database and applies migrations, and setup-page help for a missing secret.
  Left: one real click by the owner ([Deferred inputs](./DEFERRED_INPUTS.md), item 5), then the button in the landing hero.
- [x] **First check right away** when a monitor is added (S, plan item 2.5) (#31): from the editor, API, MCP and CLI, with off-hours monitors showing Scheduled off at once.

Deliberately not on the list, because others do them better and they don't fit a $24-a-year product: free hosted tiers, 30-second checks from dozens of regions, on-call rotations and phone calls, browser (Playwright) monitoring, white-label status pages as the main product, SOC 2 and SAML.
ICMP ping isn't possible from Workers; TCP and HTTP checks cover the same need.

## Stage 3: run the stage 1 waitlist test

- [ ] Watch click counts and waitlist sign-ups for 8 weeks after the landing page ships.
  Started 2026-10-28 with v0.4.0; read the counts in Settings (waitlist and landing page counts) or ask the agent.
  Decision date: about 2026-12-23.
- [ ] Gate: about 20 sign-ups.
  Under that, keep OpenPing a free self-hosted project and skip stage 4.

## Stage 4: OpenPing Hosted (started 2026-10-28)

The owner decided on 2026-10-28 to build Hosted now rather than wait for the stage 3 gate; the waitlist becomes the launch list.
The detailed, parallelized build plan is [HOSTED_BUILD_PLAN.md](./HOSTED_BUILD_PLAN.md).

Follow [the Hosted plan](./HOSTED_PLAN.md) stages 2 to 7; summary:

- [ ] Cheap fast checks and fewer false alarms (Hosted stage 2).
- [ ] One customer's OpenPing on Workers for Platforms, prototype (Hosted stage 3).
- [ ] Sign-up, provisioning and sign-in at `app.openping.n8builds.dev`: email link plus code, GitHub, then Google before launch (Hosted stage 4, landing plan section 3).
- [ ] Billing and plan limits (Hosted stage 5).
- [ ] Support, backups, export to self-host, terms and privacy (Hosted stage 6).
- [ ] Launch: the hero switches to Hosted first, self-host second (Hosted stage 7, landing plan items 7.1 to 7.4).

## Phones: installable web app and Android app (added 2026-10-28)

The plan is [MOBILE_PLAN.md](./MOBILE_PLAN.md).

- [x] M1: a first-class installable web app for every install (PNG icons, install button, offline last-known status, notification taps open the app).
- [ ] M2: OpenPing for Android in Google Play, a small native shell that opens any OpenPing (Hosted or your own), with push through Firebase; after Hosted wave 3.
- [ ] M3: iPhone store app, only if Hosted customers ask.
- [x] The mobile standard for every UI change (MOBILE_PLAN.md, "The mobile standard").

## Stage 5: a name and a domain of its own (owner, when OpenPing is solid)

- [ ] Pick a name; check it isn't taken by another monitoring product or trademark, and that the npm name, GitHub name and a domain are free.
- [ ] Buy the domain and add it to Cloudflare.
- [ ] Move the marketing site and, if it exists by then, Hosted to the new domain; keep openping.n8builds.dev redirecting.
- [ ] Rename the repository and the Worker, and update the README, docs and the widget's "Powered by" link.
