import { describe, expect, it } from "vitest";
import {
  installationUrlImpact,
  installationUrlWarning,
  authenticationToJSON,
  base64urlToBytes,
  bytesToBase64url,
  hostMatchesRpId,
  passkeyErrorMessage,
  registrationToJSON,
  toCreationOptions,
  toRequestOptions,
} from "./webauthn";

describe("base64url", () => {
  it("round-trips bytes without padding", () => {
    const bytes = new Uint8Array([0, 251, 255, 1, 2]);
    const text = bytesToBase64url(bytes);
    expect(text).not.toMatch(/[=+/]/);
    expect([...base64urlToBytes(text)]).toEqual([...bytes]);
  });
});

describe("options conversion", () => {
  it("decodes the challenge, user id and excluded credential ids", () => {
    const opts = toCreationOptions({
      challenge: "AQID",
      rp: { id: "status.example.com", name: "OpenPing" },
      user: { id: "BAUG", name: "admin@example.com", displayName: "OpenPing admin" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      excludeCredentials: [{ type: "public-key", id: "BwgJ", transports: ["internal"] }],
    });
    expect([...new Uint8Array(opts.challenge as ArrayBuffer)]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(opts.user.id as ArrayBuffer)]).toEqual([4, 5, 6]);
    expect([...new Uint8Array(opts.excludeCredentials![0]!.id as ArrayBuffer)]).toEqual([7, 8, 9]);
    expect(opts.rp.id).toBe("status.example.com");

    const req = toRequestOptions({ challenge: "AQID", rpId: "status.example.com", allowCredentials: [] });
    expect([...new Uint8Array(req.challenge as ArrayBuffer)]).toEqual([1, 2, 3]);
    expect(req.allowCredentials).toEqual([]);
  });
});

describe("credential serialization", () => {
  const raw = new Uint8Array([1, 2, 3]).buffer;
  it("serializes a registration, with transports when the browser reports them", () => {
    const json = registrationToJSON({
      rawId: raw,
      response: {
        clientDataJSON: new Uint8Array([4]).buffer,
        attestationObject: new Uint8Array([5]).buffer,
        getTransports: () => ["internal"],
      },
    } as unknown as PublicKeyCredential);
    expect(json).toEqual({
      id: "AQID",
      rawId: "AQID",
      type: "public-key",
      response: { clientDataJSON: "BA", attestationObject: "BQ", transports: ["internal"] },
    });
  });

  it("serializes an assertion, with a null user handle when there is none", () => {
    const json = authenticationToJSON({
      rawId: raw,
      response: {
        clientDataJSON: new Uint8Array([4]).buffer,
        authenticatorData: new Uint8Array([5]).buffer,
        signature: new Uint8Array([6]).buffer,
        userHandle: null,
      },
    } as unknown as PublicKeyCredential);
    expect(json.response).toEqual({ clientDataJSON: "BA", authenticatorData: "BQ", signature: "Bg", userHandle: null });
  });
});

describe("hostMatchesRpId", () => {
  it("matches the RP ID and its subdomains only", () => {
    expect(hostMatchesRpId("openping.n8builds.dev", "openping.n8builds.dev")).toBe(true);
    expect(hostMatchesRpId("n8builds.dev", "openping.n8builds.dev")).toBe(true);
    expect(hostMatchesRpId("openping.n8builds.dev", "open-ping.someone.workers.dev")).toBe(false);
    expect(hostMatchesRpId("openping.n8builds.dev", "evilopenping.n8builds.dev")).toBe(false);
    expect(hostMatchesRpId(undefined, "localhost")).toBe(false);
  });
});

