/**
 * The admin console's Operations tab (build plan, C4): the whole platform's
 * scheduler at a glance, for the owner on a phone first.
 *
 *   - the same checks as GET /__health, computed fresh (never the cached
 *     copy), with what is wrong in plain words;
 *   - right now: queue lag, tenants overdue, tenants failing, runs a minute;
 *   - runs over 15 minutes, an hour and a day: runs a minute, failures,
 *     timeouts, p95 and average duration, queue lag;
 *   - the last 24 hours by hour;
 *   - the tenants failing and the tenants overdue, worst first, ten each.
 *
 * Every read is a primary key range or a partial index of the rows in
 * trouble (src/observability/, test/observability.test.ts), so the page
 * costs the same with 20 tenants or 20,000.
 */

import type { PlatformEnv } from "../env";
import {
  COUNT_CAP,
  FAILING_STREAK,
  LAG_DEGRADED_MS,
  OVERDUE_MS,
  PLATFORM_HEALTH_ROUTE,
  configChecks,
  healthReport,
  readPlatformState,
  type HealthReport,
  type PlatformState,
} from "../observability/health";
import { runMetrics, type RunHour, type RunMetrics, type RunWindow } from "../observability/metrics";
import type { RunOutcome } from "../scheduling";
import { Html, html } from "../ui";
import { adminPage, fact, timeText } from "./pages";

const SCHEDULABLE_T = "t.provision_state = 'ready' AND t.status <> 'suspended' AND t.owner_suspended_at IS NULL";
/** How many failing and overdue tenants the page lists. */
export const OPERATIONS_LIST = 10;

/** The tenants failing now, longest streak first: the failing index, read backwards, then each tenant by key. */
export const FAILING_LIST_SQL = `SELECT s.tenant_id, t.slug, s.streak, s.last_outcome, s.last_error, s.last_at, s.last_ok_at
  FROM scheduler_stats s INDEXED BY idx_scheduler_stats_failing CROSS JOIN tenants t ON t.id = s.tenant_id
  WHERE s.streak > 0 AND ${SCHEDULABLE_T}
  ORDER BY s.streak DESC LIMIT ${OPERATIONS_LIST}`;

/**
 * The tenants waiting longest past their due time, a new tenant (due 0) from
 * when its row last changed: the late entries of the due index (at most
 * COUNT_CAP of them), then sorted by how long each has waited.
 */
export const OVERDUE_LIST_SQL = `SELECT id, slug, schedule_next_at, updated_at, schedule_lease_until FROM (
    SELECT id, slug, schedule_next_at, updated_at, schedule_lease_until FROM tenants INDEXED BY idx_tenants_schedule_due
    WHERE provision_state = 'ready' AND status <> 'suspended' AND owner_suspended_at IS NULL
      AND schedule_next_at <= ?1 AND (schedule_next_at > 0 OR updated_at <= ?1)
    LIMIT ${COUNT_CAP})
  ORDER BY CASE WHEN schedule_next_at > 0 THEN schedule_next_at ELSE updated_at END LIMIT ${OPERATIONS_LIST}`;

export interface FailingTenant {
  id: string;
  slug: string;
  streak: number;
  outcome: RunOutcome;
  error: string | null;
  lastAt: number;
  okAt: number | null;
}

export interface OverdueTenant {
  id: string;
  slug: string;
  dueAt: number;
  /** It has never run: due since it became ready. */
  firstRun: boolean;
  /** A run holds it until then (it is being run now). */
  leaseUntil: number | null;
}

export interface OperationsView {
  now: number;
  report: HealthReport;
  state: PlatformState;
  metrics: RunMetrics;
  failing: FailingTenant[];
  overdue: OverdueTenant[];
}

export async function operationsView(db: D1Database, env: PlatformEnv, now: number): Promise<OperationsView> {
  const [state, metrics, lists] = await Promise.all([
    readPlatformState(db, now),
    runMetrics(db, now),
    db.batch<Record<string, unknown>>([db.prepare(FAILING_LIST_SQL), db.prepare(OVERDUE_LIST_SQL).bind(now - OVERDUE_MS)]),
  ]);
  const failing = (lists[0]!.results as { tenant_id: string; slug: string; streak: number; last_outcome: RunOutcome; last_error: string | null; last_at: number; last_ok_at: number | null }[]).map(
    (r): FailingTenant => ({ id: r.tenant_id, slug: r.slug, streak: r.streak, outcome: r.last_outcome, error: r.last_error, lastAt: r.last_at, okAt: r.last_ok_at }),
  );
  const overdue = (lists[1]!.results as { id: string; slug: string; schedule_next_at: number; updated_at: number; schedule_lease_until: number | null }[]).map(
    // A new tenant (due 0) has been due since its row last changed.
    (r): OverdueTenant => ({ id: r.id, slug: r.slug, dueAt: r.schedule_next_at > 0 ? r.schedule_next_at : r.updated_at, firstRun: r.schedule_next_at === 0, leaseUntil: r.schedule_lease_until }),
  );
  return { now, report: healthReport(state, configChecks(env), now), state, metrics, failing, overdue };
}

