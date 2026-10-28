# OpenPing CLI

`scripts/op.mjs` is a small admin CLI for running an OpenPing install from a terminal or a script, with no browser session.
It has no dependencies beyond Node 20 or later, and talks to the same validated REST API as the web app.
The same operations are available to AI clients through the [MCP server](./MCP.md).

## Authentication

The CLI authenticates with a Bearer API token instead of a login session.
Set a high-entropy token as the `API_TOKEN` Worker secret:

```sh
openssl rand -base64 32 | npx wrangler secret put API_TOKEN
```

Ordinary `wrangler secret put` updates the deployed Worker directly, so no follow-up deployment is required.
Do not confuse it with `wrangler versions secret put`, which creates an undeployed Worker version.

When `API_TOKEN` is set, any request with `Authorization: Bearer <API_TOKEN>` is treated as the admin.
A browser never sends a Bearer header on its own, so there is no CSRF surface, and the token path skips the cookie and CSRF checks the browser uses.
The token grants full admin access: treat it like a password, keep it out of version control, and rotate it by setting a new value.

## Configuration

The CLI reads two settings:

- `OPENPING_URL`: your install's base URL, for example `https://open-ping.<subdomain>.workers.dev`.
- `OPENPING_TOKEN`: the `API_TOKEN` value.

Environment variables win.
Otherwise the CLI reads a `.op.env` file in the current directory, or else in the repository root:

```sh
# .op.env (gitignored)
OPENPING_URL=https://status.example.com
OPENPING_TOKEN=<the API_TOKEN value>
```

`.op.env` is in `.gitignore`; keep its permissions tight with `chmod 600 .op.env`.

## Running it

```sh
node scripts/op.mjs <command> [args] [flags]
npm run op -- <command> [args] [flags]
```

The examples below write `op` for either form.
`op --help` lists every command, and `op <command> --help` lists that command's flags.

Output is a readable table by default; add `--json` to any command for the API's JSON, for use with `jq` or other scripts.
Times in tables are in your computer's timezone.

Mistakes are errors rather than being ignored: an unknown command, an unknown or repeated flag, a missing value, a value of the wrong type or a stray argument stops the CLI with exit code 2 and makes no request.
API failures exit with code 1 and print the HTTP status and any validation messages.

## Commands

| Command | What it does |
| --- | --- |
| `op status` | Every monitor's state, last check, latency and 24h uptime, open incidents and the last scheduler run. |
| `op monitors list [--type T]` | Monitors with id, type, schedule and target. |
| `op monitors get <id>` | One monitor's configuration (credentials are never shown), state and uptime. |
| `op monitors create ...` | Creates a monitor; see below. |
| `op monitors update <id> ...` | Changes only the flags you pass. |
| `op monitors delete <id> --yes` | Deletes a monitor and all of its history. |
| `op monitors pause <id>`, `op monitors resume <id>` | Pauses or resumes checks and alerts. |
| `op monitors rotate-token <id> --yes` | Gives a heartbeat monitor a new ping URL; the old one stops working. |
| `op incidents list` | Incidents, newest first; `--status open\|resolved\|all`, `--monitor <id>`, `--since <ISO time>`, `--limit N`. |
| `op incidents get <id>` | One incident with its public summary and status updates, newest first. |
| `op incidents update <id> --status S --message "..."` | Posts a status update (`investigating`, `identified`, `monitoring` or `resolved`) to the incident's public timeline. |
| `op report [--month YYYY-MM] [--csv]` | The monthly uptime report per monitor; last month by default, the CSV with `--csv`. |
| `op uptime [--monitor <id>]` | Uptime over 24h, 7d, 30d and 90d. |
| `op diagnostics [--runs N]` | Recent scheduler runs, including D1 queries per run, and table counts. |
| `op channels list` | Notification channels and their delivery health (webhook URLs and secrets are blanked). |
| `op categories list` | Monitor categories. |
| `op pages list` | Status pages and their URLs. |
| `op pages update <id> ...` | Changes only the flags you pass. |
| `op maintenance list [--status S]` | Maintenance windows, marked active, upcoming or ended. |
| `op maintenance create ...` | Schedules maintenance; see below. |
| `op maintenance end <id>` | Ends an active window now. |
| `op maintenance delete <id> --yes` | Deletes a window, for example one that has not started yet. |

## Monitors

```sh
# An HTTP monitor checked around the clock (the default schedule)
op monitors create --name "My App" --url https://my-app.example.com/health

# Checked only during business hours: good for Render free-tier apps, which
# then stay warm only inside the window and save free instance hours
op monitors create --name "My App" --url https://my-app.onrender.com \
  --schedule business --tz America/Los_Angeles --days 1,2,3,4,5 --start 08:00 --end 17:00

# Other types
op monitors create --type heartbeat --name "Nightly backup" --interval 86400 --grace 600
op monitors create --type tcp --name "Postgres" --host db.example.com --port 5432
op monitors create --type dns --name "Apex A record" --hostname example.com --record A
op monitors create --type domain --name "Domain expiry" --domain example.com --warn-days 21
```

`--days` takes weekday numbers from 0 (Sunday) to 6 (Saturday); `--tz` defaults to your computer's timezone.
`--public` shows the monitor on the public status page, `--channels id1,id2` picks its notification channels, and `--category <id>` files it under a category.
`--config '{"followRedirects":false}'` sets any other type-specific field from [MONITOR_TYPES.md](./MONITOR_TYPES.md), merged over the flags.
Creating a heartbeat monitor prints its ping URL once; store it, because it cannot be shown again.

`op monitors update` changes only what you pass and keeps everything else, including stored credentials:

```sh
op monitors update mon_123 --url https://my-app.example.com/v2
op monitors update mon_123 --end 18:00            # adjust the existing business hours
op monitors update mon_123 --schedule always --private
op monitors update mon_123 --category none        # clear the category
```

A flag that belongs to another monitor type, such as `--port` on an HTTP monitor, is an error.

## Status pages and maintenance

```sh
op pages update sp_default --name "Acme status" --description "Live status of Acme services"
op pages update sp_default --enable --theme light --accent "#22aa88"
op pages update sp_default --homepage ""          # an empty value clears a text or URL field

op maintenance create --title "Database upgrade" --duration 45 --message "Upgrading the database"
op maintenance create --start 2026-11-02T22:00:00-08:00 --end 2026-11-02T23:00:00-08:00 --monitors mon_1,mon_2
op maintenance end mw_123
```

While a window is active, the monitors it covers show Maintenance and open no incidents or alerts.

## Incident updates and the monthly report

```sh
op incidents update inc_123 --status identified --message "A bad deploy; rolling it back."
op incidents update inc_123 --status resolved --message "Back to normal since 14:05."
op report                          # last month, in the install's timezone
op report --month 2026-10 --csv > uptime-2026-10.csv
```

An update shows on the public status page and its feeds only while the incident is public, and it never opens or closes the incident.
The report counts off-hours as neither uptime nor downtime; see [the monthly uptime report](./STATUS_PAGES.md#monthly-uptime-report).

## REST endpoints used

Everything goes through the authenticated `/api` routes the web app uses, validated with the same schemas, so the CLI cannot store an invalid configuration.
Partial updates use `PATCH /api/monitors/:id` and `PATCH /api/status-pages/:id`, which merge the change into the stored record and validate the result exactly like a full `PUT`.
`op uptime` reads `GET /api/monitors/uptime`, and `op maintenance end` calls `POST /api/maintenance/:id/end`.
`op incidents update` calls `POST /api/incidents/:id/updates`, and `op report` reads `GET /api/reports/monthly`.
