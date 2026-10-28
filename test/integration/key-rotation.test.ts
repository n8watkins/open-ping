import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/types";
import { createMonitorSchema } from "../../src/shared/schemas";
import { createMonitor, getMonitor } from "../../src/worker/db/monitors";
import { createChannel, listChannels } from "../../src/worker/db/channels";
import { listSubscriptions, upsertSubscription } from "../../src/worker/db/push";
import { enqueue, outboxEntriesFromRows, type OutboxRow } from "../../src/worker/db/outbox";
import { ensureVapidPublicKey, getVapid } from "../../src/worker/notifications/push/vapid";
import { b64decode, b64encode, encryptValue, generateMasterKey, keyIdFor } from "../../src/worker/lib/crypto";
import type { BatchResult, RekeyStatus, Unreadable } from "../../src/worker/lib/rekey";

const API_ORIGIN = "https://openping.test";
const API_TOKEN = "integration-api-token";

const KEY_A = generateMasterKey();
const KEY_B = generateMasterKey();
/** A key that is never configured: its values must be reported, never rewritten. */
const KEY_C = generateMasterKey();

const envWith = (current: string, previous?: string): Env =>
  ({ ...env, MASTER_KEY: current, MASTER_KEY_PREVIOUS: previous }) as Env;
const ENV_A = envWith(KEY_A);
const ENV_ROTATING = envWith(KEY_B, KEY_A);
const ENV_B = envWith(KEY_B);

/** Call the real Worker (routing, auth middleware) with a chosen set of secrets. */
async function call(target: Env, path: string, init: RequestInit = {}, auth = true) {
  const headers = new Headers(init.headers);
  if (auth) headers.set("authorization", `Bearer ${API_TOKEN}`);
  if (init.body) headers.set("content-type", "application/json");
  return worker.fetch(
    new Request(`${API_ORIGIN}${path}`, { ...init, headers }),
    target,
    createExecutionContext(),
  );
}

async function status(target: Env): Promise<RekeyStatus> {
  const res = await call(target, "/api/admin/rekey/status");
  expect(res.status).toBe(200);
  return res.json<RekeyStatus>();
}

/** Run the pass to completion in small batches, as the Settings page does. */
async function runPass(target: Env, limit: number) {
  let cursor: string | null = null;
  const batches: BatchResult[] = [];
  do {
    const res = await call(target, "/api/admin/rekey", {
      method: "POST",
      body: JSON.stringify({ cursor, limit }),
    });
    expect(res.status).toBe(200);
    const batch = await res.json<BatchResult>();
    batches.push(batch);
    cursor = batch.cursor;
    expect(batches.length).toBeLessThan(200);
  } while (cursor);
  const total = (k: keyof BatchResult["stats"]) => batches.reduce((n, b) => n + b.stats[k], 0);
  return {
    batches,
    scanned: total("scanned"),
    rewritten: total("rewritten"),
    reencrypted: total("reencrypted"),
    sealed: total("sealed"),
    conflicts: total("conflicts"),
    unreadable: batches.flatMap((b) => b.unreadable),
  };
}

/** The original v1 format, as releases before key ids wrote it. */
async function encryptV1(key: string, plaintext: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", b64decode(key), { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode(plaintext));
  return `v1:${b64encode(iv)}:${b64encode(ct)}`;
}

// Fixture credentials are made per run, so no literal in the repo looks like a
// real one to secret scanners.
const fixture = (name: string) => `${name}-${crypto.randomUUID()}`;
const MONITOR_BASIC_AUTH = [0, 1, 2].map((i) => fixture(`basic-${i}`));
const LEGACY_MONITOR_BASIC_AUTH = fixture("legacy-basic");
const LEGACY_MONITOR_TOKEN = fixture("legacy-field");
const WEBHOOK_URLS = ["https://hooks.example.com/a?cap=1", "https://hooks.example.com/b?cap=2"];
const LEGACY_WEBHOOK_URL = "https://hooks.example.com/legacy?cap=3";
const LEGACY_WEBHOOK_HMAC = fixture("legacy-hmac");
const OUTBOX_V2_COUNT = 20;
// One channel of each chat-app type, each with one encrypted capability.
const CHAT_CHANNELS = [
  { type: "slack", config: { url: `https://hooks.slack.com/services/T0/B0/${fixture("slack")}` }, field: "url" },
  {
    type: "teams",
    config: { url: `https://contoso.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/w1/triggers/manual/paths/invoke?sig=${fixture("teams")}` },
    field: "url",
  },
  { type: "telegram", config: { botToken: `${Date.now()}:${crypto.randomUUID().replaceAll("-", "")}`, chatId: "-100123" }, field: "botToken" },
] as const;

