# MCP server

OpenPing has a built-in [Model Context Protocol](https://modelcontextprotocol.io) server at `/mcp`.
With it, Claude Code, Claude Desktop or any other MCP client can read your install's status and manage monitors, maintenance windows and status pages for you.
It runs inside the same Worker as the rest of OpenPing, needs no extra Cloudflare resources, and works on the Workers Free plan.

## How it works

- Transport: MCP Streamable HTTP, stateless.
  Every request is a single `POST` answered with one JSON body.
  There are no sessions, no server-sent event streams and no Durable Objects.
- Protocol revisions: 2025 clients (the `initialize` handshake, for example `2025-06-18`) and 2026-07-28 clients are both served from the same URL.
- SDK: the official MCP TypeScript SDK, `@modelcontextprotocol/server`.
- Every tool runs the same validation and data functions as the REST API, so a monitor created over MCP is validated exactly like one created in the web editor.
- Times in tool results are ISO 8601 in the timezone set under Settings (UTC if none is set).
- Each tool returns a short text summary for the model plus the same data as structured JSON.

## Turn it on

The MCP server uses the admin API token, the same one the [CLI](./CLI.md) uses.
Until `API_TOKEN` is set, `/mcp` answers `404` with a message saying so.

```sh
openssl rand -base64 32 | npx wrangler secret put API_TOKEN
```

Keep the value in a password manager.
It grants full admin access to your install, through the REST API and through MCP.
To revoke it, set a new value with the same command; old clients then get `401`.

## Connect Claude Code

```sh
export OPENPING_TOKEN="<your API_TOKEN>"
claude mcp add --transport http openping https://<your-install>/mcp \
  --header "Authorization: Bearer $OPENPING_TOKEN"
```

Run `/mcp` inside Claude Code to check that `openping` is connected, then ask something like "what is the status of my OpenPing?".
Add `--scope user` to make the server available in every project, or `--scope project` to share the entry (without the token) through `.mcp.json`.
With project scope, write the header as `"Authorization": "Bearer ${OPENPING_TOKEN}"` in `.mcp.json` so the token itself stays in your environment and out of the repository.

## Connect other clients

Any client that supports remote MCP servers over Streamable HTTP with a custom header works.
Use these settings:

- URL: `https://<your-install>/mcp`
- Transport: Streamable HTTP (sometimes labelled "HTTP")
- Header: `Authorization: Bearer <your API_TOKEN>`

Claude Desktop reads local servers from its config file.
To reach a remote server with a header, use the `mcp-remote` bridge:

```json
{
  "mcpServers": {
    "openping": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://<your-install>/mcp",
        "--header",
        "Authorization:${AUTH_HEADER}"
      ],
      "env": { "AUTH_HEADER": "Bearer <your API_TOKEN>" }
    }
  }
}
```

Keeping the header in `env` avoids a space inside an argument, which some platforms split.

OpenPing does not offer OAuth sign-in, so a client that cannot send a custom header (such as a custom connector added on the claude.ai website) cannot connect to it.

To try the server by hand, the MCP Inspector has a command-line mode:

```sh
npx @modelcontextprotocol/inspector --cli https://<your-install>/mcp \
  --transport http --header "Authorization: Bearer $OPENPING_TOKEN" \
  --method tools/call --tool-name get_status
```

## Tools

Read-only tools (annotated `readOnlyHint`):

| Tool | What it returns |
| --- | --- |
| `get_status` | Overall state, every monitor's state, last check, latency and 24h uptime, open incidents, the last scheduler run. |
| `list_monitors` | Every monitor with id, type, target, schedule and current state; filter by `type`. |
| `get_monitor` | One monitor's full configuration and current state, with secrets blanked. |
| `list_incidents` | Incidents, newest first, each with its status updates and whether it is public; filter by `status` (open, resolved, all), `monitorId`, `since`, `limit`. |
| `get_uptime` | Uptime per monitor over 24h, 7d, 30d and 90d from the rollups; optional `monitorId`. |
| `get_monthly_report` | One calendar month's [uptime report](./STATUS_PAGES.md#monthly-uptime-report) per monitor (uptime, downtime and monitored minutes, incidents, average response) in the install's timezone; `month` (YYYY-MM) defaults to last month. |
| `get_diagnostics` | Recent scheduler runs (checked, skipped, failures, duration, D1 queries) and table counts. |
| `get_key_status` | `MASTER_KEY` rotation status: key ids, protected values per storage class by key, unreadable values by location, and whether `MASTER_KEY_PREVIOUS` is safe to delete ([runbook](./SECURITY.md#rotating-master_key)). |
| `list_channels` | Notification channels and their delivery health, with webhook URLs and secrets blanked. |
| `list_status_pages` | Status pages with slug, URL, enabled flag and which monitors they show. |
| `list_categories` | Monitor categories. |
| `list_maintenance` | Maintenance windows marked active, upcoming or ended; filter by `status`. |

Tools that change things:

| Tool | What it does |
| --- | --- |
| `create_monitor` | Creates an http, heartbeat, dns, tcp or domain monitor. A heartbeat's ping URL is in the result, and only there. |
| `update_monitor` | Changes only the fields you pass. `config` and `public` are merged key by key (a config key set to `null` is removed); `schedule`, `notify` and `assertions` are replaced whole. Stored credentials are kept unless new ones are sent. The type cannot change. |
| `pause_monitor`, `resume_monitor` | Pauses or resumes checks and alerts. |
| `create_maintenance_window` | Schedules maintenance from `startsAt` (ISO 8601 or `now`) with `endsAt` or `durationMinutes`, for every monitor or a list of them, optionally weekly. |
| `end_maintenance_window` | Ends an active window now; a weekly window also stops recurring. |
| `update_status_page` | Changes only the fields you pass; `null` clears an optional text field. |
| `post_incident_update` | Posts a status update (`investigating`, `identified`, `monitoring` or `resolved`, with a message) to an incident's public timeline. It shows publicly only while the incident is public, and it never opens or closes the incident. |

Destructive tools (annotated `destructiveHint`) do nothing unless called with `confirm: true`.
Their descriptions tell the model to set it only after you have agreed, and without it they return an error asking for confirmation:

| Tool | What it does |
| --- | --- |
| `delete_monitor` | Deletes a monitor with its history, incidents and queued alerts. |
| `delete_maintenance_window` | Deletes a maintenance window, for example one that has not started yet. |
| `rotate_heartbeat_token` | Gives a heartbeat monitor a new ping URL, shown once; the old URL stops working. |

The same operations are available in the terminal through the [CLI](./CLI.md) and over REST, including `PATCH /api/monitors/:id`, `PATCH /api/status-pages/:id`, `GET /api/monitors/uptime`, `POST /api/maintenance/:id/end`, `POST /api/incidents/:id/updates` and `GET /api/reports/monthly`.

## Security

- Only `Authorization: Bearer <API_TOKEN>` is accepted, compared in constant time with the same check as the REST API.
  Session cookies are never accepted on `/mcp`.
- A request with a browser `Origin` header from another site is refused with `403`, and `/mcp` never sends CORS headers, so a web page cannot use your browser to reach it.
- Tool results never contain credentials: HTTP auth passwords and tokens, custom header values and request bodies are blanked, as are heartbeat shared secrets, webhook URLs and webhook secrets.
  This is stricter than the REST API, which returns header values to the signed-in editor, because tool results are sent to your model provider.
- A heartbeat ping URL is returned only by `create_monitor` and `rotate_heartbeat_token`, like the REST API returns the token only on create and rotate.
  It cannot be read back later.
- Monitor names, target URLs (including query strings), incident errors and notes do appear in results and so reach the model provider.
  Do not put secrets in a monitor's URL.
- Requests are limited to 256 KB, and an install accepts at most 120 authenticated MCP requests a minute; more get `429` with `Retry-After`.
  Every request is a Worker invocation and counts toward the plan's daily request allowance.
- Unauthenticated requests never touch D1, so a flood of bad requests cannot use up your database quota.
- `/mcp` is listed in `robots.txt` as disallowed.

See [SECURITY.md](./SECURITY.md) for the full secret and storage inventory.
