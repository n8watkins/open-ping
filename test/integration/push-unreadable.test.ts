import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/types";
import { createMonitorSchema } from "../../src/shared/schemas";
import { createMonitor } from "../../src/worker/db/monitors";
import { createChannel } from "../../src/worker/db/channels";
import { openIncident } from "../../src/worker/db/incidents";
import { upsertSubscription } from "../../src/worker/db/push";
import { ensureVapidPublicKey } from "../../src/worker/notifications/push/vapid";
import { enqueueIncidentEvent } from "../../src/worker/notifications/enqueue";
import { processOutbox } from "../../src/worker/notifications/dispatcher";
import { generateMasterKey } from "../../src/worker/lib/crypto";

// A push device sealed under a key this install no longer has (a lost
// MASTER_KEY) must not break the device list, removing it, or an incident's
// other notifications.

const API_TOKEN = "integration-api-token";
const KEY = generateMasterKey();
/** The key the unreadable device was sealed with; never configured. */
const LOST_KEY = generateMasterKey();
const ENV = { ...env, MASTER_KEY: KEY } as Env;

async function call(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${API_TOKEN}`);
  return worker.fetch(
    new Request(`https://openping.test${path}`, { ...init, headers }),
    ENV,
    createExecutionContext(),
  );
}

let readableId = "";
let unreadableId = "";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  for (const table of ["notification_outbox", "push_subscriptions", "notification_channels", "incidents", "monitor_state", "monitors", "settings"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await ensureVapidPublicKey(ENV);
  const device = { p256dh: "p256dh", auth: "auth", userAgent: "Firefox" };
  readableId = (await upsertSubscription(ENV, { ...device, endpoint: "https://push.example.com/send/ok" })).id;
  unreadableId = (
    await upsertSubscription({ ...env, MASTER_KEY: LOST_KEY } as Env, {
      ...device,
      endpoint: "https://push.example.com/send/lost",
    })
  ).id;
});

describe("a push device that can't be decrypted", () => {
  it("is still listed, without any push secrets", async () => {
    const res = await call("/api/push/devices");
    expect(res.status).toBe(200);
    const { devices } = await res.json<{ devices: Record<string, unknown>[] }>();
    expect(devices.map((d) => d.id).sort()).toEqual([readableId, unreadableId].sort());
    for (const d of devices) {
      expect(d).not.toHaveProperty("endpoint");
      expect(d).not.toHaveProperty("p256dh");
      expect(d).not.toHaveProperty("auth");
    }
  });

  it("doesn't stop an incident's other alerts, and its delivery stops at once", async () => {
    await createChannel(ENV, {
      type: "webhook",
      name: "Hook",
      config: { url: "https://hooks.example.com/alert" },
    } as Parameters<typeof createChannel>[1]);
    const monitor = await createMonitor(
      ENV,
      createMonitorSchema.parse({ type: "http", name: "App", config: { url: "https://app.example.com" } }),
    );
    const incident = await openIncident(ENV, monitor, { at: Date.now(), error: "http_error", httpStatus: 503 });
    await enqueueIncidentEvent(ENV, monitor, incident, "down");

    const queued = await env.DB.prepare(
      "SELECT channel_type, target FROM notification_outbox ORDER BY channel_type, target",
    ).all<{ channel_type: string; target: string | null }>();
    expect(queued.results.map((r) => r.channel_type).sort()).toEqual(["push", "push", "webhook"]);

    // Deliver only the unreadable device's entry: it fails for good, with no retry.
    const lost = await env.DB.prepare("SELECT * FROM notification_outbox WHERE target = ?")
      .bind(unreadableId)
      .first<{ id: string }>();
    await env.DB.prepare("UPDATE notification_outbox SET next_attempt_at = ? WHERE id <> ?")
      .bind(Date.now() + 3_600_000, lost!.id)
      .run();
    await processOutbox(ENV, Date.now() + 1000);
    const after = await env.DB.prepare("SELECT status, last_error FROM notification_outbox WHERE id = ?")
      .bind(lost!.id)
      .first<{ status: string; last_error: string }>();
    expect(after).toEqual({ status: "dead", last_error: "subscription_unreadable" });
  });

  it("can be removed", async () => {
    expect((await call(`/api/push/devices/${unreadableId}`, { method: "DELETE" })).status).toBe(200);
    const res = await call("/api/push/devices");
    const { devices } = await res.json<{ devices: { id: string }[] }>();
    expect(devices.map((d) => d.id)).toEqual([readableId]);
  });
});