interface Seeded {
  monitorIds: string[];
  legacyMonitorId: string;
  channelIds: string[];
  legacyChannelId: string;
  strangerChannelId: string;
  chatChannelIds: string[];
  pushIds: string[];
  legacyPushId: string;
  vapidPrivateKey: string;
  outboxPayloads: Map<string, unknown>;
  strangerOutboxIds: string[];
  strangerRaw: Map<string, string>;
}

const seeded = {} as Seeded;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  for (const table of ["notification_outbox", "push_subscriptions", "notification_channels", "monitor_state", "monitors", "settings"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }

  // --- Monitor configuration: three sealed under A, one legacy unsealed with a
  // plaintext password and a field-level v1 token under A.
  seeded.monitorIds = [];
  for (const [i, password] of MONITOR_BASIC_AUTH.entries()) {
    const created = await createMonitor(
      ENV_A,
      createMonitorSchema.parse({
        type: "http",
        name: `Sealed ${i}`,
        config: { url: `https://app${i}.example.com/health`, auth: { type: "basic", username: "u", password } },
      }),
    );
    seeded.monitorIds.push(created.id);
  }
  const legacy = await createMonitor(
    ENV_A,
    createMonitorSchema.parse({ type: "http", name: "Legacy", config: { url: "https://legacy.example.com" } }),
  );
  seeded.legacyMonitorId = legacy.id;
  await env.DB.prepare("UPDATE monitors SET config = ? WHERE id = ?")
    .bind(
      JSON.stringify({
        url: "https://legacy.example.com",
        method: "GET",
        headers: [],
        auth: { type: "basic", username: "u", password: LEGACY_MONITOR_BASIC_AUTH },
        secret: await encryptV1(KEY_A, LEGACY_MONITOR_TOKEN),
      }),
      legacy.id,
    )
    .run();

  // --- Notification-channel capabilities: two under A (v2), one legacy (v1 URL
  // under A, plaintext HMAC secret), one under the unknown key C.
  seeded.channelIds = [];
  for (const [i, url] of WEBHOOK_URLS.entries()) {
    const ch = await createChannel(ENV_A, { type: "webhook", name: `Hook ${i}`, config: { url, secret: `s-${i}` } });
    seeded.channelIds.push(ch.id);
  }
  const legacyChannel = await createChannel(ENV_A, { type: "email", config: { to: "ops@example.com" } });
  seeded.legacyChannelId = legacyChannel.id;
  await env.DB.prepare("UPDATE notification_channels SET type = 'webhook', config = ? WHERE id = ?")
    .bind(JSON.stringify({ url: await encryptV1(KEY_A, LEGACY_WEBHOOK_URL), secret: LEGACY_WEBHOOK_HMAC }), legacyChannel.id)
    .run();
  const stranger = await createChannel(envWith(KEY_C), {
    type: "discord",
    name: "Under an unknown key",
    config: { url: "https://discord.com/api/webhooks/1/x" },
  });
  seeded.strangerChannelId = stranger.id;
  seeded.chatChannelIds = [];
  for (const ch of CHAT_CHANNELS) {
    const created = await createChannel(ENV_A, { type: ch.type, config: { ...ch.config } });
    seeded.chatChannelIds.push(created.id);
  }

  // --- Web Push subscriptions: two under A, one from before migration 0008
  // (plaintext, no endpoint digest).
  seeded.pushIds = [];
  for (const i of [0, 1]) {
    const sub = await upsertSubscription(ENV_A, {
      endpoint: `https://push.example.com/send/${i}`,
      p256dh: `p256dh-${i}`,
      auth: `auth-${i}`,
    });
    seeded.pushIds.push(sub.id);
  }
  seeded.legacyPushId = "psub_legacy";
  await env.DB.prepare(
    "INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(seeded.legacyPushId, "https://push.example.com/send/legacy", "p256dh-legacy", "auth-legacy", Date.now())
    .run();

  // --- The generated VAPID private key, encrypted under A.
  await ensureVapidPublicKey(ENV_A);
  seeded.vapidPrivateKey = (await getVapid(ENV_A))!.privateKey;

  // --- Outbox payloads: twenty under A (v2), three v1 under A, two plaintext,
  // and two under the unknown key C (one v2, one v1).
  seeded.outboxPayloads = new Map();
  await enqueue(
    ENV_A,
    Array.from({ length: OUTBOX_V2_COUNT }, (_, i) => ({
      eventKey: `rotation:v2:${i}`,
      channelType: "webhook",
      eventType: "test",
      payload: { n: i },
    })),
  );
  const insertOutbox = (id: string, payload: string) =>
    env.DB.prepare(
      `INSERT INTO notification_outbox (id, event_key, channel_type, event_type, payload, status, created_at, updated_at)
       VALUES (?, ?, 'webhook', 'test', ?, 'sent', 0, 0)`,
    ).bind(id, `rotation:${id}`, payload);
  const extra: D1PreparedStatement[] = [];
  for (const i of [0, 1, 2]) {
    extra.push(insertOutbox(`out_v1_${i}`, await encryptV1(KEY_A, JSON.stringify({ legacy: i }))));
    seeded.outboxPayloads.set(`out_v1_${i}`, { legacy: i });
  }
  for (const i of [0, 1]) {
    extra.push(insertOutbox(`out_plain_${i}`, JSON.stringify({ plain: i })));
    seeded.outboxPayloads.set(`out_plain_${i}`, { plain: i });
  }
  extra.push(insertOutbox("out_stranger_v2", await encryptValue(envWith(KEY_C), "{}")));
  extra.push(insertOutbox("out_stranger_v1", await encryptV1(KEY_C, "{}")));
  await env.DB.batch(extra);
  seeded.strangerOutboxIds = ["out_stranger_v1", "out_stranger_v2"];
  const { results } = await env.DB.prepare(
    "SELECT id, payload FROM notification_outbox WHERE event_key LIKE 'rotation:v2:%'",
  ).all<{ id: string }>();
  const all = await outboxEntriesFromRows(ENV_A, (await env.DB.prepare(
    "SELECT * FROM notification_outbox WHERE event_key LIKE 'rotation:v2:%'",
  ).all<OutboxRow>()).results);
  for (const entry of all) seeded.outboxPayloads.set(entry.id, entry.payload);
  expect(results).toHaveLength(OUTBOX_V2_COUNT);

  seeded.strangerRaw = await strangerRows();
});

