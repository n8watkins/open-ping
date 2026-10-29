import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/types";
import { createMonitorSchema } from "../../src/shared/schemas";
import { createMonitor } from "../../src/worker/db/monitors";
import { openIncident } from "../../src/worker/db/incidents";
import { enqueueIncidentEvent } from "../../src/worker/notifications/enqueue";
import { processOutbox } from "../../src/worker/notifications/dispatcher";
import { forgetFcmTokens } from "../../src/worker/notifications/push/fcm";
import { generateMasterKey } from "../../src/worker/lib/crypto";
import { createFakeFcm, FAKE_PROJECT, type FakeFcm } from "../support/fake-fcm";

/**
 * Alerts to the OpenPing Android app through FCM, end to end through the real
 * Worker and D1, with a fake FCM: registering the app, an incident reaching
 * it with no other channel, a test send, and a phone that uninstalled the app.
 */

const API_TOKEN = "integration-api-token";
const TOKEN = `phone-token-${"b".repeat(150)}`;
let fake: FakeFcm;
let ENV: Env;
const OFF = { ...env, MASTER_KEY: generateMasterKey() } as Env;

async function call(target: Env, path: string, init: RequestInit & { json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${API_TOKEN}`);
  headers.set("user-agent", "Mozilla/5.0 (Linux; Android 14) Chrome/131 Mobile Safari/537.36 OpenPingApp/1.0.0 (Android)");
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  return worker.fetch(
    new Request(`https://openping.test${path}`, { method: init.method ?? (body ? "POST" : "GET"), headers, body }),
    target,
    createExecutionContext(),
  );
}

