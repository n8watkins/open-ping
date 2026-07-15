# OpenPing

Open-source, self-hosted **uptime monitoring and public status pages** that run
entirely inside your own Cloudflare account - no central service, no operational
database to manage, no monitoring subscription.

Its defining feature is **schedule-aware monitoring**: applications are checked
(and optionally kept awake) only during the hours that matter. Outside those
hours they show as `Scheduled off` rather than `Down`, and the inactive period
does not reduce uptime.

> Status: **V1 shipped and running live at
> [openping.n8builds.dev](https://openping.n8builds.dev).** It has since grown
> beyond core uptime checks - monitor categories and multiple public status
> pages, five monitor types, a free `/tools` suite, an embeddable widget/badge,
> and a marketing landing page (all listed below). Hardened by multiple review
> passes plus a live-deploy verification round that fixed several real production
> bugs (see [`CODE_REVIEW.md`](./CODE_REVIEW.md)); the test suite, `tsc -b`, and
> `vite build` are clean. See [`BUILD_PLAN.md`](./BUILD_PLAN.md) for the build
> history.

## What it does

- HTTP/API monitoring with keyword & JSON assertions
- Heartbeat / cron-job monitoring
- DNS record monitoring (A/AAAA/CNAME/MX/TXT) with optional value assertions
- TCP port monitoring (connection-accepted checks)
- Domain-expiry monitoring (RDAP) with an early-warning window
- Timezone-aware operating schedules with warm-up handling
- Distinct **Suspended** status for hosts that signal suspension (e.g. Render free-tier)
- Incidents with automatic recovery, flapping protection, MTBF/MTTR
- Compact historical uptime (samples → intervals → hourly → daily → monthly)
- Mobile Web Push (installable Android PWA), email via Resend, Discord, signed webhooks
- GitHub OAuth + email magic-link auth (single administrator)
- Monitor **categories** and **multiple public status pages** (a default page at `/status`, per-category pages at `/status/:slug`), each polished and configurable
- An **embeddable status widget** (`<iframe>`) plus an **SVG status badge** for READMEs and dashboards
- A free **`/tools` suite** (uptime & subnet calculators, cron tester, DNS/MX lookup, and an **"Is it down?" checker**)
- A marketing **landing page** at `/` for signed-out visitors
- Admin **CLI** (`scripts/op.mjs`) + opt-in Bearer API-token auth for scripting/automation
- Data import/export and transparent Cloudflare usage estimates

## Tech stack

- **Frontend:** React + TypeScript + Vite + Tailwind CSS v4 (PWA)
- **Backend:** Cloudflare Worker (Hono router, Zod), scheduled handler every 12 min
- **Storage:** Cloudflare D1 + Worker secrets
- **External:** GitHub OAuth · Resend · Web Push · Discord

## Local development

```bash
npm install
npm run dev        # vite + workerd dev server at http://localhost:5173
```

Useful scripts:

```bash
npm run typecheck  # tsc project references
npm run build      # production build (client + worker)
npm run test       # Node unit tests plus workerd/D1 route integration tests
```

## Deploy your own

OpenPing runs entirely in **your own Cloudflare account** and deploys in a few
minutes. The outline:

1. `npm run db:create`, then copy the printed `database_id` into `wrangler.jsonc`.
2. Configure GitHub OAuth and/or email magic-link sign-in, then generate a `MASTER_KEY`.
3. Set Worker secrets (`MASTER_KEY`, `SETUP_TOKEN`, `APP_URL`, admin identity, GitHub OAuth, optionally Resend).
4. `npm run db:migrate` to apply migrations, then `npm run deploy`.
5. Open the app, unlock the first-run wizard with `SETUP_TOKEN`, finish setup, and add monitors.

**Follow the full, copy-pasteable walkthrough in
[docs/INSTALL.md](./docs/INSTALL.md)** - it covers the GitHub OAuth app, every
secret, custom domains, and a verify-it's-working checklist.

## Documentation

- [Install](./docs/INSTALL.md) - from clone to a deployed install (plus a local-dev quickstart)
- [Monitor types](./docs/MONITOR_TYPES.md) - every check type, its config, and what the runtime can't do
- [Status pages](./docs/STATUS_PAGES.md) - categories and multiple per-category public status pages
- [Status widget & badge](./docs/WIDGET.md) - embed the live status widget or an SVG badge on another site
- [Free tools](./docs/TOOLS.md) - the public `/tools` suite and the "Is it down?" API
- [CLI](./docs/CLI.md) - manage an instance from a terminal/automation via an API token
- [Upgrade](./docs/UPGRADE.md) - pull, migrate, redeploy
- [Backup & restore](./docs/BACKUP.md) - JSON export/import and full D1 dumps
- [Security & secret storage](./docs/SECURITY.md) - encryption, hashing, plaintext metadata, legacy upgrades, and backup boundaries
- [Custom domain](./docs/CUSTOM_DOMAIN.md) - put OpenPing on your own hostname
- [Free tier](./docs/FREE_TIER.md) - how usage maps to Cloudflare's free plan
- [Troubleshooting](./docs/TROUBLESHOOTING.md) - common issues and fixes
- [Contributing](./CONTRIBUTING.md) - dev setup and PR guidelines

## License

[MIT](./LICENSE)