/** The raw stored values of everything sealed under the unknown key C. */
async function strangerRows(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ch = await env.DB.prepare("SELECT config FROM notification_channels WHERE id = ?")
    .bind(seeded.strangerChannelId)
    .first<{ config: string }>();
  out.set(seeded.strangerChannelId, ch!.config);
  for (const id of seeded.strangerOutboxIds) {
    const row = await env.DB.prepare("SELECT payload FROM notification_outbox WHERE id = ?").bind(id).first<{ payload: string }>();
    out.set(id, row!.payload);
  }
  return out;
}

const locations = (list: Unreadable[]) => list.map((u) => `${u.class}/${u.id}/${u.field}/${u.reason}`).sort();
const EXPECTED_UNREADABLE = () =>
  [
    `channel_secrets/${seeded.strangerChannelId}/url/unknown_key`,
    "outbox_payloads/out_stranger_v1/payload/decrypt_failed",
    "outbox_payloads/out_stranger_v2/payload/unknown_key",
  ].sort();

/** Everything a user relies on, read back through the normal data layer. */
async function expectEverythingReadable(target: Env) {
  for (const [i, id] of seeded.monitorIds.entries()) {
    const monitor = await getMonitor(target, id);
    expect((monitor!.config as { auth: { password: string } }).auth.password).toBe(MONITOR_BASIC_AUTH[i]);
  }
  const legacy = (await getMonitor(target, seeded.legacyMonitorId))!.config as Record<string, unknown>;
  expect((legacy.auth as { password: string }).password).toBe(LEGACY_MONITOR_BASIC_AUTH);
  expect(legacy.secret).toBe(LEGACY_MONITOR_TOKEN);

  const channels = new Map((await listChannels(target)).map((c) => [c.id, c.config]));
  for (const [i, id] of seeded.channelIds.entries()) {
    expect(channels.get(id)).toMatchObject({ url: WEBHOOK_URLS[i], secret: `s-${i}` });
  }
  expect(channels.get(seeded.legacyChannelId)).toMatchObject({
    url: LEGACY_WEBHOOK_URL,
    secret: LEGACY_WEBHOOK_HMAC,
  });

  for (const [i, ch] of CHAT_CHANNELS.entries()) {
    expect(channels.get(seeded.chatChannelIds[i]!)).toEqual(ch.config);
  }

  const subs = new Map((await listSubscriptions(target)).map((s) => [s.id, s]));
  for (const [i, id] of seeded.pushIds.entries()) {
    expect(subs.get(id)).toMatchObject({ endpoint: `https://push.example.com/send/${i}`, p256dh: `p256dh-${i}`, auth: `auth-${i}` });
  }
  expect(subs.get(seeded.legacyPushId)).toMatchObject({ endpoint: "https://push.example.com/send/legacy" });

  expect((await getVapid(target))!.privateKey).toBe(seeded.vapidPrivateKey);

  const rows = (await env.DB.prepare("SELECT * FROM notification_outbox").all<OutboxRow>()).results;
  const entries = await outboxEntriesFromRows(target, rows);
  for (const entry of entries) {
    if (seeded.strangerOutboxIds.includes(entry.id)) {
      // Still fails closed: never delivered, never dropped.
      expect(entry.payloadError).toBe("payload_decryption_failed");
    } else {
      expect(entry.payloadError).toBeNull();
      expect(entry.payload).toEqual(seeded.outboxPayloads.get(entry.id));
    }
  }
  expect(entries).toHaveLength(OUTBOX_V2_COUNT + 7);
}