const register = (target: Env, json: unknown) => call(target, "/api/push/fcm", { method: "POST", json });

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["notification_outbox", "push_subscriptions", "notification_channels", "incidents", "monitor_state", "monitors", "settings"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  fake = await createFakeFcm();
  ENV = { ...OFF, FCM_SERVICE_ACCOUNT: fake.serviceAccountJson } as Env;
  forgetFcmTokens();
  vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function downIncident(target: Env) {
  const monitor = await createMonitor(
    target,
    createMonitorSchema.parse({ type: "http", name: "App", config: { url: "https://app.example.com" } }),
  );
  const incident = await openIncident(target, monitor, { at: Date.now(), error: "http_error", httpStatus: 503 });
  await enqueueIncidentEvent(target, monitor, incident, "down");
  return { monitor, incident };
}

describe("the Android app's notifications", () => {
  it("are off, and refuse a phone, on an install without a Firebase service account", async () => {
    expect(await (await call(OFF, "/api/push/fcm")).json()).toEqual({ available: false, projectId: null });
    const res = await register(OFF, { token: TOKEN, projectId: FAKE_PROJECT });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "fcm_not_configured" });
  });

  it("register a phone once, as a push device without its token", async () => {
    expect(await (await call(ENV, "/api/push/fcm")).json()).toEqual({ available: true, projectId: FAKE_PROJECT });
    const first = await register(ENV, { token: TOKEN, projectId: FAKE_PROJECT, label: "Pixel 8" });
    expect(first.status).toBe(201);
    const { device } = await first.json<{ device: Record<string, unknown> }>();
    expect(device).toMatchObject({ kind: "fcm", label: "OpenPing app on Pixel 8", platform: "android", disabled: false });
    expect(JSON.stringify(device)).not.toContain(TOKEN);

    const again = await (await register(ENV, { token: TOKEN, projectId: FAKE_PROJECT, label: "Pixel 8" })).json<{ device: { id: string } }>();
    expect(again.device.id).toBe(device.id);

    const { devices } = await (await call(ENV, "/api/push/devices")).json<{ devices: Array<Record<string, unknown>> }>();
    expect(devices).toEqual([expect.objectContaining({ id: device.id, kind: "fcm" })]);
    // The token is sealed at rest.
    const row = await env.DB.prepare("SELECT endpoint FROM push_subscriptions").first<{ endpoint: string }>();
    expect(row!.endpoint).not.toContain(TOKEN);
  });

  it("refuse a token from another Firebase project, and anything that isn't a token", async () => {
    const other = await register(ENV, { token: TOKEN, projectId: "someone-else-1" });
    expect(other.status).toBe(409);
    expect(await other.json()).toEqual({ error: "fcm_project_mismatch", projectId: FAKE_PROJECT });
    expect((await register(ENV, { token: "x", projectId: FAKE_PROJECT })).status).toBe(400);
  });

  it("bring an incident to the phone, with no other channel, opening the same page Web Push does on tap", async () => {
    await register(ENV, { token: TOKEN, projectId: FAKE_PROJECT });
    const { monitor, incident } = await downIncident(ENV);

    const result = await processOutbox(ENV);
    expect(result).toMatchObject({ sent: 1, failed: 0 });
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.token).toBe(TOKEN);
    expect(fake.sent[0]!.data).toMatchObject({
      kind: "alert",
      origin: "https://openping.test",
      url: `https://openping.test/monitors/${monitor.id}`,
      tag: incident.id,
    });
    expect(fake.sent[0]!.data.title).toContain("App");
  });

  it("aren't queued once the install's Firebase key is gone", async () => {
    await register(ENV, { token: TOKEN, projectId: FAKE_PROJECT });
    await downIncident(OFF);
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox").first<{ n: number }>())!;
    expect(n).toBe(0);
  });

  it("forget a phone that uninstalled the app", async () => {
    await register(ENV, { token: TOKEN, projectId: FAKE_PROJECT });
    fake.unregistered.add(TOKEN);
    await downIncident(ENV);
    await processOutbox(ENV);
    expect(fake.sent).toHaveLength(0);
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first<{ n: number }>())!;
    expect(n).toBe(0);
  });

  it("stay off once turned off or removed, however often the app refreshes", async () => {
    const { device } = await (await register(ENV, { token: TOKEN, projectId: FAKE_PROJECT })).json<{ device: { id: string } }>();
    const refresh = (token: string, extra: Record<string, unknown> = {}) =>
      register(ENV, { token, projectId: FAKE_PROJECT, refresh: true, ...extra });

    // Turned off under Push devices: a refresh keeps it off.
    expect((await call(ENV, `/api/push/devices/${device.id}/disable`, { method: "POST" })).status).toBe(200);
    const kept = await refresh(TOKEN);
    expect(kept.status).toBe(200);
    expect((await kept.json<{ device: { disabled: boolean } }>()).device.disabled).toBe(true);

    // Turned on again by a person tapping "Turn on for this phone".
    const on = await register(ENV, { token: TOKEN, projectId: FAKE_PROJECT });
    expect((await on.json<{ device: { disabled: boolean } }>()).device.disabled).toBe(false);

    // Firebase changed the token: the refresh moves the same row to the new one.
    const NEW = `${TOKEN}-rotated`;
    const moved = await (await refresh(NEW, { previousToken: TOKEN })).json<{ device: { id: string } }>();
    expect(moved.device.id).toBe(device.id);
    await downIncident(ENV);
    await processOutbox(ENV);
    expect(fake.sent.map((m) => m.token)).toEqual([NEW]);

    // Removed: the refresh says so and adds nothing back.
    expect((await call(ENV, `/api/push/devices/${device.id}`, { method: "DELETE" })).status).toBe(200);
    const gone = await refresh(NEW);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: "fcm_device_removed" });
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first<{ n: number }>())!;
    expect(n).toBe(0);
  });

  it("are forgotten when the app removes the install, and capped at 20 phones", async () => {
    await register(ENV, { token: TOKEN, projectId: FAKE_PROJECT });
    const del = await call(ENV, "/api/push/fcm", { method: "DELETE", json: { token: TOKEN } });
    expect(del.status).toBe(200);
    expect((await call(ENV, "/api/push/fcm", { method: "DELETE", json: { token: TOKEN } })).status).toBe(404);

    for (let i = 0; i < 20; i++) {
      expect((await register(ENV, { token: `${TOKEN}-${i}`, projectId: FAKE_PROJECT })).status).toBe(201);
    }
    const over = await register(ENV, { token: `${TOKEN}-20`, projectId: FAKE_PROJECT });
    expect(over.status).toBe(409);
    expect(await over.json()).toEqual({ error: "fcm_device_limit", limit: 20 });
    // A phone already on the list still refreshes.
    expect((await register(ENV, { token: `${TOKEN}-3`, projectId: FAKE_PROJECT })).status).toBe(201);
  });

  it("send a test notification from Integrations", async () => {
    const { device } = await (await register(ENV, { token: TOKEN, projectId: FAKE_PROJECT })).json<{ device: { id: string } }>();
    const res = await call(ENV, `/api/push/devices/${device.id}/test`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(fake.sent).toEqual([expect.objectContaining({ token: TOKEN, data: expect.objectContaining({ title: "✅ OpenPing test" }) })]);
  });
});
