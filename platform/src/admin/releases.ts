/**
 * app.<domain>/admin/releases: the release runner in the owner's console
 * (build plan, C1). Mounted inside the console (./routes.ts), so the same
 * owner check, passkey freshness, origin check and rate limit apply.
 *
 * What it shows: the version new tenants get (releases/current), the
 * versions in the bundle bucket, the release in progress with its canary,
 * its batch and its failures, requests still waiting for the cron (from the
 * command line), and the history. What it does: plan (a dry run), start,
 * pause, resume, skip the failures, cancel, and roll back, each one a
 * release request handled at once, the same row the command line writes.
 */

import { Hono, type Context } from "hono";

import type { PlatformCapability } from "../../../src/shared/hosted-contract";
import { isBundleVersion } from "../bundle";
import type { PlatformEnv } from "../env";
import type { ReleaseSetup } from "../releases/env";
import {
  RELEASE_BATCH_SIZE,
  activeRelease,
  advanceRelease,
  getRelease,
  handleRequests,
  memberCounts,
  pendingRequests,
  recentReleases,
  releaseMembers,
  submitRequest,
  type MemberCounts,
  type Release,
  type ReleaseState,
  type ReleaseTenantState,
  type RequestAction,
} from "../releases/runner";
import type { Session } from "../auth/sessions";
import type { TenantRecord } from "../tenants";
import { Html, html, notice } from "../ui";
import { adminPage, fact, timeText } from "./pages";
import { appNotFoundPage } from "../pages";
import { appOrigin } from "../hosts";
import { log } from "../log";

export interface ReleaseConsoleDeps {
  releases?(env: PlatformEnv, ctx: ExecutionContext, capability: (tenant: TenantRecord) => PlatformCapability): ReleaseSetup;
  capability(env: PlatformEnv, ctx: ExecutionContext, tenant: TenantRecord): PlatformCapability;
}

type Env = { Bindings: PlatformEnv; Variables: { owner: Session; now: number; recent: boolean } };
type Ctx = Context<Env>;

/** How long the console's own push on a release may run after the answer (waitUntil allows 30 seconds). */
export const CONSOLE_TICK_BUDGET_MS = 20_000;

export const RELEASE_STYLE = `
.progress { height: 10px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--line); overflow: hidden; margin: 12px 0 6px; }
.progress span { display: block; height: 100%; background: var(--up); }
.progress span.bad { background: var(--down); }
.progress-text { font-size: 0.8125rem; color: var(--ink-muted); margin: 0 0 12px; font-variant-numeric: tabular-nums; }
.inline-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 0; }
.inline-actions form { margin: 0; }
.inline-actions .button { width: auto; }
.two-buttons { display: flex; flex-wrap: wrap; gap: 8px; }
.two-buttons .button { flex: 1 1 10rem; }
.release-form { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0 12px; }
@media (min-width: 640px) { .release-form { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); } .release-form .wide-field { grid-column: 1 / -1; } }
@media (max-width: 767px) { .table td.no-value { display: none; } }
.release-history td.mono, .release-history .primary a { white-space: nowrap; }
.plan-list { margin: 8px 0 0; padding: 0 0 0 18px; font-size: 0.875rem; color: var(--ink-muted); }
.plan-list li { margin: 2px 0; overflow-wrap: anywhere; }
`;

const STATE_LABELS: Record<ReleaseState, string> = {
  canary: "Canary",
  rolling: "Rolling out",
  paused: "Stopped",
  done: "Done",
  refused: "Refused",
  cancelled: "Cancelled",
};

const MEMBER_LABELS: Record<ReleaseTenantState, string> = {
  pending: "Waiting",
  uploaded: "Checking health",
  healthy: "Healthy",
  failed: "Failed",
  skipped: "Skipped",
};

function stateBadge(release: Release): Html {
  const label = release.dryRun ? "Dry run" : STATE_LABELS[release.state];
  const tone =
    release.dryRun ? null : release.state === "done" ? "--up" : release.state === "paused" || release.state === "refused" ? "--down" : release.state === "cancelled" ? null : "--degraded";
  return html`<span class="badge"${tone ? new Html(` style="--tone: var(${tone})"`) : ""}>${label}</span>`;
}

function memberBadge(state: ReleaseTenantState): Html {
  const tone = state === "healthy" ? "--up" : state === "failed" ? "--down" : state === "skipped" ? null : "--degraded";
  return html`<span class="badge"${tone ? new Html(` style="--tone: var(${tone})"`) : ""}>${MEMBER_LABELS[state]}</span>`;
}

