#!/usr/bin/env node
/**
 * OpenPing admin CLI (zero dependencies, Node 20+).
 *
 * Talks to an install's REST API with the admin API token, so it never needs a
 * browser session. Configuration, highest precedence first:
 *
 *   OPENPING_URL / OPENPING_TOKEN environment variables
 *   a gitignored .op.env file (KEY=value lines) in the current directory,
 *   or else in the repository root
 *
 * Run `node scripts/op.mjs --help` for the commands. docs/CLI.md has examples.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** A mistake in how the CLI was called (exit code 2, prints usage hints). */
export class UsageError extends Error {}

const MONITOR_TYPES = ["http", "heartbeat", "dns", "tcp", "domain", "cert"];
const UPDATE_STATUSES = ["investigating", "identified", "monitoring", "resolved"];
const UPDATE_LABELS = { investigating: "Investigating", identified: "Identified", monitoring: "Monitoring", resolved: "Resolved" };

// ---------------------------------------------------------------------------
// Command table. Each command lists its positional arguments and flags; the
// parser rejects anything else, so a typo never silently does nothing.
// Flag types: string, number, boolean, list (comma-separated), json.
// ---------------------------------------------------------------------------

const scheduleFlags = {
  schedule: { type: "string", values: ["always", "business"], help: "always (24/7) or business (the hours below)" },
  tz: { type: "string", help: "IANA timezone for business hours, e.g. America/Los_Angeles" },
  days: { type: "list", help: "Weekdays for business hours, 0=Sun..6=Sat (default 1,2,3,4,5)" },
  start: { type: "string", help: "Business hours start, HH:MM (default 08:00)" },
  end: { type: "string", help: "Business hours end, HH:MM (default 17:00)" },
};

const monitorFlags = {
  name: { type: "string", help: "Display name" },
  url: { type: "string", help: "http: URL to check" },
  method: { type: "string", help: "http: request method (default GET)" },
  "expect-status": { type: "string", help: "http: accepted status range, e.g. 200-299" },
  "timeout-ms": { type: "number", help: "Check timeout in milliseconds" },
  interval: { type: "number", help: "heartbeat: expected seconds between pings" },
  grace: { type: "number", help: "heartbeat: extra seconds before it counts as missed" },
  hostname: { type: "string", help: "dns: name to resolve" },
  record: { type: "string", help: "dns: record type (A, AAAA, CNAME, MX, TXT)" },
  host: { type: "string", help: "tcp: host to connect to; cert: host whose certificate to read" },
  port: { type: "number", help: "tcp: port; cert: port (default 443)" },
  domain: { type: "string", help: "domain: registrable domain to watch for expiry" },
  "warn-days": {
    type: "string",
    help: "domain: days before expiry to warn; cert: comma-separated warning thresholds (default 30,14,7)",
  },
  config: { type: "json", help: "Extra type-specific config as JSON, merged over the flags above" },
  ...scheduleFlags,
  public: { type: "boolean", help: "Show it on the public status page" },
  private: { type: "boolean", help: "Hide it from the public status page" },
  category: { type: "string", help: "Category id (use 'none' to clear on update)" },
  channels: { type: "list", help: "Notification channel ids, comma-separated" },
  enable: { type: "boolean", help: "Enable the monitor" },
  disable: { type: "boolean", help: "Disable the monitor" },
  confirm: {
    type: "string",
    values: ["retry", "off"],
    help: "Confirm failures: retry (default, re-check once before alerting) or off (alert on the first failure)",
  },
};

const yes = { yes: { type: "boolean", help: "Confirm; required because this cannot be undone" } };