describe("MASTER_KEY rotation", () => {
  it("requires an administrator", async () => {
    expect((await call(ENV_ROTATING, "/api/admin/rekey/status", {}, false)).status).toBe(401);
    expect((await call(ENV_ROTATING, "/api/admin/rekey", { method: "POST", body: "{}" }, false)).status).toBe(401);
  });

  it("refuses to run without a usable key configuration", async () => {
    const noKey = { ...env, MASTER_KEY: undefined } as Env;
    const res = await call(noKey, "/api/admin/rekey", { method: "POST", body: "{}" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "master_key_not_configured" });
    const badPrevious = await call(envWith(KEY_B, "bm90LWEta2V5"), "/api/admin/rekey", { method: "POST", body: "{}" });
    expect(badPrevious.status).toBe(409);
    expect(await badPrevious.json()).toEqual({ error: "previous_key_invalid" });
    const badCursor = await call(ENV_ROTATING, "/api/admin/rekey", { method: "POST", body: JSON.stringify({ cursor: "nope" }) });
    expect(badCursor.status).toBe(400);
  });

  it("rotates every storage class from key A to key B and proves A is no longer needed", async () => {
    const kidA = await keyIdFor(KEY_A);
    const kidB = await keyIdFor(KEY_B);

    // 1. Dual-key window: status shows the debt, and everything still reads.
    const before = await status(ENV_ROTATING);
    expect(before.currentKeyId).toBe(kidB);
    expect(before.previousKey).toEqual({ configured: true, valid: true, keyId: kidA, sameAsCurrent: false });
    expect(before.safeToRemovePreviousKey).toBe(false);
    const cls = Object.fromEntries(before.classes.map((c) => [c.id, c]));
    expect(cls.monitor_config).toMatchObject({ rows: 4, previous: 3, legacy: 1, unsealed: 1, current: 0 });
    // 4 webhook/Discord rows plus one Slack, one Teams and one Telegram channel.
    expect(cls.channel_secrets).toMatchObject({ rows: 7, previous: 7, legacy: 1, unsealed: 1, unreadable: 1 });
    expect(cls.push_secrets).toMatchObject({ rows: 3, previous: 6, unsealed: 3 });
    expect(cls.settings).toMatchObject({ rows: 1, previous: 1 });
    expect(cls.outbox_payloads).toMatchObject({ rows: OUTBOX_V2_COUNT + 7, previous: OUTBOX_V2_COUNT, legacy: 3, unsealed: 2, unreadable: 2 });
    // 3+1 monitors, 7+1 channel values, 6 push, 1 setting, 20+3 outbox.
    expect(before.dependsOnPreviousKey).toBe(42);
    expect(locations(before.unreadable)).toEqual(EXPECTED_UNREADABLE());
    expect(before.unreadableCount).toBe(3);
    // Reading upgrades the legacy plaintext channel secret and outbox payloads
    // in place (existing lazy behaviour), so the pass below seals the rest.
    await expectEverythingReadable(ENV_ROTATING);

    // 2. The pass, across many small batches.
    const pass = await runPass(ENV_ROTATING, 7);
    expect(pass.batches.length).toBeGreaterThan(5);
    expect(pass.batches.at(-1)!.done).toBe(true);
    expect(pass.scanned).toBe(1 + 4 + 7 + 3 + OUTBOX_V2_COUNT + 7);
    expect(pass.conflicts).toBe(0);
    // Plaintext sealed by the pass: the unsealed monitor config and 3 push fields.
    expect(pass.sealed).toBe(4);
    expect(locations(pass.unreadable)).toEqual(EXPECTED_UNREADABLE());

    // 3. Unreadable rows were reported, not rewritten.
    expect(await strangerRows()).toEqual(seeded.strangerRaw);

    // 4. Nothing depends on A any more.
    const after = await status(ENV_ROTATING);
    expect(after.dependsOnPreviousKey).toBe(0);
    expect(after.needsReencryption).toBe(0);
    expect(after.safeToRemovePreviousKey).toBe(true);
    expect(after.summary).toContain("safe to delete MASTER_KEY_PREVIOUS");
    expect(locations(after.unreadable)).toEqual(EXPECTED_UNREADABLE());
    for (const c of after.classes) {
      expect(c.previous + c.legacy + c.unsealed).toBe(0);
    }
    for (const [i, ch] of CHAT_CHANNELS.entries()) {
      const row = await env.DB.prepare("SELECT config FROM notification_channels WHERE id = ?")
        .bind(seeded.chatChannelIds[i])
        .first<{ config: string }>();
      const stored = JSON.parse(row!.config) as Record<string, string>;
      expect(stored[ch.field]).toMatch(new RegExp(`^v2:${kidB}:`));
    }
    const legacyPush = await env.DB.prepare("SELECT endpoint, endpoint_hash FROM push_subscriptions WHERE id = ?")
      .bind(seeded.legacyPushId)
      .first<{ endpoint: string; endpoint_hash: string | null }>();
    expect(legacyPush!.endpoint).toMatch(new RegExp(`^v2:${kidB}:`));
    expect(legacyPush!.endpoint_hash).toMatch(/^[0-9a-f]{64}$/);
    const vapid = await env.DB.prepare("SELECT value, encrypted FROM settings WHERE key = 'vapid_private_key'").first<{ value: string; encrypted: number }>();
    expect(vapid).toMatchObject({ encrypted: 1 });
    expect(vapid!.value).toMatch(new RegExp(`^v2:${kidB}:`));

    // 5. Idempotent: a second pass finds nothing left to do.
    const again = await runPass(ENV_ROTATING, 35);
    expect(again.rewritten).toBe(0);
    expect(again.reencrypted + again.sealed).toBe(0);
    expect(locations(again.unreadable)).toEqual(EXPECTED_UNREADABLE());

    // 6. Remove A entirely: everything still reads with B alone.
    await expectEverythingReadable(ENV_B);
    const onlyB = await status(ENV_B);
    expect(onlyB.previousKey.configured).toBe(false);
    expect(onlyB.needsReencryption).toBe(0);
    expect(onlyB.summary).toContain("Every readable value is encrypted with the current key.");
    expect(onlyB.summary).toContain("3 values cannot be decrypted");
    const monitorRes = await call(ENV_B, `/api/monitors/${seeded.legacyMonitorId}`);
    const monitorBody = await monitorRes.json<{ monitor: { config: Record<string, unknown> } }>();
    expect(monitorBody.monitor.config).toMatchObject({ url: "https://legacy.example.com", secret: "" });
  });
});
