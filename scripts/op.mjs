#!/usr/bin/env node
/**
 * OpenPing admin CLI.
 *
 * Authenticates with a Bearer API token (the Worker's API_TOKEN secret), so it
 * never needs a browser session. Config comes from the environment:
 *
 *   OPENPING_URL    base URL, e.g. https://open-ping.<subdomain>.workers.dev
 *   OPENPING_TOKEN  the API token (must equal the Worker's API_TOKEN secret)
 *
 * Usage:
 *   node scripts/op.mjs monitors list
 *   node scripts/op.mjs monitors create --name NAME --url URL \
 *        [--schedule business|always] [--tz ZONE] [--days 1,2,3,4,5] \
 *        [--start 08:00] [--end 17:00]
 *   node scripts/op.mjs monitors delete <id>
 */

const BASE = (process.env.OPENPING_URL || "").replace(/\/$/, "");
const TOKEN = process.env.OPENPING_TOKEN || "";

function die(msg) {
  console.error(msg);
  process.exit(1);
}
if (!BASE) die("Set OPENPING_URL (e.g. https://open-ping.<subdomain>.workers.dev)");
if (!TOKEN) die("Set OPENPING_TOKEN (the Worker's API_TOKEN secret)");

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) {
    die(
      `${method} ${path} -> ${res.status}\n` +
        (typeof data === "string" ? data : JSON.stringify(data, null, 2)),
    );
  }
  return data;
}

// --- parse: <group> <action> [positionals] [--flags] ---
const argv = process.argv.slice(2);
const group = argv[0];
const action = argv[1];
const positionals = [];
const flags = {};
for (let i = 2; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = "true";
    } else {
      flags[key] = next;
      i++;
    }
  } else {
    positionals.push(a);
  }
}

function buildSchedule() {
  const mode = flags.schedule || "business";
  if (mode === "always") return { mode: "always" };
  return {
    mode: "business_hours",
    weekdays: (flags.days || "1,2,3,4,5").split(",").map((n) => Number(n.trim())),
    start: flags.start || "08:00",
    end: flags.end || "17:00",
    timezone: flags.tz || "UTC",
  };
}

const USAGE = `OpenPing CLI
  op monitors list
  op monitors create --name NAME --url URL [--schedule business|always]
                     [--tz ZONE] [--days 1,2,3,4,5] [--start 08:00] [--end 17:00]
  op monitors delete <id>`;

async function main() {
  if (group === "monitors" && action === "list") {
    const { monitors = [] } = await api("/api/monitors");
    if (!monitors.length) return console.log("(no monitors)");
    for (const m of monitors) {
      console.log(
        `${m.id}\t${m.type}\t${m.enabled ? "on " : "off"}\t${m.name}\t${m.config?.url ?? ""}`,
      );
    }
    return;
  }

  if (group === "monitors" && action === "create") {
    if (!flags.name || !flags.url) {
      die("Usage: op monitors create --name NAME --url URL [...]\n\n" + USAGE);
    }
    const { monitor } = await api("/api/monitors", {
      method: "POST",
      body: {
        type: "http",
        name: flags.name,
        schedule: buildSchedule(),
        config: { url: flags.url },
      },
    });
    console.log(`✓ created ${monitor.id}  ${monitor.name}`);
    return;
  }

  if (group === "monitors" && (action === "delete" || action === "rm")) {
    const id = positionals[0] || flags.id;
    if (!id) die("Usage: op monitors delete <id>");
    await api(`/api/monitors/${id}`, { method: "DELETE" });
    console.log(`✓ deleted ${id}`);
    return;
  }

  console.log(USAGE);
  process.exit(group ? 1 : 0);
}

main();
