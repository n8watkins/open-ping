# Upgrading OpenPing

OpenPing upgrades are a code pull plus (sometimes) a database migration and a
redeploy. Because everything runs in your own Cloudflare account, you control
when you upgrade.

## Before you start

**Take a backup.** Upgrades are designed to be safe and migrations are additive,
but a backup costs nothing and protects you. See [`BACKUP.md`](./BACKUP.md):

- Use the in-app export (**Settings/Integrations → Export**, or
  `GET /api/data/export`) for a portable JSON backup of your monitors,
  maintenance windows, and public incident history.
- Optionally take a full database dump with
  `npx wrangler d1 export open-ping --remote --output backup.sql`.

## Steps

```bash
git pull                 # get the latest code
npm install              # install any new/updated dependencies
npm run db:migrate       # apply any new migrations to remote D1
npm run deploy           # build + wrangler deploy
```

That's the whole process. Notes:

- **`git pull`** - if you have local changes, stash or commit them first.
- **`npm install`** - picks up dependency changes from the new `package-lock.json`.
- **`npm run db:migrate`** - runs `wrangler d1 migrations apply open-ping
  --remote`. Migrations are **additive and tracked by Wrangler**, so only
  migrations you haven't applied yet will run; re-running is a no-op when
  nothing is pending. (For a local dev database, use `npm run db:migrate:local`.)
- **`npm run deploy`** - runs `vite build && wrangler deploy`, publishing the
  new Worker and SPA assets. The Cron Trigger (`*/12 * * * *`) is reapplied
  from `wrangler.jsonc` automatically.

## After upgrading

- Open the app and confirm you can sign in and see your monitors.
- Check **Integrations** for any channel health warnings.
- If checks don't seem to resume, see
  [Troubleshooting → Checks aren't running](./TROUBLESHOOTING.md).

## Secrets and config

Upgrades **do not** touch your Worker secrets or your `wrangler.jsonc`
`database_id` - those persist across deploys. If a release introduces a new
secret, it will be listed in the release notes and added to
[`.dev.vars.example`](../.dev.vars.example) and the `Env` interface in
`src/worker/types.ts`; set it with `npx wrangler secret put <NAME>` before (or
right after) deploying.

## Rolling back

If something goes wrong, you can redeploy a previous commit:

```bash
git checkout <previous-tag-or-commit>
npm install
npm run deploy
```

Because migrations are additive (they only add schema, they don't drop it),
older code generally runs fine against a newer database. If a restore of data
is needed, import your JSON backup (see [`BACKUP.md`](./BACKUP.md)).
