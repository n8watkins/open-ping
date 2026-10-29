import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeFcm, FAKE_PROJECT, type FakeFcm } from "../../../../test/support/fake-fcm";
import { fcmErrorCode, fcmMessage, fcmProjectId, forgetFcmTokens, isFcmToken, sendFcm, serviceAccount } from "./fcm";

const TOKEN = `fcm-token-${"a".repeat(140)}`;
const ALERT = {
  title: "🔴 App is down",
  body: "HTTP 503",
  url: "https://openping.test/incidents/inc_1",
  origin: "https://openping.test",
  tag: "inc_1",
};

let fake: FakeFcm;

beforeEach(async () => {
  fake = await createFakeFcm();
  forgetFcmTokens();
  vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const sa = () => serviceAccount({ FCM_SERVICE_ACCOUNT: fake.serviceAccountJson })!;

describe("serviceAccount", () => {
  it("reads a Firebase service account key", () => {
    expect(sa()).toMatchObject({ projectId: FAKE_PROJECT, clientEmail: expect.stringContaining("@"), privateKeyId: "key-1" });
    expect(fcmProjectId({ FCM_SERVICE_ACCOUNT: fake.serviceAccountJson })).toBe(FAKE_PROJECT);
  });

  it("is off when unset, and refuses anything else", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(serviceAccount({})).toBeNull();
    expect(serviceAccount({ FCM_SERVICE_ACCOUNT: "  " })).toBeNull();
    expect(serviceAccount({ FCM_SERVICE_ACCOUNT: "not json" })).toBeNull();
    expect(serviceAccount({ FCM_SERVICE_ACCOUNT: JSON.stringify({ type: "authorized_user", project_id: "abcdef" }) })).toBeNull();
    const wrongProject = { ...JSON.parse(fake.serviceAccountJson), project_id: "Bad Project" };
    expect(serviceAccount({ FCM_SERVICE_ACCOUNT: JSON.stringify(wrongProject) })).toBeNull();
  });
});

describe("sendFcm", () => {
  it("signs in with a JWT, sends a data message, and reuses the access token", async () => {
    expect(await sendFcm(sa(), TOKEN, ALERT)).toMatchObject({ ok: true });
    expect(await sendFcm(sa(), TOKEN, { ...ALERT, tag: "inc_2" })).toMatchObject({ ok: true });
    expect(fake.tokensIssued).toBe(1);
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[0]).toEqual({
      token: TOKEN,
      data: { kind: "alert", ...ALERT },
      android: { priority: "high", ttl: "86400s" },
    });
  });

  it("gets a new access token when the old one is near its end", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await sendFcm(sa(), TOKEN, ALERT);
      vi.setSystemTime(Date.now() + 54 * 60 * 1000);
      await sendFcm(sa(), TOKEN, ALERT);
      expect(fake.tokensIssued).toBe(1);
      vi.setSystemTime(Date.now() + 2 * 60 * 1000);
      await sendFcm(sa(), TOKEN, ALERT);
      expect(fake.tokensIssued).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says a token is gone when FCM answers UNREGISTERED", async () => {
    fake.unregistered.add(TOKEN);
    expect(await sendFcm(sa(), TOKEN, ALERT)).toMatchObject({ ok: false, status: 404, expired: true, error: "fcm_unregistered" });
  });

  it("says a token belongs elsewhere on SENDER_ID_MISMATCH", async () => {
    fake.failNext = { status: 403, code: "SENDER_ID_MISMATCH" };
    expect(await sendFcm(sa(), TOKEN, ALERT)).toMatchObject({ ok: false, invalid: true, error: "fcm_sender_mismatch" });
  });

  it("keeps the device for a retry on quota and outages, honouring Retry-After", async () => {
    fake.failNext = { status: 429, code: "QUOTA_EXCEEDED", retryAfter: "30" };
    expect(await sendFcm(sa(), TOKEN, ALERT)).toMatchObject({
      ok: false,
      error: "fcm_quota_exceeded",
      retryAfterMs: 30_000,
    });
    fake.failNext = { status: 503, code: "UNAVAILABLE" };
    const outage = await sendFcm(sa(), TOKEN, ALERT);
    expect(outage).toMatchObject({ ok: false, error: "fcm_unavailable" });
    expect(outage.expired).toBeUndefined();
    expect(outage.invalid).toBeUndefined();
  });

  it("drops a refused access token so the next try signs in again", async () => {
    await sendFcm(sa(), TOKEN, ALERT);
    fake.failNext = { status: 401, code: "UNSPECIFIED_ERROR" };
    expect(await sendFcm(sa(), TOKEN, ALERT)).toMatchObject({ ok: false, error: "fcm_unauthorized" });
    await sendFcm(sa(), TOKEN, ALERT);
    expect(fake.tokensIssued).toBe(2);
  });

  it("reports a refused sign-in without throwing", async () => {
    const other = await createFakeFcm();
    // A key Google doesn't know: the fake verifies against its own key.
    const stranger = serviceAccount({ FCM_SERVICE_ACCOUNT: other.serviceAccountJson })!;
    expect(await sendFcm(stranger, TOKEN, ALERT)).toMatchObject({ ok: false, error: "fcm_auth_failed: invalid_grant" });
  });

  it("reports an unreachable FCM without throwing", async () => {
    await sendFcm(sa(), TOKEN, ALERT);
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("connect timeout"));
    expect(await sendFcm(sa(), TOKEN, ALERT)).toMatchObject({ ok: false, error: "fcm_unreachable: connect timeout" });
  });
});

describe("helpers", () => {
  it("finds FCM's own error code", () => {
    expect(
      fcmErrorCode({ error: { details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "UNREGISTERED" }] } }),
    ).toBe("UNREGISTERED");
    expect(fcmErrorCode({ error: { details: [{ "@type": "type.googleapis.com/google.rpc.BadRequest" }] } })).toBeNull();
    expect(fcmErrorCode(null)).toBeNull();
  });

  it("keeps message text within bounds", () => {
    const { message } = fcmMessage(TOKEN, { ...ALERT, body: "x".repeat(5000) });
    expect(message.data.body).toHaveLength(1000);
  });

  it("knows a token from other input", () => {
    expect(isFcmToken(TOKEN)).toBe(true);
    expect(isFcmToken("short")).toBe(false);
    expect(isFcmToken(`${TOKEN} space`)).toBe(false);
    expect(isFcmToken(42)).toBe(false);
  });
});