// --- Formatting ---------------------------------------------------------------

const num = (n: number) => n.toLocaleString("en-US");

/** "42 ms", "3.1 s", "4 min", "2 h 5 min": durations from a run's milliseconds to a backlog's hours. */
export function durationText(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
}

function agoText(now: number, at: number | null): string {
  if (at === null) return "Never";
  return `${durationText(Math.max(0, now - at))} ago`;
}

function rateText(perMinute: number): string {
  if (perMinute === 0) return "0";
  return perMinute < 10 ? perMinute.toFixed(1) : num(Math.round(perMinute));
}

function p95Text(w: RunWindow): string {
  if (w.p95Over) return "Over 60 s";
  return w.p95Ms === null ? "None" : `Up to ${durationText(w.p95Ms)}`;
}

const WINDOW_LABELS: Record<number, string> = { 15: "15 minutes", 60: "1 hour", 1440: "24 hours" };

function hourText(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
}

const OUTCOME_LABELS: Record<RunOutcome, string> = { ran: "Ran", lease_busy: "Already running", failed: "Failed", error: "No answer", timeout: "Timed out" };

const tick = (ok: boolean | null) =>
  ok === null ? html`<span class="warn-text">Unknown</span>` : ok ? html`<span class="ok-text">Configured</span>` : html`<span class="bad-text">Not configured</span>`;

// --- The page -------------------------------------------------------------------

export const OPERATIONS_STYLE = `
.health { margin: 0 0 16px; }
.health ul { margin: 6px 0 0; padding: 0 0 0 18px; }
.health li + li { margin-top: 2px; }
.health a { white-space: nowrap; }
.hours { list-style: none; margin: 8px 0 0; padding: 0; }
.hours li { display: grid; grid-template-columns: 3rem minmax(0, 1fr); align-items: center; gap: 4px 12px; padding: 8px 0; border-top: 1px solid var(--line); font-size: 0.8125rem; }
.hours li:first-child { border-top: 0; }
.hours time { color: var(--ink-muted); font-variant-numeric: tabular-nums; }
.hours .bar { position: relative; height: 8px; border-radius: 4px; background: var(--surface-2); overflow: hidden; }
.hours .bar span { position: absolute; inset: 0 auto 0 0; border-radius: 4px; background: var(--accent); }
.hours .bar span.bad { background: var(--down); }
.hours .nums { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0 12px; color: var(--ink-muted); font-variant-numeric: tabular-nums; }
.hours .nums strong { font-weight: 600; color: var(--ink); }
.hours .nums .bad-text { font-weight: 600; }
.hours .bar { grid-column: 2; }
.table.ops td.num { white-space: nowrap; }
.table.ops td.primary strong { white-space: nowrap; }
`;

function healthNotice(report: HealthReport): Html {
  const link = html`<a href="${PLATFORM_HEALTH_ROUTE}">${PLATFORM_HEALTH_ROUTE}</a>`;
  if (report.ok) {
    return html`<div class="notice ok health" role="status"><strong>All checks pass.</strong> Outside monitors read the same at ${link}.</div>`;
  }
  return html`<div class="notice error health" role="alert"><strong>Degraded.</strong> Outside monitors see HTTP 503 at ${link}.
<ul>${report.problems.map((p) => html`<li>${p}</li>`)}</ul></div>`;
}

