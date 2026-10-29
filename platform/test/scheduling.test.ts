import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  INTERNAL_HEADER,
  PLATFORM_SCHEDULED_PATH,
  type PlatformCapability,
  type ScheduledRequest,
  type ScheduledRunSummary,
  type TenantProps,
} from "../../src/shared/hosted-contract";
import {
  DAY_MS,
  DUE_SQL,
  MAX_IDLE_MS,
  QUEUE_LEASE_MS,
  enqueueDue,
  handleScheduleBatch,
  nextDueAfterClaim,
  nextDueAfterRun,
  parseSummary,
  readNextDueAt,
  spreadIndex,
  type ScheduleMessage,
  type SchedulingDeps,
} from "../src/scheduling";
import { FakeDispatcher, type FakeUserWorker } from "./fake-dispatcher";

const DOMAIN = "openping.test";
const MINUTE = 60_000;
const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);

const noopPlatform: PlatformCapability = {
  sendEmail: async () => ({ ok: false, error: "email_unavailable", message: "" }),
  reportUsage: async () => {},
  audit: async () => {},
};

interface World {
  deps: SchedulingDeps;
  dispatcher: FakeDispatcher;
  clock: { now: number };
  queue: Queue<ScheduleMessage>;
  sent: ScheduleMessage[];
  queueFails: { on: boolean };
}

function world(): World {
  const dispatcher = new FakeDispatcher();
  const clock = { now: T0 };
  const sent: ScheduleMessage[] = [];
  const queueFails = { on: false };
  const queue = {
    send: async () => {
      throw new Error("not used");
    },
    sendBatch: async (messages: { body: ScheduleMessage }[]) => {
      if (queueFails.on) throw new Error("queue unavailable");
      sent.push(...messages.map((m) => m.body));
    },
  } as unknown as Queue<ScheduleMessage>;
  const deps: SchedulingDeps = {
    db: env.PLATFORM_DB,
    dispatcher,
    capability: () => noopPlatform,
    hostedDomain: DOMAIN,
    now: () => clock.now,
    callTimeoutMs: () => 200,
  };
  return { deps, dispatcher, clock, queue, sent, queueFails };
}

