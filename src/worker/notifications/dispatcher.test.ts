import { describe, expect, it } from "vitest";
import { deliveryD1Cost, newDeliveryCache } from "./dispatcher";
import type { OutboxEntry } from "../db/outbox";

const payload = {
  event: "down",
  monitorId: "mon_1",
  monitorName: "Example",
  state: "down",
  title: "Example is down",
  body: "HTTP 500",
  detectedAt: 0,
};

function entry(channelType: string, extra: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id: "out_1",
    eventKey: "down:inc_1:ch_1",
    monitorId: "mon_1",
    channelId: channelType === "push" ? null : "ch_1",
    channelType,
    target: channelType === "push" ? "psub_1" : null,
    eventType: "down",
    payload,
    payloadError: null,
    status: "pending",
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  };
}

describe("deliveryD1Cost", () => {
  it("charges a push delivery its device, the VAPID keys or the address once per pass, its marks and a failure mark", () => {
    const cache = newDeliveryCache();
    expect(deliveryD1Cost(entry("push"), cache)).toBe(6);
    cache.vapid = null;
    expect(deliveryD1Cost(entry("push"), cache)).toBe(5);
    cache.origin = "https://openping.test";
    expect(deliveryD1Cost(entry("push"), cache)).toBe(4);
  });

  it("charges a channel delivery its channel and email_from once per pass", () => {
    const cache = newDeliveryCache();
    expect(deliveryD1Cost(entry("email"), cache)).toBe(5);
    expect(deliveryD1Cost(entry("webhook"), cache)).toBe(4);
    cache.channels.set("ch_1", null);
    cache.emailFrom = null;
    expect(deliveryD1Cost(entry("email"), cache)).toBe(3);
  });

  it("charges an unreadable payload only its failure mark", () => {
    expect(deliveryD1Cost(entry("email", { payloadError: "payload_invalid_json" }), newDeliveryCache())).toBe(1);
  });
});
