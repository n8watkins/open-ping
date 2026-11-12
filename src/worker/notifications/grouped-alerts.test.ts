import { describe, expect, it } from "vitest";
import { GROUP_MIN, GROUP_WINDOW_MS, planDeliveries } from "./dispatcher";
import { buildGroupPayload, GROUP_LIST_MAX, toEmailHtml, toEmailText, type NotificationPayload } from "./payload";
import { toSlackMessage } from "./channels/slack";
import { toTelegramMessage } from "./channels/telegram";
import type { OutboxEntry } from "../db/outbox";

function payload(id: string, event: NotificationPayload["event"] = "down", extra: Partial<NotificationPayload> = {}): NotificationPayload {
  return {
    event,
    monitorId: id,
    monitorName: `Site ${id}`,
    state: event === "recovered" ? "up" : "down",
    title: `Site ${id}`,
    body: `Site ${id}`,
    url: `https://op.test/monitors/${id}`,
    statusCode: 403,
    error: "HTTP 403",
    detectedAt: 1000,
    incidentId: `inc_${id}`,
    ...extra,
  };
}

let seq = 0;
function entry(monitor: string, extra: Partial<OutboxEntry> = {}): OutboxEntry {
  const event = (extra.eventType ?? "down") as NotificationPayload["event"];
  return {
    id: `out_${++seq}`,
    eventKey: `${event}:inc_${monitor}:ch_1`,
    monitorId: monitor,
    channelId: "ch_1",
    channelType: "email",
    target: null,
    eventType: event,
    payload: payload(monitor, event),
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

describe("planDeliveries", () => {
  it(`groups ${GROUP_MIN} or more alerts of one kind for one channel, in place of the first`, () => {
    const single = entry("solo", { channelId: "ch_2" });
    const downs = ["a", "b", "c"].map((m, i) => entry(m, { createdAt: i * 1000 }));
    const plan = planDeliveries([single, ...downs]);
    expect(plan).toHaveLength(2);
    expect(plan[0]!.lead).toBe(single);
    expect(plan[0]!.group).toBeUndefined();
    expect(plan[1]!.group?.kind).toBe("down");
    expect(plan[1]!.entries).toEqual(downs);
    expect(plan[1]!.lead).toBe(downs[0]);
  });

  it("leaves fewer than the minimum as single alerts", () => {
    const plan = planDeliveries([entry("a"), entry("b")]);
    expect(plan.map((d) => d.group)).toEqual([undefined, undefined]);
  });

  it("groups per destination: three channels each get their own group", () => {
    const due = ["ch_1", "ch_2"].flatMap((ch) => ["a", "b", "c"].map((m) => entry(m, { channelId: ch })));
    const plan = planDeliveries(due);
    expect(plan).toHaveLength(2);
    expect(plan.map((d) => d.lead.channelId)).toEqual(["ch_1", "ch_2"]);
  });

  it("groups push per device", () => {
    const push = (m: string, target: string) => entry(m, { channelType: "push", channelId: null, target });
    const plan = planDeliveries([push("a", "d1"), push("b", "d1"), push("c", "d1"), push("a", "d2")]);
    expect(plan).toHaveLength(2);
    expect(plan[0]!.entries).toHaveLength(3);
    expect(plan[1]!.group).toBeUndefined();
  });

  it("keeps downs and recoveries apart, and groups down, flapping and missed heartbeats together", () => {
    const due = [
      entry("a"),
      entry("b", { eventType: "flapping" }),
      entry("c", { eventType: "heartbeat_missed" }),
      entry("d", { eventType: "recovered" }),
      entry("e", { eventType: "recovered" }),
    ];
    const plan = planDeliveries(due);
    expect(plan).toHaveLength(3);
    expect(plan[0]!.group?.kind).toBe("down");
    expect(plan[0]!.group?.payload.event).toBe("down");
    expect(plan.slice(1).every((d) => d.group === undefined)).toBe(true);
  });

  it("splits alerts queued further apart than the window", () => {
    const at = (m: string, t: number) => entry(m, { createdAt: t });
    const due = [at("a", 0), at("b", 1000), at("c", GROUP_WINDOW_MS), at("d", GROUP_WINDOW_MS + 1001), at("e", GROUP_WINDOW_MS + 2000)];
    const plan = planDeliveries(due);
    // a, b, c fall within two minutes of a; d and e start a new window of two.
    expect(plan.map((d) => d.entries.length)).toEqual([3, 1, 1]);
  });

  it("never groups other events or unreadable payloads", () => {
    const due = [
      entry("a", { eventType: "incident_update" }),
      entry("b", { eventType: "incident_update" }),
      entry("c", { eventType: "incident_update" }),
      entry("d", { payloadError: "payload_decryption_failed" }),
      entry("e"),
      entry("f"),
    ];
    expect(planDeliveries(due).every((d) => d.group === undefined)).toBe(true);
  });
});

describe("buildGroupPayload", () => {
  it("names a likely shared cause and lists every monitor", () => {
    const p = buildGroupPayload(
      [payload("a"), payload("b", "heartbeat_missed"), payload("c", "down", { statusCode: null, error: "timeout" })],
      "down",
    );
    expect(p.title).toBe("🔴 3 sites down at once");
    expect(p.body).toBe(
      "3 sites down at once: likely a shared cause (network, DNS, firewall).\n\n- Site a (HTTP 403)\n- Site b (missed its heartbeat)\n- Site c (timeout)",
    );
    expect(p.event).toBe("down");
    expect(p.monitorId).toBe("group");
    expect(p.state).toBe("down");
    expect(p.url).toBe("https://op.test/monitors");
    expect(p.statusCode).toBeNull();
    expect(p.group?.count).toBe(3);
    expect(p.group?.monitors.map((m) => m.incidentId)).toEqual(["inc_a", "inc_b", "inc_c"]);
  });

  it("words a recovery as one", () => {
    const p = buildGroupPayload(
      ["a", "b", "c"].map((m) => payload(m, "recovered", { durationSeconds: 24 * 60 })),
      "recovered",
    );
    expect(p.title).toBe("🟢 3 sites recovered");
    expect(p.body.split("\n")[0]).toBe("3 sites recovered at once.");
    expect(p.body).toContain("- Site a (after 24 min)");
    expect(p.state).toBe("up");
  });

  it(`names at most ${GROUP_LIST_MAX} monitors and counts the rest`, () => {
    const p = buildGroupPayload(
      Array.from({ length: GROUP_LIST_MAX + 5 }, (_, i) => payload(`m${i}`)),
      "down",
    );
    expect(p.body.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(GROUP_LIST_MAX + 1);
    expect(p.body).toContain("- and 5 more");
    expect(p.group?.monitors).toHaveLength(GROUP_LIST_MAX + 5);
  });

  it("renders on every channel with a link to the monitor list", () => {
    const p = buildGroupPayload(["a", "b", "c"].map((m) => payload(m)), "down");
    expect(toEmailText(p)).toContain("View monitors: https://op.test/monitors");
    expect(toEmailHtml(p)).toContain("likely a shared cause");
    expect(JSON.stringify(toSlackMessage(p))).toContain("3 sites down at once");
    expect(toTelegramMessage("1", p).text).toContain("View monitors");
  });
});