function nowStats(v: OperationsView): Html {
  const lagMs = v.state.oldestDueAt === null ? 0 : Math.max(0, v.now - v.state.oldestDueAt);
  const quarter = v.metrics.windows[0]!;
  const stat = (value: string, label: string, attention: boolean, href?: string) =>
    href
      ? html`<a class="stat${attention ? " attention" : ""}" href="${href}"><strong>${value}</strong><span>${label}</span></a>`
      : html`<div class="stat${attention ? " attention" : ""}"><strong>${value}</strong><span>${label}</span></div>`;
  return html`<div class="stats">
${stat(lagMs ? durationText(lagMs) : "None", "Queue lag", lagMs > LAG_DEGRADED_MS)}
${stat(num(v.state.overdue), "Tenants overdue", v.state.overdue > 0, v.overdue.length ? "#overdue" : undefined)}
${stat(num(v.state.failing), "Tenants failing", !v.report.checks.tenants.ok || v.state.failing > 0, v.failing.length ? "#failing" : undefined)}
${stat(rateText(quarter.runsPerMinute), "Runs a minute", false)}
</div>`;
}

function windowsTable(windows: RunWindow[]): Html {
  const rows = windows.map(
    (w) => html`<tr>
<td class="primary"><strong>Last ${WINDOW_LABELS[w.minutes] ?? `${w.minutes} minutes`}</strong><span>${num(w.runs)} ${w.runs === 1 ? "run" : "runs"}</span></td>
<td class="num" data-label="Runs a minute">${rateText(w.runsPerMinute)}</td>
<td class="num" data-label="Failed"><span>${w.errors ? html`<span class="bad-text">${num(w.errors)}</span>` : "0"}${w.runs ? html` <span class="detail-text">(${((w.errors / w.runs) * 100).toFixed(w.errors && w.errors < w.runs / 100 ? 1 : 0)}%)</span>` : ""}</span></td>
<td class="num" data-label="Timed out">${w.timeouts ? html`<span class="bad-text">${num(w.timeouts)}</span>` : "0"}</td>
<td class="num" data-label="p95 duration">${p95Text(w)}</td>
<td class="num" data-label="Average">${w.runs ? durationText(w.avgMs) : "None"}</td>
<td class="num" data-label="Queue lag, average">${w.runs ? durationText(w.avgLagMs) : "None"}</td>
<td class="num" data-label="Queue lag, worst">${w.runs ? durationText(w.maxLagMs) : "None"}</td>
<td class="num" data-label="Failed checks">${num(w.failures)} of ${num(w.checked)}</td>
</tr>`,
  );
  return html`<table class="table ops"><thead><tr><th scope="col">Window</th><th scope="col" class="num">Runs a minute</th><th scope="col" class="num">Failed</th><th scope="col" class="num">Timed out</th><th scope="col" class="num">p95</th><th scope="col" class="num">Average</th><th scope="col" class="num">Lag, average</th><th scope="col" class="num">Lag, worst</th><th scope="col" class="num">Failed checks</th></tr></thead>
<tbody>${rows}</tbody></table>`;
}

function platformFacts(v: OperationsView): Html {
  const c = v.report.checks;
  const r = v.state.release;
  return html`<dl class="facts">
${fact("Cron", html`<span class="${c.cron.ok ? "" : "bad-text"}">${agoText(v.now, v.state.cronAt)}</span>`)}
${fact("Enqueued", html`<span class="${c.queue.ok ? "" : "bad-text"}">${agoText(v.now, v.state.enqueueAt)}${v.state.enqueue ? `, ${num(v.state.enqueue.sent)} ${v.state.enqueue.sent === 1 ? "tenant" : "tenants"}` : ""}</span>`)}
${fact("Last run", v.state.lastRunAt === null ? "None yet" : agoText(v.now, v.state.lastRunAt))}
${fact(
  "Release",
  r
    ? html`<a href="/admin/releases/${r.id}">${r.kind === "rollback" ? "Rollback to" : "Rollout of"} ${r.version}</a>, <span class="${r.state === "paused" ? "bad-text" : "warn-text"}">${r.state === "canary" ? "canary" : r.state === "rolling" ? `batch ${r.batch}` : "paused"}</span>`
    : "None in progress",
)}
${fact("Mail", tick(c.config.mail))}
${fact("Billing", tick(c.config.billing))}
${fact("Provisioning", tick(c.config.provisioning))}
</dl>`;
}

