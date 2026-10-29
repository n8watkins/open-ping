/**
 * The admin console's pages: the tenant list, one tenant, the audit log,
 * the waitlist, and the passkey check in front of them all.
 *
 * The same shell, tokens and components as the customer pages (../ui.ts),
 * in a wider card. Designed phone first to docs/MOBILE_PLAN.md: tables
 * become cards below 768 px, every control is at least 44 px, inputs are
 * 16 px, and nothing needs hover. No inline script; the verify page loads
 * only the passkey helper.
 */

import { PLAN_IDS, TENANT_STATUSES, type HealthResponse, type PlanId, type TenantStatus } from "../../../src/shared/hosted-contract";
import type { Passkey } from "../auth/passkeys";
import { PASSKEY_SCRIPT_PATH } from "../client-script";
import type { ProvisionState } from "../tenants";
import { Html, PASSKEY_ICON, html, notice, renderPage } from "../ui";
import { packsText } from "../billing/pages";
import {
  AUDIT_ACTOR_FILTERS,
  REASON_MAX_LENGTH,
  SETUP_FILTERS,
  type AuditEvent,
  type AuditFilters,
  type TenantCounts,
  type TenantDetail,
  type TenantList,
} from "./data";
import type { RunOutcome, ScheduleView } from "../scheduling";
import { ADMIN_REAUTH_MS, ADMIN_SESSION_MAX_AGE_MS } from "./owner";
import { WAITLIST_MAX_ENTRIES, type ParsedWaitlist, type WaitlistSummary } from "./waitlist";

const SELECT_CHEVRON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='none' stroke='%238595ad' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 8 4 4 4-4'/%3E%3C/svg%3E\")";