const kindText = (r: Release) => (r.kind === "rollback" ? `Roll back to ${r.version}` : `Roll out ${r.version}`);

function progress(release: Release, counts: MemberCounts): Html {
  const total = Math.max(release.plan?.toUpdate ?? 0, counts.pending + counts.uploaded + counts.healthy + counts.failed + counts.skipped);
  if (!total) return html`<p class="progress-text">No tenant to update.</p>`;
  const done = counts.healthy + counts.skipped;
  const pct = (n: number) => `${Math.min(100, Math.round((n / total) * 1000) / 10)}%`;
  return html`<div class="progress" role="progressbar" aria-label="Tenants updated" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}">${
    counts.failed ? html`<span class="bad" style="width: ${pct(counts.failed)}; float: right"></span>` : ""
  }<span style="width: ${pct(done)}"></span></div>
<p class="progress-text">${done} of ${total} tenants done${counts.failed ? `, ${counts.failed} failed` : ""}${counts.skipped ? `, ${counts.skipped} skipped` : ""}${
    counts.uploaded ? `, ${counts.uploaded} checking health` : ""
  }</p>`;
}

function requestButton(action: RequestAction, label: string, tone: "primary" | "secondary" | "danger", fields: Record<string, string> = {}): Html {
  return html`<form method="post" action="/admin/releases/request"><input type="hidden" name="action" value="${action}">${Object.entries(fields).map(
    ([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`,
  )}<button class="button ${tone} small" type="submit">${label}</button></form>`;
}

function activeCard(release: Release, counts: MemberCounts, canarySlug: string | null): Html {
  const actions: Html[] = [];
  if (release.state === "paused") {
    actions.push(requestButton("resume", "Resume", "primary"));
    if (release.batch > 0) actions.push(requestButton("skip_failed", "Skip the failed and resume", "secondary"));
  } else {
    actions.push(requestButton("pause", "Pause", "secondary"));
  }
  actions.push(requestButton("cancel", "Cancel", "secondary"));
  if (release.kind === "rollout" && release.fromVersion) actions.push(requestButton("rollback", `Roll back to ${release.fromVersion}`, "danger"));
  return html`<section class="action${release.state === "paused" ? " danger" : ""}">
<div class="title-row"><h2 style="margin: 0"><a href="/admin/releases/${release.id}">${kindText(release)}</a></h2>${stateBadge(release)}</div>
${release.note ? html`<p class="detail-text" style="margin: 8px 0 0">${release.note}</p>` : ""}
${progress(release, counts)}
<dl class="facts">
${release.kind === "rollout" ? fact("Canary", canarySlug ? `${canarySlug}, ${release.canaryState === "ran" ? "ran clean" : release.canaryState === "healthy" ? "healthy, running its check" : "updating"}` : "None") : ""}
${fact("Batch", release.batch === 0 ? "The canary" : `${release.batch}${release.plan ? ` of ${release.plan.batches}` : ""}, up to ${release.batchSize} each`)}
${fact("From", release.fromVersion ?? "Nothing yet", true)}
${fact("Started", timeText(release.createdAt))}
</dl>
<div class="inline-actions">${actions}</div>
</section>`;
}

function historyTable(releases: Release[]): Html {
  if (!releases.length) return html`<p class="empty">No releases yet.</p>`;
  return html`<table class="table release-history">
<thead><tr><th scope="col">Release</th><th scope="col">State</th><th scope="col">From</th><th scope="col">When</th><th scope="col">Note</th></tr></thead>
<tbody>${releases.map(
    (r) => html`<tr>
<td class="primary"><a href="/admin/releases/${r.id}">${kindText(r)}</a><span>by ${r.requestedBy}</span></td>
<td data-label="State">${stateBadge(r)}</td>
<td data-label="From" class="mono">${r.fromVersion ?? "None"}</td>
<td data-label="When" class="nowrap">${timeText(r.createdAt)}</td>
<td data-label="Note" class="block">${r.note ?? ""}</td>
</tr>`,
  )}</tbody></table>`;
}

function versionOptions(versions: string[], selected: string | null): Html {
  return html`${versions.map((v) => html`<option value="${v}"${v === selected ? new Html(" selected") : ""}>${v}</option>`)}`;
}

export interface ReleasesPageInput {
  current: string | null;
  versions: string[];
  storeError: string | null;
  missing: string[];
  active: Release | null;
  activeCounts: MemberCounts | null;
  canarySlug: string | null;
  defaultCanary: string | null;
  previous: string | null;
  waiting: { id: string; action: string; version: string | null; createdAt: number }[];
  history: Release[];
  recent: boolean;
}

export function releasesPage(input: ReleasesPageInput): Response {
  // Newest first: the one just uploaded, usually.
  const newest = input.versions[0] ?? null;
  const off = input.missing.length > 0;
  const start = off
    ? ""
    : html`<section><h2>Start a release</h2>