export const COMMANDS = {
  status: {
    summary: "Overall status: every monitor's state, last check and 24h uptime, open incidents, last scheduler run",
    run: cmdStatus,
  },
  "monitors list": {
    summary: "List monitors",
    flags: { type: { type: "string", values: MONITOR_TYPES, help: "Only this monitor type" } },
    run: cmdMonitorsList,
  },
  "monitors get": {
    summary: "Show one monitor's configuration and state (credentials are never shown)",
    args: ["id"],
    run: cmdMonitorsGet,
  },
  "monitors create": {
    summary: "Create a monitor",
    flags: { type: { type: "string", values: MONITOR_TYPES, help: "Monitor type (default http)" }, ...monitorFlags },
    run: cmdMonitorsCreate,
  },
  "monitors update": {
    summary: "Change a monitor; only the flags you pass change",
    args: ["id"],
    flags: monitorFlags,
    run: cmdMonitorsUpdate,
  },
  "monitors delete": {
    summary: "Delete a monitor and all of its history (needs --yes)",
    args: ["id"],
    flags: yes,
    run: cmdMonitorsDelete,
  },
  "monitors pause": { summary: "Pause checks and alerts for a monitor", args: ["id"], run: (c) => setPaused(c, true) },
  "monitors resume": { summary: "Resume a paused monitor", args: ["id"], run: (c) => setPaused(c, false) },
  "monitors rotate-token": {
    summary: "Give a heartbeat monitor a new ping URL; the old one stops working (needs --yes)",
    args: ["id"],
    flags: yes,
    run: cmdRotateToken,
  },
  "incidents list": {
    summary: "List incidents, newest first",
    flags: {
      status: { type: "string", values: ["open", "resolved", "all"], help: "open, resolved or all (default all)" },
      monitor: { type: "string", help: "Only this monitor id" },
      since: { type: "string", help: "Only incidents started at or after this ISO 8601 time" },
      limit: { type: "number", help: "At most this many (default 20, max 500)" },
    },
    run: cmdIncidentsList,
  },
  "incidents get": {
    summary: "Show one incident with its status updates",
    args: ["id"],
    run: cmdIncidentsGet,
  },
  "incidents update": {
    summary: "Post a status update to an incident's public timeline",
    args: ["id"],
    flags: {
      status: { type: "string", values: UPDATE_STATUSES, help: "The incident's status now" },
      message: { type: "string", help: "What happened or what is being done, for the public" },
      quiet: { type: "boolean", help: "Post it without alerting the monitor's notification channels" },
    },
    run: cmdIncidentsUpdate,
  },
  report: {
    summary: "Monthly uptime report: uptime, downtime, incidents and response time per monitor",
    flags: {
      month: { type: "string", help: "YYYY-MM (default: last month, in the install's timezone)" },
      csv: { type: "boolean", help: "Print the CSV instead of a table" },
    },
    run: cmdReport,
  },
  uptime: {
    summary: "Uptime per monitor over 24h, 7d, 30d and 90d",
    flags: { monitor: { type: "string", help: "Only this monitor id" } },
    run: cmdUptime,
  },
  diagnostics: {
    summary: "Scheduler health: recent runs, D1 queries per run, table counts",
    flags: { runs: { type: "number", help: "How many recent runs to show (default 10, max 20)" } },
    run: cmdDiagnostics,
  },
  "channels list": { summary: "List notification channels and their health", run: cmdChannelsList },
  "pages list": { summary: "List status pages", run: cmdPagesList },
  "pages update": {
    summary: "Change a status page; only the flags you pass change",
    args: ["id"],
    flags: {
      name: { type: "string", help: "Page title" },
      description: { type: "string", help: "Text under the title ('' clears it)" },
      slug: { type: "string", help: "URL slug (not for the default page's /status)" },
      enable: { type: "boolean", help: "Publish the page" },
      disable: { type: "boolean", help: "Unpublish the page" },
      include: { type: "string", values: ["all", "categories", "monitors"], help: "Which monitors it shows" },
      categories: { type: "list", help: "Category ids for --include categories" },
      monitors: { type: "list", help: "Monitor ids for --include monitors" },
      theme: { type: "string", values: ["dark", "light", "system"], help: "Color theme" },
      accent: { type: "string", help: "Accent color, #rgb or #rrggbb" },
      logo: { type: "string", help: "Logo URL ('' clears it)" },
      homepage: { type: "string", help: "Homepage URL ('' clears it)" },
      footer: { type: "string", help: "Footer text ('' clears it)" },
      attribution: { type: "string", values: ["on", "off"], help: "Show the OpenPing credit" },
    },
    run: cmdPagesUpdate,
  },
  "categories list": { summary: "List monitor categories", run: cmdCategoriesList },
  "maintenance list": {
    summary: "List maintenance windows",
    flags: { status: { type: "string", values: ["active", "upcoming", "ended", "all"], help: "Filter (default all)" } },
    run: cmdMaintenanceList,
  },
  "maintenance create": {
    summary: "Schedule maintenance (alerts and incidents are suppressed while it is active)",
    flags: {
      title: { type: "string", help: "Title" },
      monitors: { type: "list", help: "Only these monitor ids (default: every monitor)" },
      start: { type: "string", help: "Start, ISO 8601 or 'now' (default now)" },
      end: { type: "string", help: "End, ISO 8601" },
      duration: { type: "number", help: "Length in minutes (instead of --end)" },
      message: { type: "string", help: "Public message on the status page" },
      notes: { type: "string", help: "Private notes" },
    },
    run: cmdMaintenanceCreate,
  },
  "maintenance end": { summary: "End an active maintenance window now", args: ["id"], run: cmdMaintenanceEnd },
  "maintenance delete": {
    summary: "Delete a maintenance window (needs --yes)",
    args: ["id"],
    flags: yes,
    run: cmdMaintenanceDelete,
  },
};

const GLOBAL_FLAGS = {
  json: { type: "boolean", help: "Print the API's JSON instead of a table" },
  help: { type: "boolean", help: "Show help" },
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse argv (without `node script`) into a command, its positional values and
 * its flags. Throws UsageError for an unknown command or flag, a missing or
 * extra argument, a missing flag value, or a value of the wrong type.
 * `--help` anywhere returns `{ help: true }` with whatever command was found.
 */
export function parseCommandLine(argv) {
  // Command words come first; global boolean flags (--json, --help) may sit
  // before them, anything else ends the command words.
  const words = [];
  const rest = [];
  let inWords = true;
  for (const a of argv) {
    if (inWords && !a.startsWith("-") && words.length < 2) words.push(a);
    else {
      if (!["--json", "--help", "-h"].includes(a)) inWords = false;
      rest.push(a);
    }
  }
  // The command is the longest prefix of the leading words that names one.
  let name = null;
  let used = 0;
  for (let n = Math.min(2, words.length); n >= 1; n--) {
    const candidate = words.slice(0, n).join(" ");
    if (COMMANDS[candidate]) {
      name = candidate;
      used = n;
      break;
    }
  }
  const tokens = [...words.slice(used), ...rest];
  const wantsHelp = tokens.includes("--help") || tokens.includes("-h");
  if (!name) {
    if (wantsHelp || words.length === 0) return { command: words[0] ?? null, help: true };
    const group = words[0];
    const known = Object.keys(COMMANDS).filter((c) => c.startsWith(`${group} `));
    if (known.length) {
      throw new UsageError(
        words[1]
          ? `Unknown command "${group} ${words[1]}". Try: ${known.map((c) => `op ${c}`).join(", ")}`
          : `"${group}" needs a subcommand: ${known.map((c) => c.split(" ")[1]).join(", ")}`,
      );
    }
    throw new UsageError(`Unknown command "${group}". Run op --help for the list.`);
  }
  if (wantsHelp) return { command: name, help: true };

  const spec = COMMANDS[name];
  const flagSpec = { ...GLOBAL_FLAGS, ...(spec.flags ?? {}) };
  const positionals = [];
  const flags = {};
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith("--")) {
      if (token.startsWith("-") && token !== "-") {
        throw new UsageError(`Unknown flag ${token} for "op ${name}". Run op ${name} --help.`);
      }
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const key = eq === -1 ? token.slice(2) : token.slice(2, eq);
    const def = flagSpec[key];
    if (!def) throw new UsageError(`Unknown flag --${key} for "op ${name}". Run op ${name} --help.`);
    if (key in flags) throw new UsageError(`--${key} was given twice.`);
    if (def.type === "boolean") {
      if (eq !== -1) throw new UsageError(`--${key} takes no value.`);
      flags[key] = true;
      continue;
    }
    let raw;
    if (eq !== -1) raw = token.slice(eq + 1);
    else {
      raw = tokens[i + 1];
      if (raw === undefined || (raw.startsWith("--") && raw.length > 2)) {
        throw new UsageError(`--${key} needs a value.`);
      }
      i++;
    }
    flags[key] = coerceFlag(key, def, raw);
  }

  const args = spec.args ?? [];
  if (positionals.length < args.length) {
    throw new UsageError(`Missing <${args[positionals.length]}>. Usage: ${usageLine(name)}`);
  }
  if (positionals.length > args.length) {
    throw new UsageError(`Unexpected argument "${positionals[args.length]}". Usage: ${usageLine(name)}`);
  }
  return { command: name, help: false, positionals, flags };
}