function hoursList(hours: RunHour[]): Html {
  if (!hours.length) return html`<p class="detail-text">No runs in the last 24 hours.</p>`;
  const most = Math.max(1, ...hours.map((h) => h.runs));
  const newestFirst = [...hours].reverse();
  return html`<ol class="hours">${newestFirst.map(
    (h) => html`<li><time datetime="${new Date(h.at).toISOString()}">${hourText(h.at)}</time>
<span class="nums"><span><strong>${num(h.runs)}</strong> runs${h.errors ? html`, <span class="bad-text">${num(h.errors)} failed</span>` : ""}</span><span>avg ${durationText(h.avgMs)}, worst lag ${durationText(h.maxLagMs)}</span></span>
<span class="bar" aria-hidden="true"><span style="width: ${((h.runs / most) * 100).toFixed(1)}%"></span>${
      h.errors ? html`<span class="bad" style="width: ${Math.max(2, (h.errors / most) * 100).toFixed(1)}%"></span>` : ""
    }</span></li>`,
  )}</ol>`;
}

function failingTable(v: OperationsView): Html {
  if (!v.failing.length) return html`<p class="detail-text">No tenant's runs are failing.</p>`;
  return html`<table class="table ops"><thead><tr><th scope="col">Tenant</th><th scope="col" class="num">Failed in a row</th><th scope="col">Last outcome</th><th scope="col">Last clean run</th><th scope="col">Error</th></tr></thead><tbody>${v.failing.map(
    (t) => html`<tr>
<td class="primary"><a href="/admin/tenants/${t.id}">${t.slug}</a><span>Last run ${agoText(v.now, t.lastAt)}</span></td>
<td class="num" data-label="Failed in a row"><span class="${t.streak >= FAILING_STREAK ? "bad-text" : "warn-text"}">${num(t.streak)}</span></td>
<td data-label="Last outcome">${OUTCOME_LABELS[t.outcome]}</td>
<td data-label="Last clean run" class="nowrap">${t.okAt === null ? "Never" : agoText(v.now, t.okAt)}</td>
<td data-label="Error" class="block">${t.error ?? "None"}</td>
</tr>`,
  )}</tbody></table>${v.state.failing > v.failing.length ? html`<p class="detail-text">The ${v.failing.length} longest failing of ${num(v.state.failing)}.</p>` : ""}`;
}

function overdueTable(v: OperationsView): Html {
  if (!v.overdue.length) return html`<p class="detail-text">Every tenant is on time.</p>`;
  return html`<table class="table ops"><thead><tr><th scope="col">Tenant</th><th scope="col" class="num">Waiting</th><th scope="col">Due</th><th scope="col">Now</th></tr></thead><tbody>${v.overdue.map(
    (t) => html`<tr>
<td class="primary"><a href="/admin/tenants/${t.id}">${t.slug}</a></td>
<td class="num" data-label="Waiting"><span class="${v.now - t.dueAt > LAG_DEGRADED_MS ? "bad-text" : "warn-text"}">${durationText(v.now - t.dueAt)}</span></td>
<td data-label="Due" class="nowrap">${timeText(t.dueAt)}</td>
<td data-label="Now">${t.leaseUntil !== null && t.leaseUntil > v.now ? "Being run" : t.firstRun ? "Waiting for its first run" : "Waiting for the cron"}</td>
</tr>`,
  )}</tbody></table>${v.state.overdue > v.overdue.length ? html`<p class="detail-text">The ${v.overdue.length} waiting longest of ${num(v.state.overdue)}.</p>` : ""}`;
}

export function operationsPage(v: OperationsView): Response {
  const main = html`<h1 class="visually-hidden">Operations</h1>
${healthNotice(v.report)}
${nowStats(v)}
<p class="detail-text">Queue lag is how long the oldest due tenant has waited. Overdue is ${OVERDUE_MS / 60_000} minutes past due, failing is ${FAILING_STREAK} runs in a row without a clean answer, and runs a minute are over the last 15 minutes.</p>
<section><h2>Scheduler runs</h2>
<p class="detail-text">Every tenant's runs together, to ${timeText(v.metrics.until)}. Failed counts the runs that failed, timed out or got no answer; p95 is the duration 95 of 100 runs stay within; lag is from due to called.</p>
${windowsTable(v.metrics.windows)}</section>
<div class="panels">
<div><section><h2>Platform</h2>${platformFacts(v)}</section></div>
<div><section><h2>Last 24 hours</h2>${hoursList(v.metrics.hours)}</section></div>
</div>
<section id="failing"><h2>Failing tenants</h2>${failingTable(v)}</section>
<section id="overdue"><h2>Overdue tenants</h2>${overdueTable(v)}</section>`;
  return adminPage({ title: "Operations", tab: "operations", main, styleExtra: OPERATIONS_STYLE });
}