${
  input.versions.length
    ? html`<p>Upload the bundle first (<code>npm run tenant-release -- build</code>, then <code>upload</code>). A dry run checks the migrations and plans the batches without touching anything.</p>
<form method="post" action="/admin/releases/request">
<input type="hidden" name="action" value="rollout">
<div class="release-form">
<div class="field"><label for="version">Version</label><select id="version" name="version">${versionOptions(input.versions, newest)}</select></div>
<div class="field"><label for="batch-size">Batch size</label><input id="batch-size" name="batch_size" type="number" inputmode="numeric" min="1" max="500" value="${RELEASE_BATCH_SIZE}"></div>
<div class="field wide-field"><label for="canary">Canary</label><input id="canary" name="canary" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="url" placeholder="${input.defaultCanary ?? "The oldest tenant"}">
<p class="hint">A slug or tenant id. Empty: ${input.defaultCanary ? `RELEASE_CANARY (${input.defaultCanary})` : "the oldest tenant; set RELEASE_CANARY to your own test tenant"}.</p></div>
</div>
<div class="two-buttons"><button class="button secondary" type="submit" name="dry_run" value="1">Plan (dry run)</button><button class="button primary" type="submit" name="dry_run" value="0"${input.active ? new Html(" disabled") : ""}>Start the rollout</button></div>
${input.active ? html`<p class="hint">A release is in progress; finish, cancel or roll it back first.</p>` : ""}
</form>`
    : html`<p class="empty">No bundle in the bucket yet. Run <code>npm run tenant-release -- build</code> and <code>upload</code>.</p>`
}</section>
<section><h2>Roll back</h2>
<p>New tenants get the older version at once; every tenant on another version follows in batches, without a canary, and a failure doesn't stop it.</p>
<form method="post" action="/admin/releases/request">
<input type="hidden" name="action" value="rollback">
<div class="field"><label for="rollback-to">Back to</label><select id="rollback-to" name="version"><option value="">${input.previous ? `The version before (${input.previous})` : "The version before"}</option>${versionOptions(
        input.versions.filter((v) => v !== input.current),
        null,
      )}</select></div>
<div class="two-buttons"><button class="button secondary" type="submit" name="dry_run" value="1">Plan (dry run)</button><button class="button danger" type="submit" name="dry_run" value="0">Roll back</button></div>
</form></section>`;
  const main = html`<h1 class="visually-hidden">Releases</h1>
${off ? notice(`Releases are off until these are set: ${input.missing.join(", ")}.`, "error") : ""}
${input.storeError ? notice(`The bundle bucket couldn't be read: ${input.storeError}`, "error") : ""}
<div class="stats three">
<div class="stat"><strong class="mono">${input.current ?? "None"}</strong><span>New tenants get</span></div>
<div class="stat"><strong>${input.versions.length}</strong><span>Versions in the bucket</span></div>
<div class="stat${input.active?.state === "paused" ? " attention" : ""}"><strong>${input.active ? STATE_LABELS[input.active.state] : "Idle"}</strong><span>Release in progress</span></div>
</div>
${input.active && input.activeCounts ? activeCard(input.active, input.activeCounts, input.canarySlug) : ""}
${
  input.waiting.length
    ? html`<section><h2>Waiting for the next minute</h2><ul class="plan-list">${input.waiting.map(
        (w) => html`<li><code>${w.id}</code>: ${w.action}${w.version ? ` ${w.version}` : ""}, asked ${timeText(w.createdAt)}</li>`,
      )}</ul></section>`
    : ""
}
${input.recent ? "" : notice("Changes ask you to confirm with your passkey first.", "info")}
${start}
<section><h2>History</h2>${historyTable(input.history)}</section>`;
  return adminPage({ title: "Releases", tab: "releases", main, styleExtra: RELEASE_STYLE });
}

export function releasePage(input: {
  release: Release;
  counts: MemberCounts;
  members: Awaited<ReturnType<typeof releaseMembers>>;
  canarySlug: string | null;
  request: { result: string } | null;
  active: boolean;
}): Response {
  const r = input.release;
  const plan = r.plan;
  const checks = plan?.checks;
  const rows = input.members.map(
    (m) => html`<tr>