function coerceFlag(key, def, raw) {
  switch (def.type) {
    case "number": {
      const n = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(n)) throw new UsageError(`--${key} must be a number, got "${raw}".`);
      return n;
    }
    case "list":
      return raw.split(",").map((s) => s.trim()).filter(Boolean);
    case "json":
      try {
        const v = JSON.parse(raw);
        if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
        return v;
      } catch {
        throw new UsageError(`--${key} must be a JSON object, e.g. '{"followRedirects":false}'.`);
      }
    default:
      if (def.values && !def.values.includes(raw)) {
        throw new UsageError(`--${key} must be one of ${def.values.join(", ")}; got "${raw}".`);
      }
      return raw;
  }
}

function usageLine(name) {
  const spec = COMMANDS[name];
  const args = (spec.args ?? []).map((a) => `<${a}>`).join(" ");
  return `op ${name}${args ? ` ${args}` : ""}${spec.flags ? " [flags]" : ""}`;
}

export function helpText(command) {
  if (command && COMMANDS[command]) {
    const spec = COMMANDS[command];
    const flags = { ...(spec.flags ?? {}), ...GLOBAL_FLAGS };
    const width = Math.max(...Object.keys(flags).map((k) => k.length + 2 + (flags[k].type === "boolean" ? 0 : 6)));
    const lines = [`${spec.summary}.`, "", `Usage: ${usageLine(command)}`, "", "Flags:"];
    for (const [k, def] of Object.entries(flags)) {
      const left = `--${k}${def.type === "boolean" ? "" : " <val>"}`;
      lines.push(`  ${left.padEnd(width + 2)}${def.help}${def.values ? ` (${def.values.join("|")})` : ""}`);
    }
    return lines.join("\n");
  }
  const group = command && Object.keys(COMMANDS).filter((c) => c.startsWith(`${command} `));
  const names = group && group.length ? group : Object.keys(COMMANDS);
  const width = Math.max(...names.map((n) => usageLine(n).length));
  return [
    "OpenPing admin CLI",
    "",
    "Usage: op <command> [args] [flags]   (node scripts/op.mjs, or npm run op --)",
    "",
    "Commands:",
    ...names.map((n) => `  ${usageLine(n).padEnd(width + 2)}${COMMANDS[n].summary}`),
    "",
    "Global flags: --json (machine output), --help (per-command help, e.g. op monitors create --help)",
    "Config: OPENPING_URL and OPENPING_TOKEN, from the environment or a gitignored .op.env file.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Parse KEY=value lines (optional `export`, quotes, # comments). */
export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    let value = m[2];
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    out[m[1]] = value;
  }
  return out;
}

/**
 * OPENPING_URL and OPENPING_TOKEN: the environment wins, then .op.env in the
 * current directory, then .op.env in the repository root.
 */
export function loadConfig({ env = process.env, cwd = process.cwd(), readFile = readFileSync } = {}) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let file = {};
  for (const dir of [...new Set([cwd, repoRoot])]) {
    try {
      file = parseEnvFile(readFile(join(dir, ".op.env"), "utf8"));
      break;
    } catch {
      // No file here; try the next place.
    }
  }
  const url = (env.OPENPING_URL || file.OPENPING_URL || "").replace(/\/+$/, "");
  const token = env.OPENPING_TOKEN || file.OPENPING_TOKEN || "";
  return { url, token };
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, "0");