export const ADMIN_STYLE = `
main.admin { max-width: 72rem; margin: 0 auto; padding: 16px 16px 24px; }
@media (min-width: 640px) { main.admin { padding: 24px 32px 32px; } }
.admin-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 44px; margin: 0 0 8px; }
.admin-head .brand { margin: 0; min-height: 44px; white-space: nowrap; }
@media (max-width: 374px) { .narrow-hide { display: none; } }
.tag { font-size: 0.6875rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-faint); border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; }
.head-link { display: flex; align-items: center; min-height: 44px; padding: 0 4px; font-size: 0.875rem; color: var(--ink-muted); text-decoration: none; white-space: nowrap; }
.head-link:hover { color: var(--ink); }
nav.tabs { display: flex; gap: 4px; margin: 0 0 20px; border-bottom: 1px solid var(--line); overflow-x: auto; scrollbar-width: none; }
nav.tabs a { display: flex; align-items: center; min-height: 44px; padding: 0 12px; color: var(--ink-muted); text-decoration: none; font-weight: 600; font-size: 0.9375rem; border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap; }
nav.tabs a:hover { color: var(--ink); }
nav.tabs a[aria-current="page"] { color: var(--ink); border-bottom-color: var(--accent); }
@media (max-width: 419px) { nav.tabs { gap: 0; } nav.tabs a { padding: 0 6px; font-size: 0.875rem; } nav.tabs a:first-child { padding-left: 0; } }
@media (max-width: 379px) { nav.tabs a { padding: 0 5px; font-size: 0.8125rem; } }
.tab-short { display: none; }
@media (max-width: 639px) {
  .tab-short { display: inline; }
  .tab-long { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
}
.title-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 0 0 4px; }
.title-row h1 { margin: 0; }
.title-row .badge { margin: 0; }
.sub { font-size: 0.875rem; color: var(--ink-faint); margin: 0 0 16px; }
.back { display: inline-flex; align-items: center; min-height: 44px; font-size: 0.875rem; text-decoration: none; margin: -8px 0 4px; }
select, textarea, input[type=file] {
  display: block; width: 100%; font: inherit; font-size: 16px; color: var(--ink);
  background-color: var(--canvas); border: 1px solid var(--line); border-radius: 0.5rem;
}
select { min-height: 48px; padding: 10px 40px 10px 14px; appearance: none; -webkit-appearance: none; background-image: ${SELECT_CHEVRON}; background-repeat: no-repeat; background-position: right 12px center; background-size: 20px; }
textarea { min-height: 112px; padding: 10px 14px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 16px; line-height: 1.4; }
input[type=file] { min-height: 48px; padding: 6px; font-size: 0.9375rem; color: var(--ink-muted); }
input[type=file]::file-selector-button { min-height: 36px; margin-right: 12px; padding: 0 14px; font: inherit; font-weight: 600; color: var(--ink); background: var(--surface-2); border: 1px solid var(--line); border-radius: 0.375rem; cursor: pointer; }
select:focus-visible, textarea:focus-visible, input[type=file]:focus-visible { outline: 2px solid var(--accent); outline-offset: 0; border-color: var(--accent); }
.filters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 0 0 16px; }
.filters .field { margin: 0; }
.filters .wide-field { grid-column: 1 / -1; }
.filters .go { display: flex; align-items: flex-end; gap: 8px; }
.filters .go .button { width: 100%; }
.filters.audit .go { grid-column: 1 / -1; }
@media (min-width: 900px) {
  .filters { grid-template-columns: minmax(0, 2fr) repeat(3, minmax(0, 1fr)) auto; align-items: end; }
  .filters .wide-field, .filters.audit .go { grid-column: auto; }
  .filters.audit { grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, 1.5fr) auto; }
}
.filters .go .button.small { min-height: 48px; }
.result-line { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; margin: 0 0 8px; font-size: 0.875rem; color: var(--ink-muted); }
.result-line a { display: inline-flex; align-items: center; min-height: 44px; }
.stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 0 0 20px; }
.stats.three .stat:last-child { grid-column: 1 / -1; }
@media (min-width: 640px) { .stats { grid-template-columns: repeat(4, minmax(0, 1fr)); } .stats.three { grid-template-columns: repeat(3, minmax(0, 1fr)); } .stats.three .stat:last-child { grid-column: auto; } }
.stat { display: block; min-height: 64px; padding: 10px 14px; border: 1px solid var(--line); border-radius: 0.625rem; background: var(--surface-2); color: inherit; text-decoration: none; }
a.stat:hover { border-color: var(--ink-faint); }
.stat strong { display: block; font-size: 1.375rem; line-height: 1.3; font-weight: 650; color: var(--ink); font-variant-numeric: tabular-nums; }
.stat span { display: block; font-size: 0.8125rem; color: var(--ink-muted); }
.stat.attention strong { color: var(--degraded); }
.table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
.table th { text-align: left; font-size: 0.75rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink-faint); padding: 8px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }
.table td { padding: 12px; border-bottom: 1px solid var(--line); vertical-align: top; color: var(--ink-muted); overflow-wrap: anywhere; }
.table td:first-child, .table th:first-child { padding-left: 0; }
.table td:last-child, .table th:last-child { padding-right: 0; }
.table td.num, .table th.num { text-align: right; font-variant-numeric: tabular-nums; }
.table .primary strong, .table .primary a { display: block; font-weight: 600; color: var(--ink); overflow-wrap: anywhere; }
.table .primary a { color: var(--link); text-decoration: none; }
.table .primary a:hover { text-decoration: underline; }
.table .primary span { display: block; font-size: 0.8125rem; color: var(--ink-faint); overflow-wrap: anywhere; }
.table .badge { margin: 0; white-space: nowrap; }
.table td a { text-decoration: none; }
.table td a:hover { text-decoration: underline; }
.table .nowrap { white-space: nowrap; }
.empty { padding: 24px 0; text-align: center; color: var(--ink-faint); }
@media (max-width: 767px) {
  .table thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .table, .table tbody, .table tr, .table td { display: block; width: 100%; }
  .table tr { border: 1px solid var(--line); border-radius: 0.75rem; background: var(--surface-2); padding: 12px 14px; margin: 0 0 10px; }
  .table td, .table td:first-child, .table td:last-child { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; padding: 4px 0; border: 0; text-align: right; }
  .table td::before { content: attr(data-label); flex: none; color: var(--ink-faint); font-size: 0.8125rem; text-align: left; }
  .table td.primary { display: block; text-align: left; padding: 0 0 8px; margin: 0 0 4px; border-bottom: 1px solid var(--line); }
  .table td.primary::before { content: none; }
  .table td.primary a { display: flex; align-items: center; min-height: 44px; margin: -8px 0 -6px; }
  .table td.block { display: block; text-align: left; }
  .table td.block::before { display: block; margin: 0 0 2px; }
}
.pager { display: flex; justify-content: space-between; gap: 12px; margin: 16px 0 0; }
.pager .button { width: auto; }
.panels { display: grid; grid-template-columns: minmax(0, 1fr); column-gap: 40px; }
@media (min-width: 900px) { .panels { grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; } }
.facts { margin: 8px 0 0; }
.facts div { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; padding: 9px 0; border-top: 1px solid var(--line); }
.facts div:first-child { border-top: 0; }
.facts dt { flex: none; color: var(--ink-muted); font-size: 0.875rem; }
.facts dd { margin: 0; min-width: 0; text-align: right; color: var(--ink); font-size: 0.875rem; overflow-wrap: anywhere; }
.facts dd.mono, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.8125rem; }
h3.minor { font-size: 0.8125rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink-faint); margin: 20px 0 4px; }
@media (min-width: 900px) {
  .facts.split { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 40px; }
  .facts.split div:nth-child(2) { border-top: 0; }
}
.table.runs td.num { white-space: nowrap; }
.ok-text { color: var(--up); } .bad-text { color: var(--down); } .warn-text { color: var(--degraded); }
.actions-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; margin: 12px 0 0; }
@media (min-width: 900px) { .actions-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.action { border: 1px solid var(--line); border-radius: 0.75rem; padding: 16px; background: var(--surface-2); }
.action h3 { font-size: 0.9375rem; margin: 0 0 4px; font-weight: 650; }
.action p { font-size: 0.875rem; }
.action .field { margin: 0 0 12px; }
.action.danger { border-color: color-mix(in srgb, var(--down) 45%, var(--line)); }
.account-delete { margin-top: 24px; } .account-delete summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; font-weight: 650; font-size: 0.9375rem; } .account-delete[open] summary { margin-bottom: 4px; }
.action input[type=text] { background: var(--canvas); }
@media (min-width: 640px) { .action .button { width: auto; } }
.events { list-style: none; margin: 8px 0 0; padding: 0; }
.events li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 16px; padding: 10px 0; border-top: 1px solid var(--line); font-size: 0.875rem; }
.events li:first-child { border-top: 0; }
.events .what { color: var(--ink); font-weight: 600; overflow-wrap: anywhere; }
.events .who { font-weight: 400; color: var(--ink-faint); }
.events time { color: var(--ink-faint); font-size: 0.8125rem; white-space: nowrap; text-align: right; }
.events .detail { grid-column: 1 / -1; color: var(--ink-muted); font-size: 0.8125rem; overflow-wrap: anywhere; }
@media (max-width: 479px) { .events li { grid-template-columns: minmax(0, 1fr); } .events time { text-align: left; grid-row: 2; } }
.detail-text { font-size: 0.8125rem; color: var(--ink-muted); overflow-wrap: anywhere; }
.credential { display: block; margin: 4px 0 0; font-size: 0.75rem; color: var(--ink-muted); overflow-wrap: anywhere; user-select: all; }
.issues { margin: 8px 0 0; padding: 0 0 0 18px; font-size: 0.8125rem; color: var(--ink-muted); }
`;

