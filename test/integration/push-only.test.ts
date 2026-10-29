import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import type { Env } from "../../src/worker/types";
import { createMonitorSchema } from "../../src/shared/schemas";
import { createMonitor } from "../../src/worker/db/monitors";
import { openIncident } from "../../src/worker/db/incidents";
import { upsertSubscription } from "../../src/worker/db/push";
import { ensureVapidPublicKey } from "../../src/worker/notifications/push/vapid";
import { enqueueIncidentEvent } from "../../src/worker/notifications/enqueue";
import { generateMasterKey } from "../../src/worker/lib/crypto";

// Someone whose only alerts are push notifications on their phone (no Slack,
// email or webhook channel at all) still gets an alert when a monitor goes down.

const ENV = { ...env, MASTER_KEY: generateMasterKey() } as Env;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  for (const table of ["notification_outbox", "push_subscriptions", "notification_channels", "incidents", "monitor_state", "monitors", "settings"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await ensureVapidPublicKey(ENV);
});

describe("push devices with no other alert channel", () => {
  it("get the alert", async () => {
    const device = await upsertSubscription(ENV, {
      endpoint: "https://push.example.com/send/phone",
      p256dh: "p256dh",
      auth: "auth",
      userAgent: "Chrome on Android",
    });
    const monitor = await createMonitor(
      ENV,
      createMonitorSchema.parse({ type: "http", name: "App", config: { url: "https://app.example.com" } }),
    );
    const incident = await openIncident(ENV, monitor, { at: Date.now(), error: "http_error", httpStatus: 503 });

    await enqueueIncidentEvent(ENV, monitor, incident, "down");

    const { results } = await env.DB.prepare(
      "SELECT channel_type, target FROM notification_outbox WHERE monitor_id = ?",
    )
      .bind(monitor.id)
      .all<{ channel_type: string; target: string }>();
    expect(results).toEqual([{ channel_type: "push", target: device.id }]);
  });
});