/** Local "YYYY-MM-DD HH:MM" for epoch ms; "-" for none. */
export function fmtTime(ms) {
  if (ms == null) return "-";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtPct(w) {
  return w && w.checks > 0 ? `${Number(w.uptimePct.toFixed(2))}%` : "-";
}

/** A plain-text table; `columns` is [header, row => value][]. */
export function table(rows, columns) {
  const cells = rows.map((r) => columns.map(([, get]) => String(get(r) ?? "-")));
  const widths = columns.map(([h], i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (vals) => vals.map((v, i) => (i === vals.length - 1 ? v : v.padEnd(widths[i]))).join("  ").trimEnd();
  return [line(columns.map(([h]) => h)), ...cells.map(line)].join("\n");
}

function monitorTarget(m) {
  const c = m.config ?? {};
  switch (m.type) {
    case "http":
      try {
        const u = new URL(c.url);
        return `${u.origin}${u.pathname}`;
      } catch {
        return c.url ?? "";
      }
    case "dns":
      return `${c.hostname} ${c.recordType ?? ""}`.trim();
    case "tcp":
      return `${c.host}:${c.port}`;
    case "domain":
      return c.domain;
    case "cert":
      return c.port && c.port !== 443 ? `${c.host}:${c.port}` : c.host;
    default:
      return "";
  }
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Weekday numbers as names, runs of three or more collapsed: [1,2,3,4,5] -> "Mon-Fri". */
export function weekdayText(days) {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    if (j - i >= 2) parts.push(`${DAY_NAMES[sorted[i]]}-${DAY_NAMES[sorted[j]]}`);
    else for (let k = i; k <= j; k++) parts.push(DAY_NAMES[sorted[k]]);
    i = j + 1;
  }
  return parts.join(",");
}

function scheduleText(s) {
  if (!s || s.mode === "always") return "24/7";
  if (s.mode === "business_hours") return `${weekdayText(s.weekdays)} ${s.start}-${s.end} ${s.timezone}`;
  return `custom ${s.timezone}`;
}

// ---------------------------------------------------------------------------
// Commands. Each gets { api, out, flags, positionals, config } and returns
// nothing; failures throw.
// ---------------------------------------------------------------------------

async function cmdStatus({ api, out, flags }) {
  const [overview, open] = await Promise.all([api("/api/overview"), api("/api/incidents?status=open&limit=20")]);
  if (flags.json) return out.json({ ...overview, openIncidents: open.incidents });
  const counts = overview.counts;
  const order = ["down", "suspended", "degraded", "maintenance", "warming_up", "up", "scheduled_off", "paused", "unknown"];
  const summary = order.filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${s.replace("_", " ")}`).join(", ");
  out.line(
    overview.monitors.length
      ? `${summary} (${overview.monitors.length} monitors), ${counts.openIncidents} open incident(s)`
      : "No monitors yet. Add one with op monitors create.",
  );
  if (overview.monitors.length) {
    out.line("");
    out.line(
      table(overview.monitors, [
        ["STATE", (m) => m.state],
        ["NAME", (m) => m.name],
        ["ID", (m) => m.id],
        ["TYPE", (m) => m.type],
        ["LAST CHECK", (m) => fmtTime(m.lastCheckedAt)],
        ["MS", (m) => m.lastDurationMs],
        ["24H", (m) => (m.lastCheckedAt == null ? "-" : `${Number(m.uptime24h.toFixed(2))}%`)],
        ["TARGET", (m) => m.target ?? ""],
      ]),
    );
  }
  if (open.incidents.length) {
    out.line("");
    out.line("Open incidents:");
    for (const i of open.incidents) {
      out.line(`  ${i.id}  ${i.monitorName ?? i.monitorId}  since ${fmtTime(i.startedAt)}${i.error ? `  ${i.error}` : ""}`);
    }
  }
  const run = overview.lastRun;
  out.line("");
  out.line(
    run
      ? `Last scheduler run ${fmtTime(run.startedAt)}: ${run.ok ? "ok" : "FAILED"}, ${run.monitorsChecked ?? 0} checked, ${run.checkFailures ?? 0} check failures, ${run.durationMs ?? "?"} ms`
      : "No scheduler run recorded yet.",
  );
}

async function cmdMonitorsList({ api, out, flags }) {
  const { monitors } = await api("/api/monitors");
  const list = monitors.filter((m) => !flags.type || m.type === flags.type);
  if (flags.json) return out.json({ monitors: list });
  if (!list.length) return out.line("No monitors.");
  out.line(
    table(list, [
      ["ID", (m) => m.id],
      ["TYPE", (m) => m.type],
      ["STATUS", (m) => (m.paused ? "paused" : m.enabled ? "on" : "off")],
      ["NAME", (m) => m.name],
      ["SCHEDULE", (m) => scheduleText(m.schedule)],
      ["TARGET", (m) => monitorTarget(m)],
    ]),
  );
}

async function cmdMonitorsGet({ api, out, flags, positionals: [id] }) {
  const detail = await api(`/api/monitors/${encodeURIComponent(id)}/detail`);
  if (flags.json) return out.json(detail);
  const m = detail.monitor;
  const s = detail.state ?? {};
  out.line(`${m.name}  (${m.id})`);
  out.line(`  type       ${m.type}${m.paused ? ", paused" : ""}${m.enabled ? "" : ", disabled"}`);
  out.line(`  target     ${monitorTarget(m) || "-"}`);
  out.line(`  schedule   ${scheduleText(m.schedule)}`);
  out.line(`  state      ${s.state ?? "unknown"} since ${fmtTime(s.state_since)}`);
  out.line(`  last check ${fmtTime(s.last_checked_at)}${s.last_duration_ms != null ? `, ${s.last_duration_ms} ms` : ""}${s.last_status_code != null ? `, HTTP ${s.last_status_code}` : ""}`);
  if (s.last_error) out.line(`  last error ${s.last_error}`);
  // null: a window with no counted checks (off hours, warm-up only, Can't check).
  const up = (v) => (v == null ? "-" : fmtPct({ uptimePct: v, checks: 1 }));
  out.line(
    s.last_checked_at == null
      ? "  uptime     no checks yet"
      : `  uptime     24h ${up(detail.uptime.d1)}, 7d ${up(detail.uptime.d7)}, 30d ${up(detail.uptime.d30)}`,
  );
  out.line(`  public     ${m.public?.visible ? "visible" : "hidden"}`);
  out.line(`  config     ${JSON.stringify(m.config)}`);
}

/** Build a schedule from --schedule/--tz/--days/--start/--end, or null if none given. */
export function scheduleFromFlags(flags, current) {
  const touched = ["schedule", "tz", "days", "start", "end"].some((k) => k in flags);
  if (!touched) return null;
  const mode = flags.schedule ?? (current?.mode === "business_hours" ? "business" : undefined);
  if (mode === "always") {
    if (["tz", "days", "start", "end"].some((k) => k in flags)) {
      throw new UsageError("--tz, --days, --start and --end only apply to --schedule business.");
    }
    return { mode: "always" };
  }
  if (mode !== "business") {
    throw new UsageError("Pass --schedule business to set business hours on this monitor.");
  }
  const base = current?.mode === "business_hours" ? current : {};
  const days = flags.days ? flags.days.map(Number) : (base.weekdays ?? [1, 2, 3, 4, 5]);
  if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new UsageError("--days are 0 (Sunday) to 6 (Saturday).");
  return {
    mode: "business_hours",
    weekdays: days,
    start: flags.start ?? base.start ?? "08:00",
    end: flags.end ?? base.end ?? "17:00",
    timezone: flags.tz ?? base.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
  };
}

/** Type-specific config keys from the flags (only the ones given). */
export function configFromFlags(type, flags) {
  const config = {};
  const set = (key, value) => {
    if (value !== undefined) config[key] = value;
  };
  const wrongType = (flag, forTypes) => {
    if (flag in flags && !forTypes.includes(type)) {
      throw new UsageError(`--${flag} is for ${forTypes.join(" or ")} monitors, not ${type}.`);
    }
  };
  for (const [flag, ...forTypes] of [
    ["url", "http"], ["method", "http"], ["expect-status", "http"], ["interval", "heartbeat"], ["grace", "heartbeat"],
    ["hostname", "dns"], ["record", "dns"], ["host", "tcp", "cert"], ["port", "tcp", "cert"], ["domain", "domain"],
    ["warn-days", "domain", "cert"],
  ]) wrongType(flag, forTypes);
  set("url", flags.url);
  set("method", flags.method?.toUpperCase());
  if (flags["expect-status"] !== undefined) {
    const m = /^(\d{3})(?:-(\d{3}))?$/.exec(flags["expect-status"]);
    if (!m) throw new UsageError("--expect-status is a code or range, e.g. 200 or 200-299.");
    config.expectedStatus = { min: Number(m[1]), max: Number(m[2] ?? m[1]) };
  }
  set("timeoutMs", flags["timeout-ms"]);
  set("intervalSeconds", flags.interval);
  set("graceSeconds", flags.grace);
  set("hostname", flags.hostname);
  set("recordType", flags.record?.toUpperCase());
  set("host", flags.host);
  set("port", flags.port);
  set("domain", flags.domain);
  if (flags["warn-days"] !== undefined) {
    const days = String(flags["warn-days"]).split(",").map((d) => d.trim()).filter(Boolean).map(Number);
    if (!days.length || days.some((d) => !Number.isInteger(d) || d < 1)) {
      throw new UsageError("--warn-days is a whole number of days, or for cert monitors a list such as 30,14,7.");
    }
    if (type === "domain" && days.length > 1) throw new UsageError("--warn-days for a domain monitor is one number.");
    config.warnDays = type === "cert" ? days : days[0];
  }
  return { ...config, ...(flags.config ?? {}) };
}

/** One line on a new monitor's first check, or null when there is nothing to say. */
export function firstCheckLine(r) {
  if (!r) return null;
  switch (r.status) {
    case "checked":
      return r.ok
        ? `First check: ${r.state}${r.durationMs != null ? ` (${r.durationMs} ms)` : ""}`
        : `First check failed: ${r.error ?? "check_failed"}${r.errorMessage ? ` (${r.errorMessage})` : ""}. It shows warming up; the next run checks again and alerts if it still fails.`;
    case "scheduled_off":
      return "Outside its schedule now: shows scheduled off until its hours start.";
    case "maintenance":
      return "In a maintenance window now: shows maintenance.";
    case "running":
      return "First check still running; op monitors get shows the result in a few seconds.";
    default:
      return null;
  }
}

/** The monitor fields other than config and schedule, from flags. */
function commonFromFlags(flags) {
  if (flags.public && flags.private) throw new UsageError("Pass --public or --private, not both.");
  if (flags.enable && flags.disable) throw new UsageError("Pass --enable or --disable, not both.");
  const body = {};
  if (flags.name !== undefined) body.name = flags.name;
  if (flags.public || flags.private) body.public = { visible: !!flags.public };
  if (flags.category !== undefined) body.categoryId = flags.category === "none" ? null : flags.category;
  if (flags.channels !== undefined) body.notify = { channels: flags.channels };
  if (flags.enable || flags.disable) body.enabled = !!flags.enable;
  if (flags.confirm !== undefined) body.confirmFailures = flags.confirm;
  return body;
}

async function cmdMonitorsCreate({ api, out, flags, config }) {
  const type = flags.type ?? "http";
  if (!flags.name) throw new UsageError("--name is required.");
  const body = { type, ...commonFromFlags(flags), config: configFromFlags(type, flags) };
  const schedule = scheduleFromFlags(flags, null);
  if (schedule) body.schedule = schedule;
  const { monitor, firstCheck } = await api("/api/monitors", { method: "POST", body });
  if (flags.json) return out.json({ monitor, firstCheck: firstCheck ?? null });
  out.line(`Created ${monitor.type} monitor ${monitor.id}  ${monitor.name}  (${scheduleText(monitor.schedule)})`);
  const first = firstCheckLine(firstCheck);
  if (first) out.line(first);
  if (monitor.heartbeatToken) {
    out.line(`Ping URL (shown only now, store it securely): ${config.url}/hb/${monitor.heartbeatToken}`);
  }
}

async function cmdMonitorsUpdate({ api, out, flags, positionals: [id] }) {
  const path = `/api/monitors/${encodeURIComponent(id)}`;
  const body = { ...commonFromFlags(flags) };
  // The current monitor gives the type (to check type-specific flags) and the
  // business hours that --tz, --days, --start and --end adjust.
  const { monitor: current } = await api(path);
  const cfg = configFromFlags(current.type, flags);
  if (Object.keys(cfg).length) body.config = cfg;
  const schedule = scheduleFromFlags(flags, current.schedule);
  if (schedule) body.schedule = schedule;
  if (!Object.keys(body).length) throw new UsageError("Nothing to change. Run op monitors update --help for the flags.");
  const { monitor } = await api(path, { method: "PATCH", body });
  if (flags.json) return out.json({ monitor });
  out.line(`Updated ${monitor.id}  ${monitor.name}`);
}

async function cmdMonitorsDelete({ api, out, flags, positionals: [id] }) {
  if (!flags.yes) throw new UsageError(`Deleting ${id} removes its history for good. Add --yes to confirm.`);
  const result = await api(`/api/monitors/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (flags.json) return out.json(result);
  out.line(`Deleted ${id}`);
}

async function setPaused({ api, out, flags, positionals: [id] }, paused) {
  const { monitor } = await api(`/api/monitors/${encodeURIComponent(id)}/${paused ? "pause" : "resume"}`, { method: "POST" });
  if (flags.json) return out.json({ monitor });
  out.line(`${paused ? "Paused" : "Resumed"} ${monitor.id}  ${monitor.name}`);
}

async function cmdRotateToken({ api, out, flags, config, positionals: [id] }) {
  if (!flags.yes) throw new UsageError("The current ping URL stops working at once. Add --yes to confirm.");
  const result = await api(`/api/monitors/${encodeURIComponent(id)}/rotate-heartbeat-token`, { method: "POST" });
  if (flags.json) return out.json(result);
  out.line(`New ping URL (shown only now, store it securely): ${config.url}/hb/${result.heartbeatToken}`);
}

async function cmdIncidentsList({ api, out, flags }) {
  const q = new URLSearchParams({ limit: String(flags.limit ?? 20) });
  if (flags.status && flags.status !== "all") q.set("status", flags.status);
  if (flags.monitor) q.set("monitorId", flags.monitor);
  if (flags.since) {
    const ms = Date.parse(flags.since);
    if (!Number.isFinite(ms)) throw new UsageError(`--since must be an ISO 8601 time, got "${flags.since}".`);
    q.set("from", String(ms));
  }
  const page = await api(`/api/incidents?${q}`);
  if (flags.json) return out.json(page);
  if (!page.incidents.length) return out.line("No incidents.");
  out.line(
    table(page.incidents, [
      ["ID", (i) => i.id],
      ["STATUS", (i) => i.status],
      ["MONITOR", (i) => i.monitorName ?? i.monitorId],
      ["STARTED", (i) => fmtTime(i.startedAt)],
      ["RESOLVED", (i) => fmtTime(i.resolvedAt)],
      ["ERROR", (i) => (i.httpStatus ? `HTTP ${i.httpStatus} ` : "") + (i.error ?? "")],
    ]),
  );
  if (page.total > page.incidents.length) out.line(`(${page.incidents.length} of ${page.total}; use --limit)`);
}

async function cmdIncidentsGet({ api, out, flags, positionals: [id] }) {
  const data = await api(`/api/incidents/${encodeURIComponent(id)}`);
  if (flags.json) return out.json(data);
  const i = data.incident;
  out.line(`${i.id}  ${i.status}  ${i.monitorName ?? i.monitorId}${i.public ? "  (public)" : ""}`);
  out.line(`  started    ${fmtTime(i.startedAt)}`);
  out.line(`  resolved   ${fmtTime(i.resolvedAt)}`);
  if (i.publicMessage) out.line(`  summary    ${i.publicMessage}`);
  if (!data.updates?.length) return out.line("  No status updates yet.");
  out.line("  Updates (newest first):");
  for (const u of data.updates) out.line(`  ${fmtTime(u.postedAt)}  ${UPDATE_LABELS[u.status] ?? u.status}: ${u.message}`);
}

async function cmdIncidentsUpdate({ api, out, flags, positionals: [id] }) {
  if (!flags.status) throw new UsageError(`--status is required: ${UPDATE_STATUSES.join(", ")}.`);
  if (!flags.message || !flags.message.trim()) throw new UsageError("--message is required.");
  const result = await api(`/api/incidents/${encodeURIComponent(id)}/updates`, {
    method: "POST",
    body: { status: flags.status, message: flags.message, ...(flags.quiet ? { notify: false } : {}) },
  });
  if (flags.json) return out.json(result);
  out.line(`Posted "${UPDATE_LABELS[result.update.status]}" to ${id} at ${fmtTime(result.update.postedAt)} (${result.update.id})`);
  out.line(`  ${alertsLine(Boolean(flags.quiet), result.alertsQueued ?? 0, result.alertsError)}`);
}

/** What happened to an update's alerts, in one line. */
function alertsLine(quiet, queued, error) {
  if (quiet) return "No alerts sent (--quiet).";
  if (error) return "Posted, but its alerts could not be queued.";
  if (queued === 0) return "No notification channel takes incident updates for this monitor.";
  return `Alerting ${queued} channel${queued === 1 ? "" : "s"} with the next check run (within 12 minutes).`;
}

async function cmdReport({ api, out, flags }) {
  if (flags.month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(flags.month)) {
    throw new UsageError(`--month must be YYYY-MM, got "${flags.month}".`);
  }
  if (flags.csv && flags.json) throw new UsageError("Use --csv or --json, not both.");
  const q = new URLSearchParams({ format: flags.csv ? "csv" : "json" });
  if (flags.month) q.set("month", flags.month);
  const data = await api(`/api/reports/monthly?${q}`, { raw: flags.csv });
  if (flags.csv) return out.raw(data);
  if (flags.json) return out.json(data);
  const r = data.report;
  const pct = (v) => (v == null ? "-" : `${Number(v.toFixed(3))}%`);
  out.line(`Uptime report for ${r.month} (${r.timezone})${r.partial ? ", so far" : ""}`);
  out.line("");
  if (!r.monitors.length) return out.line("No monitors.");
  const total = { name: "All monitors", id: "", ...r.totals };
  out.line(
    table([...r.monitors, total], [
      ["NAME", (m) => m.name],
      ["ID", (m) => m.id],
      ["UPTIME", (m) => pct(m.uptimePct)],
      ["DOWN MIN", (m) => m.downtimeMinutes],
      ["MONITORED MIN", (m) => m.monitoredMinutes],
      ["INCIDENTS", (m) => m.incidents],
      ["AVG MS", (m) => m.avgResponseMs],
    ]),
  );
}

async function cmdUptime({ api, out, flags }) {
  const data = await api("/api/monitors/uptime");
  const monitors = data.monitors.filter((m) => !flags.monitor || m.id === flags.monitor);
  if (flags.monitor && !monitors.length) throw new Error(`No monitor ${flags.monitor}.`);
  if (flags.json) return out.json({ ...data, monitors });
  if (!monitors.length) return out.line("No monitors.");
  out.line(
    table(monitors, [
      ["NAME", (m) => m.name],
      ["ID", (m) => m.id],
      ["24H", (m) => fmtPct(m.d1)],
      ["7D", (m) => fmtPct(m.d7)],
      ["30D", (m) => fmtPct(m.d30)],
      ["90D", (m) => fmtPct(m.d90)],
    ]),
  );
}

async function cmdDiagnostics({ api, out, flags }) {
  const d = await api("/api/diagnostics");
  const runs = d.recentRuns.slice(0, Math.max(1, Math.min(20, flags.runs ?? 10)));
  if (flags.json) return out.json({ ...d, recentRuns: runs });
  const c = d.counts;
  out.line(`Database ${d.dbOk ? "ok" : "UNREACHABLE"}; ${c.monitors} monitors (${c.monitorsEnabled} enabled), ${c.incidentsOpen} open incidents, outbox ${c.outboxPending} pending / ${c.outboxDead} dead`);
  if (!runs.length) return out.line("No scheduler runs yet.");
  out.line("");
  out.line(
    table(runs, [
      ["STARTED", (r) => fmtTime(r.startedAt)],
      ["OK", (r) => (r.ok ? "ok" : r.ok === 0 ? "FAIL" : "...")],
      ["CHECKED", (r) => r.monitorsChecked],
      ["SKIPPED", (r) => r.monitorsSkipped],
      ["FAILURES", (r) => r.checkFailures],
      ["MS", (r) => r.durationMs],
      ["D1 QUERIES", (r) => r.d1Queries],
      ["ERROR", (r) => r.error ?? ""],
    ]),
  );
}

async function cmdChannelsList({ api, out, flags }) {
  const { channels } = await api("/api/channels");
  if (flags.json) return out.json({ channels });
  if (!channels.length) return out.line("No notification channels.");
  out.line(
    table(channels, [
      ["ID", (ch) => ch.id],
      ["TYPE", (ch) => ch.type],
      ["NAME", (ch) => ch.name ?? ""],
      ["ENABLED", (ch) => (ch.enabled ? "yes" : "no")],
      ["LAST OK", (ch) => fmtTime(ch.lastSuccessAt)],
      ["LAST FAILURE", (ch) => (ch.lastFailureAt ? `${fmtTime(ch.lastFailureAt)} ${ch.lastError ?? ""}` : "-")],
    ]),
  );
}

async function cmdPagesList({ api, out, flags, config }) {
  const { statusPages } = await api("/api/status-pages");
  if (flags.json) return out.json({ statusPages });
  if (!statusPages.length) return out.line("No status pages.");
  out.line(
    table(statusPages, [
      ["ID", (p) => p.id],
      ["NAME", (p) => p.name],
      ["ENABLED", (p) => (p.enabled ? "yes" : "no")],
      ["SHOWS", (p) => p.includeMode],
      ["URL", (p) => `${config.url}/status${p.isDefault ? "" : `/${p.slug}`}`],
    ]),
  );
}

async function cmdPagesUpdate({ api, out, flags, positionals: [id] }) {
  if (flags.enable && flags.disable) throw new UsageError("Pass --enable or --disable, not both.");
  const body = {};
  for (const key of ["name", "slug", "theme", "accent"]) if (flags[key] !== undefined) body[key] = flags[key];
  for (const key of ["description", "logo", "homepage", "footer"]) {
    if (flags[key] !== undefined) body[key] = flags[key] === "" ? null : flags[key];
  }
  if (flags.include !== undefined) body.includeMode = flags.include;
  if (flags.categories !== undefined) body.categoryIds = flags.categories;
  if (flags.monitors !== undefined) body.monitorIds = flags.monitors;
  if (flags.enable || flags.disable) body.enabled = !!flags.enable;
  if (flags.attribution !== undefined) body.attribution = flags.attribution === "on";
  if (!Object.keys(body).length) throw new UsageError("Nothing to change. Run op pages update --help for the flags.");
  const { statusPage } = await api(`/api/status-pages/${encodeURIComponent(id)}`, { method: "PATCH", body });
  if (flags.json) return out.json({ statusPage });
  out.line(`Updated status page ${statusPage.id}  ${statusPage.name}`);
}

async function cmdCategoriesList({ api, out, flags }) {
  const { categories } = await api("/api/categories");
  if (flags.json) return out.json({ categories });
  if (!categories.length) return out.line("No categories.");
  out.line(table(categories, [["ID", (c) => c.id], ["NAME", (c) => c.name], ["SLUG", (c) => c.slug]]));
}

/** active / upcoming / ended, as the MCP list_maintenance tool reports it. */
export function maintenanceStatus(w, now = Date.now()) {
  if (now >= w.endsAt) return "ended";
  if (!w.recurrence) return now >= w.startsAt ? "active" : "upcoming";
  if (now < w.startsAt) return "upcoming";
  const r = w.recurrence;
  const d = new Date(now);
  const nowMin = d.getUTCDay() * 1440 + d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  const [h, m] = r.start.split(":").map(Number);
  const offset = (((nowMin - (r.weekday * 1440 + h * 60 + m)) % 10080) + 10080) % 10080;
  return offset < r.durationMinutes ? "active" : "upcoming";
}

async function cmdMaintenanceList({ api, out, flags }) {
  const { windows } = await api("/api/maintenance");
  const list = windows
    .map((w) => ({ ...w, status: maintenanceStatus(w) }))
    .filter((w) => !flags.status || flags.status === "all" || w.status === flags.status);
  if (flags.json) return out.json({ windows: list });
  if (!list.length) return out.line("No maintenance windows.");
  out.line(
    table(list, [
      ["ID", (w) => w.id],
      ["STATUS", (w) => w.status],
      ["TITLE", (w) => w.title ?? "Maintenance"],
      ["SCOPE", (w) => (w.scope === "global" ? "all monitors" : w.monitorIds.join(","))],
      ["STARTS", (w) => fmtTime(w.startsAt)],
      ["ENDS", (w) => fmtTime(w.endsAt)],
      ["REPEATS", (w) => (w.recurrence ? `weekly d${w.recurrence.weekday} ${w.recurrence.start} UTC ${w.recurrence.durationMinutes}m` : "")],
    ]),
  );
}

async function cmdMaintenanceCreate({ api, out, flags }) {
  const now = Date.now();
  const parse = (flag, value) => {
    if (value === "now") return now;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) throw new UsageError(`--${flag} must be an ISO 8601 time or "now", got "${value}".`);
    return ms;
  };
  const startsAt = parse("start", flags.start ?? "now");
  if ((flags.end === undefined) === (flags.duration === undefined)) {
    throw new UsageError("Pass exactly one of --end or --duration.");
  }
  const endsAt = flags.end !== undefined ? parse("end", flags.end) : startsAt + flags.duration * 60_000;
  const body = {
    scope: flags.monitors ? "monitors" : "global",
    startsAt,
    endsAt,
    ...(flags.monitors ? { monitorIds: flags.monitors } : {}),
    ...(flags.title !== undefined ? { title: flags.title } : {}),
    ...(flags.message !== undefined ? { publicMessage: flags.message } : {}),
    ...(flags.notes !== undefined ? { privateNotes: flags.notes } : {}),
  };
  const { window } = await api("/api/maintenance", { method: "POST", body });
  if (flags.json) return out.json({ window });
  out.line(`Created maintenance window ${window.id}  ${fmtTime(window.startsAt)} to ${fmtTime(window.endsAt)}`);
}

async function cmdMaintenanceEnd({ api, out, flags, positionals: [id] }) {
  const result = await api(`/api/maintenance/${encodeURIComponent(id)}/end`, { method: "POST" });
  if (flags.json) return out.json(result);
  out.line(
    result.outcome === "ended"
      ? `Ended maintenance window ${id} at ${fmtTime(result.window.endsAt)}`
      : `Maintenance window ${id} had already ended at ${fmtTime(result.window.endsAt)}; nothing changed`,
  );
}

async function cmdMaintenanceDelete({ api, out, flags, positionals: [id] }) {
  if (!flags.yes) throw new UsageError(`Add --yes to delete maintenance window ${id}.`);
  const result = await api(`/api/maintenance/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (flags.json) return out.json(result);
  out.line(`Deleted maintenance window ${id}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Describe a failed API response in one or two readable lines. */
function apiErrorMessage(method, path, status, data) {
  const head = `${method} ${path} failed: HTTP ${status}`;
  if (data && typeof data === "object") {
    const issues = Array.isArray(data.issues)
      ? data.issues.slice(0, 8).map((i) => `${(i.path ?? []).join(".") || "(body)"}: ${i.message}`).join("; ")
      : "";
    // A plan limit (OpenPing Hosted, HTTP 402) says where to upgrade.
    const upgrade = typeof data.upgradeUrl === "string" ? `\n  Upgrade: ${data.upgradeUrl}` : "";
    return `${head} ${data.error ?? ""}${data.message ? ` - ${data.message}` : ""}${issues ? `\n  ${issues}` : ""}${upgrade}`.trimEnd();
  }
  return `${head}${data ? `\n  ${String(data).slice(0, 300)}` : ""}`;
}

/**
 * Run the CLI. Returns the exit code: 0 ok, 1 runtime or API error, 2 usage
 * error. `io` lets tests swap the environment, fetch and output streams.
 */
export async function run(argv, io = {}) {
  const stdout = io.stdout ?? ((s) => process.stdout.write(s));
  const stderr = io.stderr ?? ((s) => process.stderr.write(s));
  const fetchImpl = io.fetch ?? globalThis.fetch;
  let parsed;
  try {
    parsed = parseCommandLine(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    stderr(`${err.message}\n`);
    return 2;
  }
  if (parsed.help) {
    stdout(`${helpText(parsed.command)}\n`);
    return 0;
  }

  const config = loadConfig(io);
  if (!config.url || !config.token) {
    stderr(
      `${!config.url ? "OPENPING_URL" : "OPENPING_TOKEN"} is not set. Export OPENPING_URL (your install's URL) and OPENPING_TOKEN (its API_TOKEN secret), or put them in a gitignored .op.env file.\n`,
    );
    return 1;
  }

  const api = async (path, { method = "GET", body, raw = false } = {}) => {
    let res;
    try {
      res = await fetchImpl(`${config.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${config.token}`,
          accept: raw ? "*/*" : "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new Error(`Could not reach ${config.url}: ${err.cause?.message ?? err.message}`, { cause: err });
    }
    const text = await res.text();
    if (raw && res.ok) return text;
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const hint = res.status === 401 ? "\n  Check OPENPING_TOKEN: it must equal the Worker's API_TOKEN secret." : "";
      throw new Error(apiErrorMessage(method, path, res.status, data) + hint);
    }
    return data;
  };
  const out = {
    line: (s) => stdout(`${s}\n`),
    json: (v) => stdout(`${JSON.stringify(v, null, 2)}\n`),
    raw: (s) => stdout(s),
  };

  try {
    await COMMANDS[parsed.command].run({ api, out, config, flags: parsed.flags, positionals: parsed.positionals });
    return 0;
  } catch (err) {
    stderr(`${err.message}\n`);
    return err instanceof UsageError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await run(process.argv.slice(2));
}