export type Tab = "tenants" | "operations" | "releases" | "audit" | "waitlist";

/** `short` is what a phone shows, so all five tabs fit at 360 px; screen readers always hear `label`. */
const TABS: { id: Tab; href: string; label: string; short?: string }[] = [
  { id: "tenants", href: "/admin", label: "Tenants" },
  { id: "operations", href: "/admin/operations", label: "Operations", short: "Ops" },
  { id: "releases", href: "/admin/releases", label: "Releases" },
  { id: "audit", href: "/admin/audit", label: "Audit log", short: "Audit" },
  { id: "waitlist", href: "/admin/waitlist", label: "Waitlist" },
];

function header(current: Tab | null): Html {
  return html`<header class="admin-head">
<a class="brand" href="/admin"><span class="dot" aria-hidden="true"></span><span>OpenPing<span class="narrow-hide"> Hosted</span></span><span class="tag">Admin</span></a>
<a class="head-link" href="/account">Your account</a>
</header>
${
  current
    ? html`<nav class="tabs" aria-label="Admin sections">${TABS.map(
        (t) =>
          html`<a href="${t.href}"${t.id === current ? new Html(' aria-current="page"') : ""}>${
            t.short ? html`<span class="tab-long">${t.label}</span><span class="tab-short" aria-hidden="true">${t.short}</span>` : t.label
          }</a>`,
      )}</nav>`
    : ""
}`;
}

export function adminPage(input: { title: string; tab: Tab | null; main: Html; status?: number; scripts?: string[]; styleExtra?: string }): Response {
  return renderPage({
    title: `${input.title} - Admin`,
    main: input.main,
    status: input.status,
    scripts: input.scripts,
    admin: true,
    header: header(input.tab),
    style: ADMIN_STYLE + (input.styleExtra ?? ""),
    footer: false,
  });
}

// --- Formatting ---------------------------------------------------------------

/** "Oct 28, 2026, 14:03 UTC": the owner reads times in UTC, like the logs. */
export function timeText(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "Never";
  const d = new Date(ms);
  const date = d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  return `${date}, ${time} UTC`;
}