describe("passkeyErrorMessage", () => {
  it("explains cancelled ceremonies and server error codes", () => {
    expect(passkeyErrorMessage(new DOMException("x", "NotAllowedError"))).toMatch(/cancelled or timed out/);
    expect(passkeyErrorMessage(new Error("challenge_invalid"))).toMatch(/expired/);
    expect(passkeyErrorMessage(new Error("unknown_passkey"))).toMatch(/isn't registered/);
    expect(passkeyErrorMessage(new Error("whatever"))).toMatch(/went wrong/);
  });
});

describe("installationUrlImpact", () => {
  const SAVED = "https://status.example.com";
  // Two passkeys for the current hostname, one left over from an older address.
  const state = {
    passkeys: [{ rpId: "status.example.com" }, { rpId: "status.example.com" }, { rpId: "old.example.com" }],
    rpId: "status.example.com",
    origin: "https://status.example.com",
    appUrlFromEnv: false,
    otherSignIn: { github: false, email: false },
  };

  it("counts only the passkeys that work now, not ones an earlier change already stranded", () => {
    expect(installationUrlImpact("https://new.example.com", SAVED, state)).toEqual({
      stranded: 2,
      newHost: "new.example.com",
      passkeysForNewHost: 0,
      github: false,
      email: false,
    });
  });

  it("says nothing when the address is unchanged, as on a timezone-only save", () => {
    expect(installationUrlImpact(SAVED, SAVED, state)).toBeNull();
    expect(installationUrlImpact(` ${SAVED} `, SAVED, state)).toBeNull();
  });

  it("says nothing when the hostname stays the same (port, path and scheme don't matter)", () => {
    expect(installationUrlImpact("http://status.example.com:8443", SAVED, state)).toBeNull();
    // The setting was empty, and the address passkeys work at is the same host.
    expect(installationUrlImpact("https://status.example.com", null, state)).toBeNull();
  });

  it("says nothing when the APP_URL Worker variable sets the address", () => {
    expect(installationUrlImpact("https://new.example.com", SAVED, { ...state, appUrlFromEnv: true })).toBeNull();
  });

  it("says nothing when no passkey works at the current hostname", () => {
    const stale = { ...state, passkeys: [{ rpId: "old.example.com" }] };
    expect(installationUrlImpact("https://new.example.com", SAVED, stale)).toBeNull();
    expect(installationUrlImpact("https://new.example.com", SAVED, { ...state, passkeys: [] })).toBeNull();
  });

  it("says nothing for an address that isn't a URL yet, or before passkeys load", () => {
    expect(installationUrlImpact("status.example", SAVED, state)).toBeNull();
    expect(installationUrlImpact("https://new.example.com", SAVED, null)).toBeNull();
  });

  it("counts passkeys already made for the new hostname as a way in", () => {
    expect(installationUrlImpact("https://old.example.com", SAVED, state)).toMatchObject({
      stranded: 2,
      passkeysForNewHost: 1,
    });
  });
});

describe("installationUrlWarning", () => {
  const base = { stranded: 1, newHost: "new.example.com", passkeysForNewHost: 0, github: false, email: false };

  it("says the passkeys are the only way in only when nothing else remains", () => {
    expect(installationUrlWarning(base)).toBe(
      "Your 1 passkey stops working at the new address. It is your only way to sign in, so you would need a new SETUP_TOKEN and /recover to get back in. Save anyway?",
    );
    expect(installationUrlWarning({ ...base, stranded: 2 })).toMatch(/^Your 2 passkeys stop working.* They are your only way/);
  });

  it("names the ways in that still work", () => {
    expect(installationUrlWarning({ ...base, github: true })).toMatch(/You can still sign in there with GitHub and add new passkeys\./);
    expect(installationUrlWarning({ ...base, github: true, email: true })).toMatch(/with GitHub or an email link and/);
    expect(installationUrlWarning({ ...base, passkeysForNewHost: 1, email: true })).toMatch(
      /with the passkey you added for new\.example\.com or an email link and/,
    );
    expect(installationUrlWarning({ ...base, passkeysForNewHost: 2 })).not.toMatch(/only way/);
  });
});