let seq = 0;
async function tenant(options: {
  plan?: "trial" | "hosted" | "hosted_fast";
  status?: "trial" | "active" | "past_due" | "suspended";
  state?: string;
  nextAt?: number;
  ownerSuspended?: boolean;
  overrides?: string;
} = {}): Promise<string> {
  seq++;
  const id = `sched${String(seq).padStart(11, "0")}`;
  const account = `acc_sched${seq}`;
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare("INSERT INTO accounts (id, email, created_at, updated_at) VALUES (?, ?, 0, 0)").bind(account, `s${seq}@example.com`),
    env.PLATFORM_DB.prepare(
      `INSERT INTO tenants (id, account_id, slug, script_name, status, plan, provision_state, schedule_next_at, owner_suspended_at, limit_overrides, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
    ).bind(
      id,
      account,
      `sched${seq}`,
      `t-${id}`,
      options.status ?? "active",
      options.plan ?? "hosted",
      options.state ?? "ready",
      options.nextAt ?? 0,
      options.ownerSuspended ? T0 - DAY_MS : null,
      options.overrides ?? null,
    ),
  ]);
  return id;
}

async function scheduleRow(id: string) {
  return (await env.PLATFORM_DB.prepare("SELECT schedule_next_at, schedule_claim, schedule_running, schedule_lease_until FROM tenants WHERE id = ?")
    .bind(id)
    .first<{ schedule_next_at: number; schedule_claim: string | null; schedule_running: string | null; schedule_lease_until: number | null }>())!;
}

async function stats(id: string) {
  return env.PLATFORM_DB.prepare("SELECT * FROM scheduler_stats WHERE tenant_id = ?").bind(id).first<Record<string, number | string | null>>();
}

/** A user Worker that answers the scheduled path like OpenPing, with what `answer` returns. */
function openPing(
  answer: (run: ScheduledRequest, props: TenantProps) => Partial<ScheduledRunSummary> | Response | Promise<Partial<ScheduledRunSummary> | Response> = () => ({}),
): FakeUserWorker {
  return async (request, props) => {
    const url = new URL(request.url);
    if (url.pathname !== PLATFORM_SCHEDULED_PATH || request.headers.get(INTERNAL_HEADER) !== props.callId) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const run = (await request.json()) as ScheduledRequest;
    const over = await answer(run, props);
    if (over instanceof Response) return over;
    const summary: ScheduledRunSummary = {
      runId: run.runId,
      outcome: "ran",
      version: "0.15.0",
      schemaVersion: 22,
      migrationsApplied: 0,
      startedAt: run.scheduledTime,
      durationMs: 120,
      checked: 4,
      failures: 1,
      deferred: 0,
      d1Queries: 9,
      ...over,
    };
    return Response.json(summary);
  };
}

function batchOf(messages: ScheduleMessage[], attempts = 1) {
  const acks: string[] = [];
  const retries: { tenantId: string; delaySeconds?: number }[] = [];
  const batch = {
    queue: "openping-schedule",
    messages: messages.map((body, i) => ({
      id: `m${i}`,
      attempts,
      body,
      timestamp: new Date(),
      ack: () => acks.push(body.tenantId),
      retry: (o?: { delaySeconds?: number }) => retries.push({ tenantId: body.tenantId, delaySeconds: o?.delaySeconds }),
    })),
  } as unknown as MessageBatch<unknown>;
  return { batch, acks, retries };
}

/** The cron at `w.clock.now`, then the consumer on what it sent. */
async function tick(w: World) {
  const before = w.sent.length;
  const enqueued = await enqueueDue(w.deps, w.queue, w.clock.now);
  const messages = w.sent.slice(before);
  return { enqueued, messages };
}

beforeAll(async () => {
  await applyD1Migrations(env.PLATFORM_DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare("DELETE FROM scheduler_days"),
    env.PLATFORM_DB.prepare("DELETE FROM scheduler_stats"),
    env.PLATFORM_DB.prepare("DELETE FROM tenants"),
    env.PLATFORM_DB.prepare("DELETE FROM accounts"),
  ]);
});

describe("the due query", () => {
  it("is a range scan of the partial due index, never a scan of tenants", async () => {
    const plan = await env.PLATFORM_DB.prepare(`EXPLAIN QUERY PLAN ${DUE_SQL}`).bind(T0, T0, 100).all<{ detail: string }>();
    const details = plan.results.map((r) => r.detail).join(" | ");
    expect(details).toContain("USING INDEX idx_tenants_schedule_due (schedule_next_at<?)");
    expect(details).not.toMatch(/SCAN tenants(?! USING)/);
    // No sort step: the index is already in schedule_next_at order.
    expect(details).not.toContain("TEMP B-TREE");
  });

  it("reads only the due rows, however many tenants are not due", async () => {
    for (let i = 0; i < 30; i++) await tenant({ nextAt: T0 + 10 * MINUTE });
    for (let i = 0; i < 3; i++) await tenant({ nextAt: T0 - MINUTE });
    const result = await env.PLATFORM_DB.prepare(DUE_SQL).bind(T0, T0, 100).all();
    expect(result.results).toHaveLength(3);
    // Each due row is read once, plus at most one index probe past the end.
    expect(result.meta.rows_read).toBeLessThanOrEqual(4);
  });
});

describe("when a tenant is due", () => {
  it("keeps a tenant's phase, and skips whole intervals a late cron missed", () => {
    expect(nextDueAfterClaim("a", T0, T0 + 5_000, 12 * MINUTE)).toBe(T0 + 12 * MINUTE);
    expect(nextDueAfterClaim("a", T0, T0 + 30 * MINUTE, 12 * MINUTE)).toBe(T0 + 36 * MINUTE);
    expect(nextDueAfterClaim("a", T0, T0 + 5_000, MINUTE)).toBe(T0 + MINUTE);
  });

  it("spreads first runs over the interval by tenant id", () => {
    const offsets = new Set<number>();
    for (let i = 0; i < 200; i++) offsets.add(spreadIndex(`tenant${i}`, 12));
    expect(offsets.size).toBe(12);
    const next = nextDueAfterClaim("abc", 0, T0 + 5_000, 12 * MINUTE);
    expect(next).toBeGreaterThan(T0);
    expect(next).toBeLessThanOrEqual(T0 + 12 * MINUTE);
  });

  it("follows the tenant's nextDueAt later, never sooner than the plan, never past the idle cap", () => {
    const base = { dueAt: T0, claimedNext: T0 + MINUTE, interval: MINUTE };
    expect(nextDueAfterRun({ ...base, nextDueAt: null })).toBe(T0 + MINUTE);
    expect(nextDueAfterRun({ ...base, nextDueAt: T0 + 5 * MINUTE })).toBe(T0 + 5 * MINUTE);
    expect(nextDueAfterRun({ ...base, nextDueAt: T0 + 10_000 })).toBe(T0 + MINUTE);
    expect(nextDueAfterRun({ ...base, nextDueAt: T0 + 3 * 3_600_000 })).toBe(T0 + MAX_IDLE_MS);
  });

  it("reads nextDueAt only when the tenant sends a time", () => {
    expect(readNextDueAt({ outcome: "ran" })).toBeNull();
    expect(readNextDueAt({ nextDueAt: "soon" })).toBeNull();
    expect(readNextDueAt({ nextDueAt: T0 })).toBe(T0);
    expect(parseSummary({ runId: "r", outcome: "ran", nextDueAt: T0 }, "r")).toMatchObject({ nextDueAt: T0 });
    expect(parseSummary({ runId: "other", outcome: "ran" }, "r")).toBeNull();
    expect(parseSummary({ runId: "r", outcome: "exploded" }, "r")).toBeNull();
  });
});

describe("the cron", () => {
  it("enqueues one message per due tenant that may run, and nobody else", async () => {
    const w = world();
    const due = await tenant({ nextAt: T0 - MINUTE });
    const dueTrial = await tenant({ plan: "trial", status: "trial", nextAt: T0 });
    const pastDue = await tenant({ status: "past_due", nextAt: T0 - MINUTE });
    const later = await tenant({ nextAt: T0 + 5 * MINUTE });
    await tenant({ status: "suspended", nextAt: T0 - MINUTE });
    await tenant({ ownerSuspended: true, nextAt: T0 - MINUTE });
    await tenant({ state: "uploaded", nextAt: T0 - MINUTE });
    await tenant({ state: "deleting", nextAt: T0 - MINUTE });

    const { enqueued, messages } = await tick(w);
    expect(new Set(messages.map((m) => m.tenantId))).toEqual(new Set([due, dueTrial, pastDue]));
    expect(enqueued).toMatchObject({ sent: 3, returned: 0 });
    const m = messages.find((x) => x.tenantId === due)!;
    expect(m).toEqual({ tenantId: due, runId: `s-${T0}-${due}`, dueAt: T0 - MINUTE, tick: T0 });

    const row = await scheduleRow(due);
    expect(row.schedule_next_at).toBe(T0 - MINUTE + 12 * MINUTE);
    expect(row.schedule_claim).toBe(m.runId);
    expect(row.schedule_lease_until).toBe(T0 + QUEUE_LEASE_MS);
    expect((await scheduleRow(later)).schedule_claim).toBeNull();

    // The next minute: nothing new is due.
    w.clock.now += MINUTE;
    expect((await tick(w)).messages).toEqual([]);
  });

  it("runs a 1-minute tenant every minute and a 12-minute one every 12", async () => {
    const w = world();
    const fast = await tenant({ plan: "hosted_fast", nextAt: T0 });
    const slow = await tenant({ plan: "hosted", nextAt: T0 });
    const counts = new Map<string, number>();
    for (let minute = 0; minute < 24; minute++) {
      const { messages } = await tick(w);
      for (const m of messages) counts.set(m.tenantId, (counts.get(m.tenantId) ?? 0) + 1);
      // The queue leases expire on their own: the consumer would have run them.
      await env.PLATFORM_DB.prepare("UPDATE tenants SET schedule_lease_until = NULL").run();
      w.clock.now += MINUTE;
    }
    expect(counts.get(fast)).toBe(24);
    expect(counts.get(slow)).toBe(2);
  });

  it("follows limit overrides as well as the plan", async () => {
    const w = world();
    const id = await tenant({ plan: "hosted", nextAt: T0, overrides: JSON.stringify({ minIntervalMinutes: 5 }) });
    await tick(w);
    expect((await scheduleRow(id)).schedule_next_at).toBe(T0 + 5 * MINUTE);
  });

  it("never claims a tenant twice when two crons overlap", async () => {
    const w = world();
    const ids = [await tenant({ nextAt: T0 }), await tenant({ nextAt: T0 }), await tenant({ nextAt: T0 })];
    await Promise.all([enqueueDue(w.deps, w.queue, T0), enqueueDue(w.deps, w.queue, T0)]);
    expect(w.sent.map((m) => m.tenantId).sort()).toEqual([...ids].sort());
  });

  it("works through more due tenants than one round holds", async () => {
    const w = world();
    for (let i = 0; i < 230; i++) await tenant({ nextAt: T0 - MINUTE });
    const { enqueued } = await tick(w);
    expect(enqueued).toMatchObject({ sent: 230, rounds: 3 });
    expect(new Set(w.sent.map((m) => m.tenantId)).size).toBe(230);
  });

  it("gives the claims back when the queue refuses the batch", async () => {
    const w = world();
    const id = await tenant({ nextAt: T0 - MINUTE });
    w.queueFails.on = true;
    const { enqueued } = await tick(w);
    expect(enqueued).toMatchObject({ sent: 0, returned: 1 });
    expect(await scheduleRow(id)).toEqual({ schedule_next_at: T0 - MINUTE, schedule_claim: null, schedule_running: null, schedule_lease_until: null });
    w.queueFails.on = false;
    expect((await tick(w)).messages.map((m) => m.tenantId)).toEqual([id]);
  });

  it("doesn't claim a tenant while its run holds the lease, even when it is due again", async () => {
    const w = world();
    const id = await tenant({ plan: "hosted_fast", nextAt: T0 });
    w.dispatcher.register(`t-${id}`, openPing());
    const { messages } = await tick(w);
    // Started, not finished: the run lease is live.
    await env.PLATFORM_DB.prepare("UPDATE tenants SET schedule_running = 'x', schedule_lease_until = ?, schedule_next_at = ? WHERE id = ?")
      .bind(T0 + 50_000, T0, id)
      .run();
    w.clock.now = T0 + 30_000;
    expect((await tick(w)).messages).toEqual([]);
    w.clock.now = T0 + 50_000;
    expect((await tick(w)).messages.map((m) => m.tenantId)).toEqual([id]);
    expect(messages).toHaveLength(1);
  });
});

describe("the consumer", () => {
  it("calls the tenant's scheduled path with fresh props and call id, and records the run", async () => {
    const w = world();
    const id = await tenant({ plan: "hosted_fast", nextAt: T0 - 2_000 });
    w.dispatcher.register(`t-${id}`, openPing());
    const { messages } = await tick(w);
    w.clock.now += 1_500;
    const first = batchOf(messages);
    expect(await handleScheduleBatch(w.deps, first.batch)).toEqual([{ kind: "ran", tenantId: id, outcome: "ran", retried: false }]);
    expect(first.acks).toEqual([id]);

    const call = w.dispatcher.calls.at(-1)!;
    expect(call.scriptName).toBe(`t-${id}`);
    expect(call.props.invocation).toBe("platform");
    expect(call.request.headers.get(INTERNAL_HEADER)).toBe(call.props.callId);
    expect(call.props.tenant.limits.minIntervalMinutes).toBe(1);
    expect(call.limits).toEqual({ cpuMs: 15_000, subRequests: 1_000 });
    expect(await call.request.json()).toEqual({ runId: messages[0]!.runId, scheduledTime: T0, cron: "* * * * *" });

    expect(await stats(id)).toMatchObject({
      last_run_id: messages[0]!.runId,
      last_outcome: "ran",
      last_tenant_ms: 120,
      last_lag_ms: 3_500,
      last_checked: 4,
      last_failures: 1,
      last_d1_queries: 9,
      last_version: "0.15.0",
      last_error: null,
      streak: 0,
      day_runs: 1,
      day_checked: 4,
    });

    // The next minute, a new call id and the same tenant's fresh props.
    await env.PLATFORM_DB.prepare("UPDATE tenants SET plan = 'hosted' WHERE id = ?").bind(id).run();
    w.clock.now = T0 + MINUTE;
    const second = await tick(w);
    await handleScheduleBatch(w.deps, batchOf(second.messages).batch);
    const next = w.dispatcher.calls.at(-1)!;
    expect(next.props.callId).not.toBe(call.props.callId);
    expect(next.props.tenant.plan).toBe("hosted");
    expect(next.props.tenant.limits.minIntervalMinutes).toBe(12);
    expect(await stats(id)).toMatchObject({ day_runs: 2, day_checked: 8, day_d1_queries: 18 });
  });

  it("runs a message only once, however often the queue delivers it", async () => {
    const w = world();
    const id = await tenant({ nextAt: T0 });
    w.dispatcher.register(`t-${id}`, openPing());
    const { messages } = await tick(w);
    await handleScheduleBatch(w.deps, batchOf(messages).batch);
    const again = batchOf(messages);
    expect(await handleScheduleBatch(w.deps, again.batch)).toEqual([{ kind: "skipped", tenantId: id, reason: "duplicate" }]);
    expect(again.acks).toEqual([id]);
    expect(w.dispatcher.calls).toHaveLength(1);
  });

  it("starts one of two copies delivered at the same moment", async () => {
    const w = world();
    const id = await tenant({ nextAt: T0 });
    let running = 0;
    let most = 0;
    w.dispatcher.register(
      `t-${id}`,
      openPing(async () => {
        running++;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
        return {};
      }),
    );
    const { messages } = await tick(w);
    const results = await handleScheduleBatch(w.deps, batchOf([messages[0]!, messages[0]!]).batch);
    expect(results.map((r) => r.kind).sort()).toEqual(["ran", "skipped"]);
    expect(most).toBe(1);
  });

  it("drops a message a newer claim replaced", async () => {
    const w = world();
    const id = await tenant({ nextAt: T0 });
    w.dispatcher.register(`t-${id}`, openPing());
    const { messages } = await tick(w);
    await env.PLATFORM_DB.prepare("UPDATE tenants SET schedule_claim = 'newer' WHERE id = ?").bind(id).run();
    expect(await handleScheduleBatch(w.deps, batchOf(messages).batch)).toEqual([{ kind: "skipped", tenantId: id, reason: "stale" }]);
    expect(w.dispatcher.calls).toHaveLength(0);
  });

  it("skips a tenant suspended after it was claimed, by billing or by the owner", async () => {
    const w = world();
    const a = await tenant({ nextAt: T0 });
    const b = await tenant({ nextAt: T0 });
    const { messages } = await tick(w);
    await env.PLATFORM_DB.prepare("UPDATE tenants SET status = 'suspended' WHERE id = ?").bind(a).run();
    await env.PLATFORM_DB.prepare("UPDATE tenants SET owner_suspended_at = ? WHERE id = ?").bind(T0, b).run();
    const results = await handleScheduleBatch(w.deps, batchOf(messages).batch);
    expect(results.map((r) => (r.kind === "skipped" ? r.reason : r.kind))).toEqual(["not_runnable", "not_runnable"]);
    expect(w.dispatcher.calls).toHaveLength(0);
  });

  it("retries a call that got no answer, with backoff, while the retry fits before the next run", async () => {
    const w = world();
    const id = await tenant({ plan: "hosted", nextAt: T0 });
    w.dispatcher.register(`t-${id}`, openPing(() => new Response("boom", { status: 500 })));
    const { messages } = await tick(w);
    const first = batchOf(messages, 1);
    expect(await handleScheduleBatch(w.deps, first.batch)).toEqual([{ kind: "ran", tenantId: id, outcome: "error", retried: true }]);
    expect(first.retries).toEqual([{ tenantId: id, delaySeconds: 15 }]);
    expect((await scheduleRow(id)).schedule_lease_until).toBe(T0 + 15_000 + 200 + 10_000);
    expect(await stats(id)).toMatchObject({ last_outcome: "error", last_error: "HTTP 500", streak: 1, day_errors: 1 });

    // The queue delivers it again (attempt 2); the same run, a new attempt.
    w.clock.now += 15_000;
    const second = batchOf(messages, 2);
    await handleScheduleBatch(w.deps, second.batch);
    expect(second.retries).toEqual([{ tenantId: id, delaySeconds: 60 }]);
    expect(w.dispatcher.calls).toHaveLength(2);
    expect(await stats(id)).toMatchObject({ streak: 2, day_runs: 2, day_errors: 2 });

    // Past the attempts: given up, the next run is the retry.
    const last = batchOf(messages, 4);
    await handleScheduleBatch(w.deps, last.batch);
    expect(last.retries).toEqual([]);
    expect(last.acks).toEqual([id]);

    // A clean run resets the streak.
    w.dispatcher.register(`t-${id}`, openPing());
    w.clock.now = T0 + 12 * MINUTE;
    await env.PLATFORM_DB.prepare("UPDATE tenants SET schedule_lease_until = NULL WHERE id = ?").bind(id).run();
    await handleScheduleBatch(w.deps, batchOf((await tick(w)).messages).batch);
    expect(await stats(id)).toMatchObject({ last_outcome: "ran", streak: 0, last_error: null });
  });

  it("doesn't retry a 1-minute tenant: its next run comes sooner", async () => {
    const w = world();
    const id = await tenant({ plan: "hosted_fast", nextAt: T0 });
    w.deps.callTimeoutMs = () => 40_000;
    const { messages } = await tick(w);
    // No user Worker at all: a ready tenant whose script is missing.
    const run = batchOf(messages);
    expect(await handleScheduleBatch(w.deps, run.batch)).toEqual([{ kind: "ran", tenantId: id, outcome: "error", retried: false }]);
    expect(run.retries).toEqual([]);
    expect(await stats(id)).toMatchObject({ last_error: `user Worker t-${id} is not in the namespace` });
  });

  it("gives up on a tenant that doesn't answer in time", async () => {
    const w = world();
    const id = await tenant({ nextAt: T0 });
    w.dispatcher.register(`t-${id}`, openPing(() => new Promise<never>(() => {})));
    const { messages } = await tick(w);
    const run = batchOf(messages);
    expect(await handleScheduleBatch(w.deps, run.batch)).toEqual([{ kind: "ran", tenantId: id, outcome: "timeout", retried: true }]);
    expect(await stats(id)).toMatchObject({ last_outcome: "timeout", last_error: "no answer in 0 s" });
    // The call carried an abort signal that the timeout fired.
    expect(w.dispatcher.calls[0]!.request.signal.aborted).toBe(true);
  });

  it("records the tenant's own failure as an answer, without a retry", async () => {
    const w = world();
    const id = await tenant({ nextAt: T0 });
    w.dispatcher.register(`t-${id}`, openPing(() => ({ outcome: "failed", error: "migration 0023 failed", checked: 0, failures: 0 })));
    const run = batchOf((await tick(w)).messages);
    expect(await handleScheduleBatch(w.deps, run.batch)).toEqual([{ kind: "ran", tenantId: id, outcome: "failed", retried: false }]);
    expect(run.retries).toEqual([]);
    expect(await stats(id)).toMatchObject({ last_outcome: "failed", last_error: "migration 0023 failed", streak: 1 });
  });

  it("refuses an answer that isn't a summary of this run", async () => {
    const w = world();
    const id = await tenant({ nextAt: T0 });
    w.dispatcher.register(`t-${id}`, openPing(() => Response.json({ runId: "someone-else", outcome: "ran" })));
    await handleScheduleBatch(w.deps, batchOf((await tick(w)).messages).batch);
    expect(await stats(id)).toMatchObject({ last_outcome: "error", last_error: "the answer wasn't a run summary" });
  });

  it("waits for the tenant's nextDueAt when it has nothing due sooner", async () => {
    const w = world();
    const id = await tenant({ plan: "hosted_fast", nextAt: T0 });
    w.dispatcher.register(`t-${id}`, openPing(() => ({ nextDueAt: T0 + 5 * MINUTE }) as Partial<ScheduledRunSummary>));
    await handleScheduleBatch(w.deps, batchOf((await tick(w)).messages).batch);
    expect((await scheduleRow(id)).schedule_next_at).toBe(T0 + 5 * MINUTE);
    for (let m = 1; m < 5; m++) {
      w.clock.now = T0 + m * MINUTE;
      expect((await tick(w)).messages).toEqual([]);
    }
    w.clock.now = T0 + 5 * MINUTE;
    expect((await tick(w)).messages).toHaveLength(1);
  });

  it("keeps a day's totals, and moves them to scheduler_days on the next day", async () => {
    const w = world();
    const id = await tenant({ nextAt: T0 });
    w.dispatcher.register(`t-${id}`, openPing());
    await handleScheduleBatch(w.deps, batchOf((await tick(w)).messages).batch);
    w.clock.now = T0 + DAY_MS;
    await env.PLATFORM_DB.prepare("UPDATE tenants SET schedule_lease_until = NULL WHERE id = ?").bind(id).run();
    await handleScheduleBatch(w.deps, batchOf((await tick(w)).messages).batch);
    const days = await env.PLATFORM_DB.prepare("SELECT day, runs, checked, d1_queries FROM scheduler_days WHERE tenant_id = ?").bind(id).all();
    expect(days.results).toEqual([{ day: Math.floor(T0 / DAY_MS), runs: 1, checked: 4, d1_queries: 9 }]);
    expect(await stats(id)).toMatchObject({ day: Math.floor(T0 / DAY_MS) + 1, day_runs: 1 });
  });

  it("acks a malformed message without calling anyone", async () => {
    const w = world();
    const { batch, acks } = batchOf([{ tenantId: "nope" } as unknown as ScheduleMessage]);
    expect(await handleScheduleBatch(w.deps, batch)).toEqual([{ kind: "skipped", tenantId: "", reason: "invalid" }]);
    expect(acks).toEqual(["nope"]);
  });
});