<td class="primary">${m.slug ? html`<a href="/admin/tenants/${m.tenantId}">${m.slug}</a>` : html`<strong>${m.tenantId}</strong>`}<span>${m.batch === 0 ? "Canary" : `Batch ${m.batch}`}</span></td>
<td data-label="State">${memberBadge(m.state)}</td>
<td data-label="Was on" class="mono">${m.fromVersion ?? "Unknown"}</td>
<td data-label="Updated" class="nowrap">${timeText(m.updatedAt)}</td>
<td data-label="Error" class="block${m.error ? "" : " no-value"}">${m.error ?? ""}</td>
</tr>`,
  );
  const main = html`<a class="back" href="/admin/releases">All releases</a>
<div class="title-row"><h1>${kindText(r)}</h1>${stateBadge(r)}</div>
<p class="sub">${r.id}, asked by ${r.requestedBy}, ${timeText(r.createdAt)}</p>
${input.request ? notice(input.request.result, /^(Refused|Failed)/.test(input.request.result) ? "error" : "ok") : ""}
${r.note && !input.request?.result.endsWith(r.note) ? notice(r.note, r.state === "paused" || r.state === "refused" ? "error" : "info") : ""}
${input.active ? html`${progress(r, input.counts)}<p class="detail-text">This page shows the state when it loaded; reload it to follow along.</p>` : ""}
<div class="panels">
<div><section><h2>Release</h2><dl class="facts">
${fact("Version", r.version, true)}
${fact("From", r.fromVersion ?? "Nothing before", true)}
${fact("Kind", r.kind === "rollback" ? "Rollback" : "Rollout")}
${r.kind === "rollout" ? fact("Canary", input.canarySlug ? `${input.canarySlug}${plan?.canary?.reason ? ` (${plan.canary.reason})` : ""}` : "None") : ""}
${fact("Batch size", String(r.batchSize))}
${fact("Finished", r.finishedAt ? timeText(r.finishedAt) : "Not yet")}
</dl></section></div>
<div><section><h2>Plan</h2>${
    plan
      ? html`<dl class="facts">
${fact("Tenants to update", String(plan.toUpdate))}
${fact("Batches after the canary", String(plan.batches))}
${fact("New D1 migrations", checks?.newMigrations.length ? checks.newMigrations.join(", ") : "None")}
${checks?.newDurableObjectTags.length ? fact("New Durable Object migrations", checks.newDurableObjectTags.join(", ")) : ""}
</dl>
${checks?.problems.length ? html`<ul class="plan-list">${checks.problems.map((p) => html`<li class="bad-text">${p}</li>`)}</ul>` : ""}
${plan.firstBatch.length ? html`<p class="detail-text">First batch: ${plan.firstBatch.join(", ")}${plan.toUpdate > plan.firstBatch.length + 1 ? ", ..." : ""}</p>` : ""}`
      : html`<p class="detail-text">No plan was made: it was refused before one could be.</p>`
  }</section></div>
