# OpenPing CLI

A small admin CLI (`scripts/op.mjs`) for managing an OpenPing instance from a
terminal or automation — no browser session required.

## Authentication

The CLI authenticates with a **Bearer API token** instead of a login session.
Set a high-entropy token as the `API_TOKEN` Worker secret:

```sh
openssl rand -base64 32 | npx wrangler secret put API_TOKEN
npx wrangler deploy   # API_TOKEN takes effect on the next deploy
```

When `API_TOKEN` is set, any request with `Authorization: Bearer <API_TOKEN>` is
treated as the admin. Because a Bearer header is not sent ambiently by browsers,
there is **no CSRF surface**, so the CLI path intentionally skips the cookie/CSRF
checks the browser uses. The token grants full admin API access — treat it like a
password, keep it out of version control, and rotate it by changing the secret.

## Configuration

The CLI reads two environment variables:

```sh
export OPENPING_URL="https://open-ping.<subdomain>.workers.dev"
export OPENPING_TOKEN="<the API_TOKEN value>"
```

(Tip: keep these in a gitignored file like `.op.env` and `source` it.)

## Commands

```sh
# list monitors
node scripts/op.mjs monitors list

# create an HTTP monitor (business-hours schedule keeps Render free-tier apps
# warm only during the window, conserving the 750 free instance-hours/month)
node scripts/op.mjs monitors create \
  --name "My App" --url "https://my-app.onrender.com" \
  --schedule business --tz "America/Los_Angeles" \
  --days 1,2,3,4,5 --start 08:00 --end 17:00

# always-on (24/7) schedule
node scripts/op.mjs monitors create --name "My App" --url "https://..." --schedule always

# delete a monitor
node scripts/op.mjs monitors delete <id>
```

Everything goes through the same validated `/api/monitors` endpoints the web UI
uses (`createMonitorSchema`), so the CLI can't create invalid config.