function dateText(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "Never";
  return new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

const PLAN_LABELS: Record<PlanId, string> = { trial: "Trial", hosted: "Hosted", hosted_fast: "Hosted, 1-minute" };
const STATUS_LABELS: Record<TenantStatus, string> = { trial: "Trial", active: "Active", past_due: "Past due", suspended: "Suspended" };
const SETUP_LABELS: Record<(typeof SETUP_FILTERS)[number], string> = {
  requested: "Requested",
  db_created: "Database made",
  uploaded: "Uploaded",
  migrated: "Migrated",
  ready: "Ready",
  deleting: "Being removed",
  paused: "Paused (needs a look)",
};

function statusBadge(status: TenantStatus): Html {
  const tone = status === "suspended" ? "--suspended" : status === "past_due" ? "--degraded" : status === "active" ? "--up" : null;
  return html`<span class="badge"${tone ? new Html(` style="--tone: var(${tone})"`) : ""}>${STATUS_LABELS[status]}</span>`;
}

function setupBadge(state: ProvisionState, paused: boolean): Html {
  if (paused) return html`<span class="badge" style="--tone: var(--down)">Paused</span>`;
  if (state === "ready") return html`<span class="badge" style="--tone: var(--up)">Ready</span>`;
  if (state === "deleting") return html`<span class="badge" style="--tone: var(--down)">Being removed</span>`;
  return html`<span class="badge" style="--tone: var(--degraded)">${SETUP_LABELS[state]}</span>`;
}

function detailText(detail: Record<string, unknown> | null): string {
  if (!detail) return "";
  const text = Object.entries(detail)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" · ");
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

function options<T extends string>(values: readonly T[], labels: Record<T, string>, selected: T | null, any: string): Html {
  return html`<option value="">${any}</option>${values.map(
    (v) => html`<option value="${v}"${v === selected ? new Html(" selected") : ""}>${labels[v]}</option>`,
  )}`;
}

function query(params: Record<string, string | number | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

// --- The tenant list ------------------------------------------------------------

export function tenantListPage(input: { list: TenantList; counts: TenantCounts; flash?: { message: string; tone: "ok" | "error" } | null }): Response {
  const { list, counts } = input;
  const f = list.filters;
  const filtered = Boolean(f.q || f.status || f.plan || f.setup);
  const pages = Math.max(1, Math.ceil(list.total / list.pageSize));
  const base = { q: f.q, status: f.status, plan: f.plan, setup: f.setup };
  const rows = list.rows.map(
    (t) => html`<tr>
<td class="primary"><a href="/admin/tenants/${t.id}">${t.slug}</a><span>${t.email}</span></td>
<td data-label="Status">${statusBadge(t.status)}</td>
<td data-label="Plan" class="nowrap">${PLAN_LABELS[t.plan]}</td>
<td data-label="Setup">${setupBadge(t.provisionState, t.paused)}</td>
<td data-label="Version" class="mono">${t.version ?? "None yet"}</td>
<td data-label="Monitors" class="num">${t.monitors ?? "None yet"}</td>
<td data-label="Created" class="nowrap">${dateText(t.createdAt)}</td>
</tr>`,
  );
  const main = html`<h1 class="visually-hidden">Tenants</h1>
${input.flash ? notice(input.flash.message, input.flash.tone) : ""}
<div class="stats">
<a class="stat" href="/admin"><strong>${counts.all}</strong><span>All tenants</span></a>
<a class="stat" href="/admin${query({ setup: "requested" })}"><strong>${counts.settingUp}</strong><span>Setting up</span></a>
<a class="stat${counts.paused ? " attention" : ""}" href="/admin${query({ setup: "paused" })}"><strong>${counts.paused}</strong><span>Paused, need a look</span></a>
<a class="stat" href="/admin${query({ status: "suspended" })}"><strong>${counts.suspended}</strong><span>Suspended</span></a>
</div>
<form class="filters" method="get" action="/admin" role="search">
<div class="field wide-field"><label for="q">Search</label><input id="q" name="q" type="text" inputmode="search" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Address, email or id" value="${f.q}"></div>
<div class="field"><label for="status">Status</label><select id="status" name="status">${options(TENANT_STATUSES, STATUS_LABELS, f.status, "Any status")}</select></div>
<div class="field"><label for="plan">Plan</label><select id="plan" name="plan">${options(PLAN_IDS, PLAN_LABELS, f.plan, "Any plan")}</select></div>
<div class="field"><label for="setup">Setup</label><select id="setup" name="setup">${options(SETUP_FILTERS, SETUP_LABELS, f.setup, "Any state")}</select></div>
<div class="go"><button class="button primary small" type="submit">Filter</button></div>
</form>
<div class="result-line"><span>${list.total === 1 ? "1 tenant" : `${list.total} tenants`}${filtered ? " match" : ""}${pages > 1 ? `, page ${f.page} of ${pages}` : ""}</span>${
    filtered ? html`<a href="/admin">Clear filters</a>` : ""
  }</div>
${
  list.rows.length
    ? html`<table class="table">
<thead><tr><th scope="col">Address</th><th scope="col">Status</th><th scope="col">Plan</th><th scope="col">Setup</th><th scope="col">Version</th><th scope="col" class="num">Monitors</th><th scope="col">Created</th></tr></thead>
<tbody>${rows}</tbody></table>`
    : html`<p class="empty">${filtered ? "No tenant matches these filters." : "No tenants yet."}</p>`
}
${
  pages > 1
    ? html`<nav class="pager" aria-label="Pages">${
        f.page > 1 ? html`<a class="button secondary small" href="/admin${query({ ...base, page: f.page - 1 })}">Newer</a>` : html`<span></span>`
      }${f.page < pages ? html`<a class="button secondary small" href="/admin${query({ ...base, page: f.page + 1 })}">Older</a>` : ""}</nav>`
    : ""
}
<details class="action danger account-delete"><summary>Delete an account by its email</summary>
<p>For a support request from an account with no OpenPing (one with an OpenPing: its tenant page). The same deletion as the customer's own button; they are emailed.</p>
<form method="post" action="/admin/accounts/delete">
<div class="field"><label for="delete-email">Account email</label>
<input id="delete-email" name="email" type="email" required autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="email"></div>
<div class="field"><label for="delete-confirm">The same email again, to confirm</label>
<input id="delete-confirm" name="confirm" type="email" required autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="email"></div>
${reasonField("account-delete-reason", "Reason", "Asked by email on ...", "Recorded in the audit log.")}
<button class="button danger" type="submit">Delete the account</button></form></details>`;
  return adminPage({ title: "Tenants", tab: "tenants", main });
}

// --- One tenant -------------------------------------------------------------------

export type HealthView =
  | { kind: "answered"; status: number; health: HealthResponse }
  | { kind: "unreachable"; reason: string }
  | { kind: "skipped"; reason: string };

export interface TenantPageInput {
  detail: TenantDetail;
  history: AuditEvent[];
  health: HealthView;
  /** Its scheduler runs (src/scheduling.ts). */
  schedule: ScheduleView;
  tenantUrl: string;
  recent: boolean;
  supportOn: boolean;
  /** Its email through the platform today: sent, failed, refused by the cap. */
  emails?: { sent: number; failed: number; refused: number } | null;
  flash?: { message: string; tone: "ok" | "error" } | null;
}

export function fact(label: string, value: Html | string | number, mono = false): Html {
  return html`<div><dt>${label}</dt><dd${mono ? new Html(' class="mono"') : ""}>${value}</dd></div>`;
}

function healthFacts(view: HealthView): Html {
  if (view.kind !== "answered") return html`<p class="detail-text">${view.reason}</p>`;
  const h = view.health;
  const run = h.lastRun;
  return html`<dl class="facts">
${fact("Answer", h.ok ? html`<span class="ok-text">Healthy</span>` : html`<span class="bad-text">Not healthy (HTTP ${view.status})</span>`)}
${fact("Version", h.version, true)}
${fact("Schema", `${h.schemaVersion} of ${h.bundledSchemaVersion}${h.migrating ? ", migrating" : ""}`)}
${fact("Last run", run ? timeText(run.at) : "No run yet")}
${run ? fact("Outcome", html`<span class="${run.outcome === "ran" ? "ok-text" : run.outcome === "failed" ? "bad-text" : "warn-text"}">${run.outcome}</span>, ${run.durationMs} ms`) : ""}
</dl>`;
}

function usageFacts(d: TenantDetail, emails: TenantPageInput["emails"]): Html {
  const u = d.usage;
  const of = (n: number | undefined, limit: number) => (n === undefined ? `Limit ${limit}` : `${n} of ${limit}`);
  return html`<dl class="facts">
${fact("Monitors", of(u?.monitors, d.limits.monitors))}
${d.limits.fastMonitors > 0 ? fact("Fast monitors", of(u?.fastMonitors ?? undefined, d.limits.fastMonitors)) : ""}
${fact("Packs", packsText(d.record.packs))}
${fact("Status pages", of(u?.statusPages, d.limits.statusPages))}
${fact("Alert channels", u ? String(u.channels) : "Not reported")}
${fact("Fastest check", d.limits.minIntervalMinutes === 1 ? "1 minute" : `${d.limits.minIntervalMinutes} minutes`)}
${
  emails
    ? fact(
        "Emails today (UTC)",
        `${emails.sent} of ${d.limits.emailsPerDay}${emails.failed ? `, ${emails.failed} failed` : ""}${emails.refused ? `, ${emails.refused} over the cap` : ""}`,
      )
    : fact("Emails a day", String(d.limits.emailsPerDay))
}
${fact("Reported", u ? timeText(u.reportedAt) : "Never")}
</dl>`;
}

/** To the second: runs happen every minute. */
function secondsText(ms: number): string {
  const d = new Date(ms);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${date}, ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" })} UTC`;
}

function dayText(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function msText(ms: number): string {
  return ms < 10_000 ? `${ms.toLocaleString("en-US")} ms` : `${(ms / 1000).toFixed(1)} s`;
}

const OUTCOME_LABELS: Record<RunOutcome, string> = { ran: "Ran", lease_busy: "Already running", failed: "Failed", error: "No answer", timeout: "Timed out" };

function outcomeText(outcome: RunOutcome): Html {
  const tone = outcome === "ran" ? "ok-text" : outcome === "lease_busy" ? "warn-text" : "bad-text";
  return html`<span class="${tone}">${OUTCOME_LABELS[outcome]}</span>`;
}

function scheduleFacts(v: ScheduleView, now: number): Html {
  const every = v.intervalMs === 60_000 ? "Every minute" : `Every ${Math.round(v.intervalMs / 60_000)} minutes`;
  const last = v.last;
  return html`<dl class="facts split">
${fact("Cadence", every)}
${fact("Next run", v.nextAt === null ? "Not while it can't run" : v.nextAt <= now ? "Due now" : secondsText(v.nextAt))}
${v.leaseUntil && v.leaseUntil > now ? fact("Running", `held until ${secondsText(v.leaseUntil)}`) : ""}
${fact("Last run", last ? secondsText(last.at) : "No run yet")}
${last ? fact("Outcome", outcomeText(last.outcome)) : ""}
${last && last.streak > 0 ? fact("Failed in a row", html`<span class="bad-text">${last.streak}</span>`) : ""}
${last ? fact("Took", `${msText(last.durationMs)}${last.tenantMs !== null ? ` (the run itself ${msText(last.tenantMs)})` : ""}`) : ""}
${last ? fact("Queue lag", msText(last.lagMs)) : ""}
${last && last.checked !== null ? fact("Checks", `${last.checked}, ${last.failures ?? 0} failed${last.deferred ? `, ${last.deferred} left for later` : ""}`) : ""}
${last && last.d1Queries !== null ? fact("D1 queries", String(last.d1Queries)) : ""}
${last?.error ? fact("Error", last.error) : ""}
${last && last.outcome !== "ran" ? fact("Last clean run", last.okAt ? secondsText(last.okAt) : "Never") : ""}
</dl>`;
}

function scheduleDays(v: ScheduleView): Html {
  if (!v.days.length) return html``;
  return html`<table class="table runs"><thead><tr><th>Day (UTC)</th><th class="num">Runs</th><th class="num">No answer</th><th class="num">Checks</th><th class="num">Failed checks</th><th class="num">D1 queries</th><th class="num">Average</th><th class="num">Slowest</th></tr></thead><tbody>
${v.days.map(
  (d) => html`<tr><td class="primary nowrap"><strong>${dayText(d.day)}</strong></td>
<td class="num" data-label="Runs">${d.runs.toLocaleString("en-US")}</td>
<td class="num" data-label="No answer">${d.errors ? html`<span class="bad-text">${d.errors.toLocaleString("en-US")}</span>` : "0"}</td>
<td class="num" data-label="Checks">${d.checked.toLocaleString("en-US")}</td>
<td class="num" data-label="Failed checks">${d.failures.toLocaleString("en-US")}</td>
<td class="num" data-label="D1 queries">${d.d1Queries.toLocaleString("en-US")}</td>
<td class="num" data-label="Average">${msText(d.avgMs)}</td>
<td class="num" data-label="Slowest">${msText(d.maxMs)}</td></tr>`,
)}</tbody></table>`;
}

function reasonField(id: string, label: string, placeholder: string, hint: string): Html {
  return html`<div class="field"><label for="${id}">${label}</label>
<input id="${id}" name="reason" type="text" required minlength="3" maxlength="${REASON_MAX_LENGTH}" autocomplete="off" placeholder="${placeholder}">
<p class="hint">${hint}</p></div>`;
}

function actions(input: TenantPageInput): Html {
  const d = input.detail;
  const t = d.record;
  const base = `/admin/tenants/${t.id}`;
  const cards: Html[] = [];
  const paused = d.provision.pausedAt !== null && t.provisionState !== "ready";

  if (paused && d.accountDeletionAt === null) {
    cards.push(html`<div class="action"><h3>Resume provisioning</h3>
<p>Fix the cause first (the error above). It starts again from ${SETUP_LABELS[t.provisionState].toLowerCase()} with a clean set of retries.</p>
<form method="post" action="${base}/resume-provisioning"><button class="button primary" type="submit">Resume provisioning</button></form></div>`);
    cards.push(html`<div class="action danger"><h3>Remove this tenant</h3>
<p>Deletes its Worker, its database and its escrowed key, then the row. Its address is free again at once, since it never served anyone.</p>
<form method="post" action="${base}/remove">
<div class="field"><label for="confirm-slug">Type <code>${t.slug}</code> to confirm</label>
<input id="confirm-slug" name="confirm" type="text" required autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="url"></div>
<button class="button danger" type="submit">Remove ${t.slug}</button></form></div>`);
  }

  if (d.accountDeletionAt !== null) {
    cards.push(html`<div class="action"><h3>Account being deleted</h3>
<p>Asked ${secondsText(d.accountDeletionAt)}. Its OpenPing stays paused; the lifecycle jobs export it, delete it, then scrub the account.</p></div>`);
  } else {
    cards.push(html`<div class="action danger"><h3>Delete this account</h3>
<p>For a support request from <strong>${d.email}</strong>: cancels its plan, pauses its OpenPing now, then exports and deletes it and scrubs the account, as the customer's own button does. They are emailed.</p>
<form method="post" action="${base}/delete-account">
${reasonField("delete-reason", "Reason", "Asked by email on ...", "Recorded in the audit log.")}
<div class="field"><label for="confirm-email">Type <code>${d.email}</code> to confirm</label>
<input id="confirm-email" name="confirm" type="email" required autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="email"></div>
<button class="button danger" type="submit">Delete ${d.email}</button></form></div>`);
  }

  if (d.ownerSuspension && d.accountDeletionAt === null) {
    cards.push(html`<div class="action"><h3>Resume</h3>
<p>Lifts your suspension. ${
      t.billingStatus === "suspended"
        ? "Billing has suspended it too, so it stays offline until billing says otherwise."
        : `Billing's state is ${STATUS_LABELS[t.billingStatus].toLowerCase()}, so visitors reach it again within 30 seconds.`
    }</p>
<form method="post" action="${base}/resume"><button class="button primary" type="submit">Resume ${t.slug}</button></form></div>`);
  } else if (t.provisionState === "ready") {
    cards.push(html`<div class="action danger"><h3>Suspend</h3>
<p>Stops its checks and takes its status page and dashboard offline; nothing is deleted. Other servers take up to 30 seconds to notice. Only you can lift it: billing never does.</p>
<form method="post" action="${base}/suspend">
${reasonField("suspend-reason", "Reason", "Phishing on its status page", "Kept in the audit log.")}
<button class="button danger" type="submit">Suspend ${t.slug}</button></form></div>`);
  }

  if (t.provisionState === "ready" && t.status !== "suspended") {
    cards.push(
      input.supportOn
        ? html`<div class="action"><h3>Sign in to help</h3>
<p>Opens their OpenPing as support for one hour. The customer sees each support sign-in and its reason on their account page and in their Settings.</p>
<form method="post" action="${base}/support">
${reasonField("support-reason", "Reason the customer will see", "Your email about a monitor", "One plain sentence.")}
<button class="button secondary" type="submit">Sign in as support</button></form></div>`
        : html`<div class="action"><h3>Sign in to help</h3><p>Not available: HANDOFF_SIGNING_KEY isn't set.</p></div>`,
    );
  }

  if (!cards.length) {
    return html`<p class="detail-text">${
      t.provisionState === "deleting" ? "Nothing to do while it is being removed." : "Nothing to do until it is ready; provisioning keeps trying on its own."
    }</p>`;
  }
  return html`${
    input.recent
      ? ""
      : notice(`Changes ask you to confirm with your passkey first (a sign-in from the last ${ADMIN_REAUTH_MS / 60_000} minutes).`, "info")
  }<div class="actions-grid">${cards}</div>`;
}

export function tenantPage(input: TenantPageInput): Response {
  const d = input.detail;
  const t = d.record;
  const paused = d.provision.pausedAt !== null && t.provisionState !== "ready";
  const history = input.history.length
    ? html`<ol class="events">${input.history.map(
        (e) => html`<li><span class="what">${e.action} <span class="who">by ${e.actor}</span></span><time datetime="${new Date(e.at).toISOString()}">${timeText(e.at)}</time>${
          e.detail ? html`<span class="detail">${detailText(e.detail)}</span>` : ""
        }</li>`,
      )}</ol>
<p class="detail-text"><a href="/admin/audit${query({ tenant: t.id })}">Everything for this tenant in the audit log</a></p>`
    : html`<p class="detail-text">Nothing recorded yet.</p>`;
  const main = html`<a class="back" href="/admin">All tenants</a>
<div class="title-row"><h1>${t.slug}</h1>${statusBadge(t.status)}${setupBadge(t.provisionState, paused)}</div>
<p class="sub">${d.email}${d.accountDisabled ? " (account closed)" : ""}, since ${dateText(d.createdAt)}</p>
${input.flash ? notice(input.flash.message, input.flash.tone) : ""}
${paused ? html`<p class="notice error" role="status"><strong>Provisioning is paused</strong> at ${SETUP_LABELS[t.provisionState].toLowerCase()} after ${d.provision.attempts} ${d.provision.attempts === 1 ? "try" : "tries"}, since ${timeText(d.provision.pausedAt)}.<br>${d.provision.error ?? "No error was recorded."}</p>` : ""}
${d.ownerSuspension ? notice(`Suspended by you ${timeText(d.ownerSuspension.at)}${d.ownerSuspension.reason ? `: ${d.ownerSuspension.reason}` : ""}.`, "info") : ""}
${t.billingStatus === "suspended" ? notice(`Suspended by billing${d.billingSuspendedAt ? ` since ${timeText(d.billingSuspendedAt)}` : ""}.`, "info") : ""}
<div class="panels">
<div><section><h2>OpenPing</h2><dl class="facts">
${fact("Address", t.provisionState === "ready" ? html`<a href="${input.tenantUrl}" rel="noreferrer">${input.tenantUrl.replace(/^https?:\/\//, "")}</a>` : input.tenantUrl.replace(/^https?:\/\//, ""))}
${fact("Tenant id", t.id, true)}
${fact("Account id", t.accountId, true)}
${fact("Script", t.scriptName, true)}
${fact("Database", d.databaseName, true)}
${fact("Database id", d.d1Id ?? "Not made yet", true)}
${fact("Plan", PLAN_LABELS[t.plan])}
${fact("Billing status", STATUS_LABELS[t.billingStatus])}
${t.status === "trial" && t.trialEndsAt ? fact("Trial ends", timeText(t.trialEndsAt)) : ""}
${fact("Version", t.version ?? "None yet", true)}
${fact("Ready since", d.provisionedAt ? timeText(d.provisionedAt) : "Not ready")}
</dl></section></div>
<div><section><h2>Health</h2>${healthFacts(input.health)}</section>
<section><h2>Usage</h2>${usageFacts(d, input.emails ?? null)}</section>
<section><h2>Provisioning</h2><dl class="facts">
${fact("State", SETUP_LABELS[t.provisionState])}
${fact("Failed tries", String(d.provision.attempts))}
${fact("Last error", d.provision.error ?? "None")}
${d.provision.nextAt && !paused && t.provisionState !== "ready" ? fact("Next try", timeText(d.provision.nextAt)) : ""}
${d.provision.leaseUntil && d.provision.leaseUntil > Date.now() ? fact("Running", `until ${timeText(d.provision.leaseUntil)}`) : ""}
${fact("Requested", timeText(d.createdAt))}
</dl></section></div>
</div>
<section><h2>Scheduler</h2>${scheduleFacts(input.schedule, Date.now())}${
    input.schedule.days.length
      ? html`<h3 class="minor">${input.schedule.days.length === 1 ? "Today" : `Last ${input.schedule.days.length} days`}</h3>${scheduleDays(input.schedule)}`
      : ""
  }</section>
<section><h2>Actions</h2>${actions(input)}</section>
<section><h2>History</h2>${history}</section>`;
  return adminPage({ title: t.slug, tab: "tenants", main });
}

// --- The audit log ----------------------------------------------------------------

const ACTOR_LABELS: Record<(typeof AUDIT_ACTOR_FILTERS)[number], string> = { customer: "Customer", support: "Support", system: "System", owner: "Owner" };

export function auditPage(input: { events: AuditEvent[]; more: boolean; filters: AuditFilters }): Response {
  const f = input.filters;
  const filtered = Boolean(f.tenant || f.actor || f.action);
  const rows = input.events.map(
    (e) => html`<tr>
<td class="primary"><strong>${e.action}</strong><span class="nowrap">${timeText(e.at)}</span></td>
<td data-label="Who" class="nowrap">${ACTOR_LABELS[e.actor]}</td>
<td data-label="Tenant">${e.tenantId ? html`<a href="/admin/tenants/${e.tenantId}">${e.slug ?? e.tenantId}</a>` : "None"}</td>
<td data-label="Account">${e.email ?? e.accountId ?? "None"}</td>
<td data-label="Detail" class="block">${detailText(e.detail) || "None"}</td>
</tr>`,
  );
  const last = input.events.at(-1);
  const main = html`<h1 class="visually-hidden">Audit log</h1>
<form class="filters audit" method="get" action="/admin/audit" role="search">
<div class="field wide-field"><label for="tenant">Tenant</label><input id="tenant" name="tenant" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Address or tenant id" value="${f.tenant}"></div>
<div class="field"><label for="actor">Who</label><select id="actor" name="actor">${options(AUDIT_ACTOR_FILTERS, ACTOR_LABELS, f.actor, "Anyone")}</select></div>
<div class="field"><label for="action">Action</label><input id="action" name="action" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="tenant." value="${f.action}"></div>
<div class="go"><button class="button primary small" type="submit">Filter</button></div>
</form>
<div class="result-line"><span>${f.before ? "Older events" : "Newest first"}${filtered ? ", filtered" : ""}</span>${filtered || f.before ? html`<a href="/admin/audit">Back to the newest</a>` : ""}</div>
${
  input.events.length
    ? html`<table class="table">
<thead><tr><th scope="col">What and when</th><th scope="col">Who</th><th scope="col">Tenant</th><th scope="col">Account</th><th scope="col">Detail</th></tr></thead>
<tbody>${rows}</tbody></table>`
    : html`<p class="empty">No events${filtered ? " match these filters" : " yet"}.</p>`
}
${
  input.more && last
    ? html`<nav class="pager" aria-label="Pages"><span></span><a class="button secondary small" href="/admin/audit${query({ tenant: f.tenant, actor: f.actor, action: f.action, before: last.id })}">Older</a></nav>`
    : ""
}`;
  return adminPage({ title: "Audit log", tab: "audit", main });
}

// --- The waitlist -------------------------------------------------------------------

export interface WaitlistImportView {
  added: number;
  existing: number;
  list: ParsedWaitlist;
}

export function waitlistPage(input: { summary: WaitlistSummary; result?: WaitlistImportView | null; error?: string | null; status?: number }): Response {
  const s = input.summary;
  const r = input.result;
  const resultNotice = r
    ? html`<div class="notice ok" role="status"><strong>${r.added === 1 ? "1 new address" : `${r.added} new addresses`}</strong> added${
        r.existing ? `, ${r.existing} already on the list` : ""
      }${r.list.duplicates ? `, ${r.list.duplicates} repeated in the file` : ""}.${
        r.list.invalid.length
          ? html`<br>${r.list.invalid.length === 1 ? "1 entry had" : `${r.list.invalid.length} entries had`} no usable address:<ul class="issues">${r.list.invalid
              .slice(0, 10)
              .map((i) => html`<li>${i.where}: <code>${i.text || "(empty)"}</code></li>`)}</ul>${r.list.invalid.length > 10 ? html`<span class="detail-text">and ${r.list.invalid.length - 10} more.</span>` : ""}`
          : ""
      }</div>`
    : "";
  const rows = s.latest.map(
    (e) => html`<tr>
<td class="primary"><strong>${e.email}</strong></td>
<td data-label="Joined" class="nowrap">${e.joinedAt ? dateText(e.joinedAt) : "Unknown"}</td>
<td data-label="Imported" class="nowrap">${dateText(e.importedAt)}</td>
<td data-label="Account">${e.hasAccount ? html`<span class="ok-text">Signed up</span>` : "Not yet"}</td>
</tr>`,
  );
  const main = html`<h1 class="visually-hidden">Waitlist</h1>
${input.error ? html`<p class="notice error" role="alert">${input.error}</p>` : ""}
${resultNotice}
<div class="stats three">
<div class="stat"><strong>${s.total}</strong><span>On the list</span></div>
<div class="stat"><strong>${s.withAccount}</strong><span>Have an account</span></div>
<div class="stat"><strong>${s.lastImportAt ? dateText(s.lastImportAt) : "Never"}</strong><span>Last import</span></div>
</div>
<section><h2>Import</h2>
<p>On openping.n8builds.dev, open Settings, then Reports, and choose Download CSV in the Hosted waitlist card. Upload that file here, or paste it. Importing the same file again adds nothing; up to ${WAITLIST_MAX_ENTRIES.toLocaleString("en-US")} addresses at a time.</p>
<form method="post" action="/admin/waitlist" enctype="multipart/form-data">
<div class="field"><label for="file">Export file</label><input id="file" name="file" type="file" accept=".csv,.json,text/csv,application/json"></div>
<div class="field"><label for="text">Or paste it</label><textarea id="text" name="text" rows="4" spellcheck="false" autocapitalize="off" placeholder="email,joined_at"></textarea>
<p class="hint">CSV with an email column, or the JSON of /api/waitlist.</p></div>
<button class="button primary" type="submit">Import</button>
</form></section>
<section><h2>Latest</h2>
${
  s.latest.length
    ? html`<table class="table">
<thead><tr><th scope="col">Email</th><th scope="col">Joined</th><th scope="col">Imported</th><th scope="col">Account</th></tr></thead>
<tbody>${rows}</tbody></table>`
    : html`<p class="empty">Nobody yet. Import the export from the canonical install.</p>`
}</section>`;
  return adminPage({ title: "Waitlist", tab: "waitlist", main, status: input.status });
}

// --- The passkey check -------------------------------------------------------------

/**
 * Shown to the owner whose session isn't a recent sign-in with a pinned
 * passkey: one tap signs in again and comes back to `next`. While none of
 * the account's passkeys is pinned (or the one used isn't), it lists them
 * with their credential ids, so the owner can pin their own in
 * PLATFORM_OWNER_PASSKEYS: the bootstrap, done once in config.
 */
export function verifyPage(input: {
  next: string;
  passkeys: Passkey[];
  pinned: ReadonlySet<string>;
  /** The credential this session signed in with, if a passkey. */
  current: string | null;
  unpinned: boolean;
  forChange: boolean;
  status?: number;
}): Response {
  const hasPinned = input.passkeys.some((p) => input.pinned.has(p.credentialId));
  const why = input.unpinned
    ? hasPinned
      ? "This session's passkey isn't one of your pinned passkeys. Sign in with a pinned one."
      : "None of your passkeys is pinned yet, so the admin console stays closed. Pin your own passkey, then sign in with it."
    : input.forChange
      ? `Changes need a sign-in with a pinned passkey from the last ${ADMIN_REAUTH_MS / 60_000} minutes. Nothing was changed; sign in again, then repeat it.`
      : `The admin console needs a sign-in with a pinned passkey on this device from the last ${ADMIN_SESSION_MAX_AGE_MS / 3_600_000} hours.`;
  const showIds = input.passkeys.length > 0 && (!hasPinned || input.unpinned);
  const list = showIds
    ? html`<section><h2>Your passkeys</h2>
<p>Add the id of a passkey you hold, and only those, to <code>PLATFORM_OWNER_PASSKEYS</code> (a var or secret on the platform Worker). A passkey you don't recognise here was added by someone else: remove it from your account page.</p>
<ul class="rows">${input.passkeys.map(
        (p) => html`<li><div class="what"><strong>${p.label ?? "Passkey"}${p.credentialId === input.current ? " (this session)" : ""}${input.pinned.has(p.credentialId) ? " (pinned)" : ""}</strong><span>Added ${timeText(p.createdAt)}${
          p.lastUsedAt ? `, last used ${timeText(p.lastUsedAt)}` : ""
        }</span><code class="credential">${p.credentialId}</code></div></li>`,
      )}</ul></section>`
    : "";
  const main = html`<h1>Confirm it's you</h1>
<p class="lead">${why}</p>
${
  input.passkeys.length
    ? html`<div class="stack"><button class="button primary" type="button" data-passkey="sign-in" data-next="${input.next}" data-error="passkey-error" hidden>${PASSKEY_ICON}Use your passkey</button></div>
<p class="notice error" id="passkey-error" role="alert" hidden></p>`
    : html`<p class="notice" role="status">Your account has no passkey yet. Add one on your account page, then come back.</p>
<div class="stack"><a class="button primary" href="/account">Go to your account</a></div>`
}
${list}`;
  return renderPage({
    title: "Confirm it's you - Admin",
    main,
    status: input.status ?? 200,
    scripts: input.passkeys.length ? [PASSKEY_SCRIPT_PATH] : [],
    header: header(null),
    style: ADMIN_STYLE,
    footer: false,
  });
}
