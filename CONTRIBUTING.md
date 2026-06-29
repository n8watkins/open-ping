# Contributing to OpenPing

Thanks for your interest in improving OpenPing! It's an open-source,
self-hosted uptime monitor that runs entirely inside your own Cloudflare
account (Worker + D1 + a static SPA). Contributions of all sizes are welcome —
bug reports, docs, tests, and features.

## Ways to contribute

- **Report a bug.** Open an issue with steps to reproduce, what you expected,
  and what happened. Include your Wrangler/Node versions and any relevant
  Worker logs (`wrangler tail`).
- **Suggest a feature.** Open an issue describing the use case before writing a
  large change, so we can agree on the approach.
- **Send a pull request.** Small, focused PRs are easiest to review.

## Development setup

Prerequisites: **Node 20+** and a Cloudflare account (for remote testing;
local dev works without one).

```bash
git clone https://github.com/<your-fork>/open-ping.git
cd open-ping
npm install
cp .dev.vars.example .dev.vars   # then fill in values (see below)
npm run db:migrate:local         # apply migrations to the local D1 database
npm run dev                      # Vite + workerd dev server at http://localhost:5173
```

Fill in `.dev.vars` with at least a `MASTER_KEY` and `SESSION_SECRET`
(`openssl rand -base64 32` for each) and one admin identity
(`ADMIN_GITHUB_LOGIN` or `ADMIN_EMAIL`). See
[`docs/INSTALL.md`](./docs/INSTALL.md) for the full list and a from-scratch
deploy walkthrough.

## Useful scripts

All scripts come from `package.json`:

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite + workerd dev server (`http://localhost:5173`) |
| `npm run build` | Production build (client + worker) |
| `npm run deploy` | Build, then `wrangler deploy` |
| `npm run typecheck` | `tsc -b` across project references |
| `npm run test` | Run the Vitest suite once |
| `npm run test:watch` | Vitest in watch mode |
| `npm run cf-typegen` | Regenerate Worker types from `wrangler.jsonc` |
| `npm run db:create` | Create the `open-ping` D1 database |
| `npm run db:migrate:local` | Apply migrations to the local D1 database |
| `npm run db:migrate` | Apply migrations to the remote D1 database |

## Before you open a PR

Please make sure the following pass locally:

```bash
npm run typecheck
npm run test
npm run build
```

Guidelines:

- **Keep changes focused.** One logical change per PR where possible.
- **Add or update tests** for behavior changes. The codebase favors small pure
  functions (e.g. SSRF checks, import validation, export redaction) so they can
  be unit-tested without a live D1 binding — follow that pattern.
- **Database changes are additive migrations.** Add a new numbered file in
  `migrations/` (e.g. `0002_*.sql`); never edit an applied migration. Migrations
  are tracked by Wrangler, so existing installs upgrade cleanly with
  `npm run db:migrate`.
- **Never commit secrets.** `.dev.vars`, `.env*`, and `*.local` are gitignored.
  Use `.dev.vars.example` to document any new secret you introduce, and add it
  to `src/worker/types.ts` (the `Env` interface).
- **Match the existing style.** TypeScript, ESM, Hono on the worker, React +
  Tailwind on the client. Let `tsc` and the existing formatting guide you.

## Security

OpenPing handles credentials (OAuth secrets, encrypted monitor auth, push
keys). If you find a security issue, please **do not** open a public issue —
report it privately to the maintainers first. Note that the outbound HTTP
checker intentionally blocks loopback/private/metadata targets (SSRF guard);
that behavior is by design, not a bug.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](./LICENSE).