</div>
<section><h2>Tenants</h2>${
    rows.length
      ? html`<table class="table"><thead><tr><th scope="col">Tenant</th><th scope="col">State</th><th scope="col">Was on</th><th scope="col">Updated</th><th scope="col">Error</th></tr></thead><tbody>${rows}</tbody></table>
<p class="detail-text">${input.counts.healthy} healthy, ${input.counts.failed} failed, ${input.counts.skipped} skipped, ${input.counts.pending + input.counts.uploaded} still open${
          input.members.length < input.counts.healthy + input.counts.failed + input.counts.skipped + input.counts.pending + input.counts.uploaded ? `; the first ${input.members.length} are listed, failures first` : ""
        }.</p>`
      : html`<p class="empty">${r.dryRun ? "A dry run touches no tenant." : r.state === "refused" ? "It was refused, so no tenant was touched." : "No tenant touched yet."}</p>`
  }</section>`;
  return adminPage({ title: kindText(r), tab: "releases", main, styleExtra: RELEASE_STYLE });
}

const RELEASE_ID = /^rel_[0-9a-f]{24}$/;
const REQUEST_ID = /^rrq_[0-9a-f]{24}$/;
const ACTIONS: readonly RequestAction[] = ["rollout", "rollback", "pause", "resume", "skip_failed", "cancel"];

async function slugOf(db: D1Database, tenantId: string | null): Promise<string | null> {
  if (!tenantId) return null;
  return (await db.prepare("SELECT slug FROM tenants WHERE id = ?").bind(tenantId).first<{ slug: string }>())?.slug ?? tenantId;
}

export function releaseRoutes(deps: ReleaseConsoleDeps): Hono<Env> {
  const app = new Hono<Env>();
  const setupFor = (c: Ctx): ReleaseSetup => {
    const ctx = c.executionCtx as ExecutionContext;
    if (!deps.releases) return { ok: false, missing: ["the release runner is not wired in this app"] };
    return deps.releases(c.env, ctx, (tenant) => deps.capability(c.env, ctx, tenant));
  };

  app.get("/", async (c) => {
    const db = c.env.PLATFORM_DB;
    const setup = setupFor(c);
    let current: string | null = null;
    let versions: string[] = [];
    let storeError: string | null = null;
    if (setup.ok) {
      try {
        [current, versions] = await Promise.all([setup.deps.store.currentVersion(), setup.deps.store.listVersions()]);
      } catch (error) {
        storeError = error instanceof Error ? error.message.slice(0, 200) : "unknown error";
      }
    }
    const [active, history, waiting] = await Promise.all([activeRelease(db), recentReleases(db), pendingRequests(db)]);
    const lastRollout = history.find((r) => r.kind === "rollout" && !r.dryRun && r.state !== "refused" && r.version === current);
    return releasesPage({
      current,
      versions,
      storeError,
      missing: setup.ok ? [] : setup.missing,
      active,
      activeCounts: active ? await memberCounts(db, active.id) : null,
      canarySlug: await slugOf(db, active?.canaryTenantId ?? null),
      defaultCanary: setup.ok ? (setup.deps.defaultCanary ?? null) : null,
      previous: lastRollout?.fromVersion ?? null,
      waiting,
      history,
      recent: c.get("recent"),
    });
  });

  app.get("/:id", async (c) => {
    const db = c.env.PLATFORM_DB;
    const id = c.req.param("id");
    const release = RELEASE_ID.test(id) ? await getRelease(db, id) : null;
    if (!release) return appNotFoundPage(appOrigin(c.env.HOSTED_DOMAIN));
    const requestId = c.req.query("request") ?? "";
    const request = REQUEST_ID.test(requestId)
      ? await db.prepare("SELECT result FROM release_requests WHERE id = ? AND release_id = ?").bind(requestId, id).first<{ result: string | null }>()
      : null;
    const [counts, members] = await Promise.all([memberCounts(db, id), releaseMembers(db, id)]);
    return releasePage({
      release,
      counts,
      members,
      canarySlug: await slugOf(db, release.canaryTenantId),
      request: request?.result ? { result: request.result } : null,
      active: release.state === "canary" || release.state === "rolling" || release.state === "paused",
    });
  });

  app.post("/request", async (c) => {
    const db = c.env.PLATFORM_DB;
    const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
    const field = (name: string) => (typeof body[name] === "string" ? (body[name] as string).trim() : "");
    const action = field("action") as RequestAction;
    const setup = setupFor(c);
    const back = (message: string) =>
      adminPage({ title: "Releases", tab: "releases", status: 400, main: html`${notice(message, "error")}<p><a class="button secondary small" href="/admin/releases">Back to releases</a></p>` });
    if (!ACTIONS.includes(action)) return back("That isn't something a release can do.");
    if (!setup.ok) return back(`Releases are off until these are set: ${setup.missing.join(", ")}.`);
    const version = field("version");
    const canary = field("canary").toLowerCase();
    const batch = field("batch_size");
    if (version && !isBundleVersion(version)) return back("That isn't a version.");
    const owner = c.get("owner").account.id;
    let requestId: string;
    try {
      requestId = await submitRequest(
        db,
        {
          action,
          version: version || null,
          dryRun: field("dry_run") === "1",
          canary: canary || null,
          batchSize: batch ? Number(batch) : null,
          requestedBy: `owner:${owner}`,
        },
        c.get("now"),
      );
    } catch (error) {
      return back(error instanceof Error ? error.message.replace(/^release request refused: /, "Not asked: ") + "." : "Not asked.");
    }
    // Handled now rather than at the next minute (with any older request from the command line first).
    const outcomes = await handleRequests(setup.deps);
    const mine = outcomes.find((o) => o.requestId === requestId);
    // Starts the work at once; the cron carries on from here.
    c.executionCtx.waitUntil(advanceRelease(setup.deps, CONSOLE_TICK_BUDGET_MS).catch((error) => log.error("admin.release_push_failed", { error })));
    const target = mine?.releaseId ?? (await activeRelease(db))?.id ?? null;
    return new Response(null, {
      status: 303,
      headers: { location: target ? `/admin/releases/${target}?request=${requestId}` : "/admin/releases", "cache-control": "no-store" },
    });
  });

  return app;
}
