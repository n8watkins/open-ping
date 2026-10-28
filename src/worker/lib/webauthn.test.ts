import { describe, expect, it } from "vitest";
import { encodeCbor, type CborMap } from "./cbor";
import {
  base64urlDecode,
  base64urlEncode,
  challengeOf,
  COSE_ALG_ES256,
  COSE_ALG_RS256,
  counterAllows,
  derToRawEcdsa,
  importCoseKey,
  parseAuthenticatorData,
  verifyAuthentication,
  verifyRegistration,
  WebAuthnError,
  type Expected,
} from "./webauthn";
import { rawToDerEcdsa, SoftAuthenticator } from "../../../test/support/soft-authenticator";

const ORIGIN = "https://status.example.com";
const RP_ID = "status.example.com";
const USER_HANDLE = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));

function newChallenge(): string {
  return base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

function regOptions(challenge: string) {
  return { challenge, rp: { id: RP_ID }, user: { id: USER_HANDLE } };
}

function expected(challenge: string): Expected {
  return { challenge, origin: ORIGIN, rpId: RP_ID };
}

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(WebAuthnError);
  await expect(p).rejects.toMatchObject({ code });
}

async function registered(alg: number = COSE_ALG_ES256, opts: { counter?: boolean } = {}) {
  const auth = await SoftAuthenticator.create({ alg: alg as typeof COSE_ALG_ES256, ...opts });
  const challenge = newChallenge();
  const reg = await verifyRegistration(await auth.register(regOptions(challenge), ORIGIN), expected(challenge));
  return { auth, reg };
}

describe("base64url", () => {
  it("round-trips every byte value and rejects other alphabets", () => {
    const all = new Uint8Array(256).map((_, i) => i);
    expect(base64urlDecode(base64urlEncode(all))).toEqual(all);
    expect(base64urlEncode(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
    expect(() => base64urlDecode("ab+/")).toThrow(WebAuthnError);
    expect(() => base64urlDecode("a b")).toThrow(WebAuthnError);
  });
});

describe("derToRawEcdsa", () => {
  it("converts DER signatures, including ones with leading zero bytes", () => {
    const raw = new Uint8Array(64);
    raw[0] = 0x80; // r needs a 0x00 pad in DER
    raw[32] = 0x00; // s is shorter than 32 bytes in DER
    raw[33] = 0x01;
    raw[63] = 0x05;
    expect(derToRawEcdsa(rawToDerEcdsa(raw))).toEqual(raw);
  });

  it.each([
    ["not a sequence", [0x31, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]],
    ["a wrong sequence length", [0x30, 0x07, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]],
    ["a negative integer", [0x30, 0x06, 0x02, 0x01, 0x81, 0x02, 0x01, 0x01]],
    ["a non-minimal integer", [0x30, 0x07, 0x02, 0x02, 0x00, 0x01, 0x02, 0x01, 0x01]],
    ["trailing bytes", [0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0x00]],
  ])("rejects %s", (_label, der) => {
    expect(() => derToRawEcdsa(new Uint8Array(der))).toThrow(WebAuthnError);
  });
});

describe("importCoseKey", () => {
  it("rejects unsupported algorithms and malformed keys", async () => {
    const eddsa: CborMap = new Map<number | string, never>();
    eddsa.set(1, 1);
    eddsa.set(3, -8);
    eddsa.set(-1, 6);
    eddsa.set(-2, new Uint8Array(32));
    await expectCode(importCoseKey(encodeCbor(eddsa)), "unsupported_algorithm");

    const shortX: CborMap = new Map<number | string, never>();
    shortX.set(1, 2);
    shortX.set(3, COSE_ALG_ES256);
    shortX.set(-1, 1);
    shortX.set(-2, new Uint8Array(31));
    shortX.set(-3, new Uint8Array(32));
    await expectCode(importCoseKey(encodeCbor(shortX)), "malformed");

    const offCurve: CborMap = new Map(shortX);
    offCurve.set(-2, new Uint8Array(32).fill(1));
    offCurve.set(-3, new Uint8Array(32).fill(2));
    await expectCode(importCoseKey(encodeCbor(offCurve)), "malformed");

    const smallRsa: CborMap = new Map<number | string, never>();
    smallRsa.set(1, 3);
    smallRsa.set(3, COSE_ALG_RS256);
    smallRsa.set(-1, new Uint8Array(128).fill(0xff));
    smallRsa.set(-2, new Uint8Array([1, 0, 1]));
    await expectCode(importCoseKey(encodeCbor(smallRsa)), "unsupported_algorithm");

    await expectCode(importCoseKey(new Uint8Array([0x01])), "malformed");
  });
});

describe("parseAuthenticatorData", () => {
  it("rejects short, truncated and padded data", async () => {
    const { auth } = await registered();
    const res = await auth.authenticate({ challenge: newChallenge(), rpId: RP_ID }, ORIGIN);
    const bytes = base64urlDecode(res.response.authenticatorData);
    expect(parseAuthenticatorData(bytes).signCount).toBeGreaterThan(0);
    expect(() => parseAuthenticatorData(bytes.subarray(0, 36))).toThrow(WebAuthnError);
    expect(() => parseAuthenticatorData(new Uint8Array([...bytes, 0]))).toThrow(/trailing/);
    const attested = new Uint8Array(bytes);
    attested[32] = attested[32]! | 0x40; // claims attested data that isn't there
    expect(() => parseAuthenticatorData(attested)).toThrow(WebAuthnError);
  });
});

describe("verifyRegistration", () => {
  it.each([
    ["ES256", COSE_ALG_ES256],
    ["RS256", COSE_ALG_RS256],
  ])("accepts a %s passkey with none attestation", async (_label, alg) => {
    const { auth, reg } = await registered(alg);
    expect(reg).toMatchObject({
      credentialId: auth.id,
      publicKey: auth.publicKey,
      alg,
      signCount: 1,
      aaguid: "0".repeat(32),
      backupEligible: true,
      backupState: true,
      attestationFormat: "none",
    });
  });

  it("rejects none attestation that carries a statement", async () => {
    const auth = await SoftAuthenticator.create();
    const challenge = newChallenge();
    const attStmt: CborMap = new Map();
    attStmt.set("sig", new Uint8Array([1]));
    const res = await auth.register(regOptions(challenge), ORIGIN, { attStmt });
    await expectCode(verifyRegistration(res, expected(challenge)), "malformed");
  });

  it("ignores, rather than trusts, another attestation format", async () => {
    const auth = await SoftAuthenticator.create();
    const challenge = newChallenge();
    const attStmt: CborMap = new Map();
    attStmt.set("alg", -7);
    attStmt.set("sig", new Uint8Array(70));
    const res = await auth.register(regOptions(challenge), ORIGIN, { fmt: "packed", attStmt });
    await expect(verifyRegistration(res, expected(challenge))).resolves.toMatchObject({ attestationFormat: "packed" });
  });

  it.each([
    ["challenge_mismatch", { challenge: "c29tZXRoaW5nLWVsc2U" }],
    ["origin_mismatch", { origin: "https://evil.example" }],
    ["origin_mismatch", { origin: "https://status.example.com:8443" }],
    ["wrong_type", { type: "webauthn.get" }],
    ["cross_origin", { crossOrigin: true }],
    ["rp_id_mismatch", { rpId: "example.com" }],
  ])("rejects %s (%o)", async (code, overrides) => {
    const auth = await SoftAuthenticator.create();
    const challenge = newChallenge();
    const res = await auth.register(regOptions(challenge), ORIGIN, overrides);
    await expectCode(verifyRegistration(res, expected(challenge)), code);
  });

  it("requires user presence and user verification", async () => {
    for (const [opts, code] of [
      [{ userVerified: false }, "user_not_verified"],
      [{ userPresent: false }, "user_not_present"],
    ] as const) {
      const auth = await SoftAuthenticator.create(opts);
      const challenge = newChallenge();
      await expectCode(verifyRegistration(await auth.register(regOptions(challenge), ORIGIN), expected(challenge)), code);
    }
  });

  it("rejects a rawId that doesn't match the attested credential", async () => {
    const auth = await SoftAuthenticator.create();
    const challenge = newChallenge();
    const res = await auth.register(regOptions(challenge), ORIGIN);
    const other = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
    await expectCode(verifyRegistration({ ...res, id: other, rawId: other }, expected(challenge)), "credential_id_mismatch");
  });

  it("rejects malformed client data and attestation objects", async () => {
    const auth = await SoftAuthenticator.create();
    const challenge = newChallenge();
    const res = await auth.register(regOptions(challenge), ORIGIN);
    const bad = (response: Partial<typeof res.response>) => ({ ...res, response: { ...res.response, ...response } });
    await expectCode(verifyRegistration(bad({ clientDataJSON: base64urlEncode(new TextEncoder().encode("{")) }), expected(challenge)), "malformed");
    await expectCode(verifyRegistration(bad({ clientDataJSON: base64urlEncode(new TextEncoder().encode("{}")) }), expected(challenge)), "malformed");
    await expectCode(verifyRegistration(bad({ attestationObject: "AAAA" }), expected(challenge)), "malformed");
    await expectCode(verifyRegistration(bad({ attestationObject: base64urlEncode(encodeCbor(new Map())) }), expected(challenge)), "malformed");
  });

  it("exposes the challenge a response answers, for a single-use lookup", async () => {
    const auth = await SoftAuthenticator.create();
    const challenge = newChallenge();
    const res = await auth.register(regOptions(challenge), ORIGIN);
    expect(challengeOf(res.response.clientDataJSON)).toBe(challenge);
  });
});

describe("verifyAuthentication", () => {
  it.each([
    ["ES256", COSE_ALG_ES256],
    ["RS256", COSE_ALG_RS256],
  ])("accepts a genuine %s assertion and advances the counter", async (_label, alg) => {
    const { auth, reg } = await registered(alg);
    const challenge = newChallenge();
    const res = await auth.authenticate({ challenge, rpId: RP_ID }, ORIGIN);
    const out = await verifyAuthentication(res, { ...expected(challenge), userHandle: USER_HANDLE }, reg);
    expect(out).toEqual({ signCount: 2, backupState: true });
  });

  it("accepts a passkey without a counter (always zero)", async () => {
    const { auth, reg } = await registered(COSE_ALG_ES256, { counter: false });
    expect(reg.signCount).toBe(0);
    for (let i = 0; i < 2; i++) {
      const challenge = newChallenge();
      const res = await auth.authenticate({ challenge, rpId: RP_ID }, ORIGIN);
      await expect(
        verifyAuthentication(res, { ...expected(challenge), userHandle: USER_HANDLE }, reg),
      ).resolves.toEqual({ signCount: 0, backupState: true });
    }
  });

  it("rejects a counter that went backwards or stood still (a cloned key)", async () => {
    const { auth, reg } = await registered();
    const challenge = newChallenge();
    auth.setCounter(4); // next assertion reports 5
    const res = await auth.authenticate({ challenge, rpId: RP_ID }, ORIGIN);
    await expectCode(
      verifyAuthentication(res, { ...expected(challenge), userHandle: USER_HANDLE }, { ...reg, signCount: 5 }),
      "counter_regressed",
    );
    expect(counterAllows(0, 0)).toBe(true);
    expect(counterAllows(5, 6)).toBe(true);
    expect(counterAllows(5, 0)).toBe(false);
    expect(counterAllows(0, 1)).toBe(true);
  });

  it("rejects a signature from a different key", async () => {
    const { reg } = await registered();
    const impostor = await SoftAuthenticator.create();
    const challenge = newChallenge();
    const res = await impostor.authenticate({ challenge, rpId: RP_ID }, ORIGIN, { userHandle: USER_HANDLE });
    const forged = { ...res, id: reg.credentialId, rawId: reg.credentialId };
    await expectCode(verifyAuthentication(forged, { ...expected(challenge), userHandle: USER_HANDLE }, reg), "bad_signature");
  });

  it("rejects a tampered authenticator data or client data", async () => {
    const { auth, reg } = await registered();
    const challenge = newChallenge();
    const res = await auth.authenticate({ challenge, rpId: RP_ID }, ORIGIN);
    const authData = base64urlDecode(res.response.authenticatorData);
    authData[36] = authData[36]! + 1; // bump the counter after signing
    const tampered = { ...res, response: { ...res.response, authenticatorData: base64urlEncode(authData) } };
    await expectCode(verifyAuthentication(tampered, { ...expected(challenge), userHandle: USER_HANDLE }, reg), "bad_signature");
  });

  it.each([
    ["challenge_mismatch", { challenge: "c29tZXRoaW5nLWVsc2U" }],
    ["origin_mismatch", { origin: "https://open-ping.someone.workers.dev" }],
    ["wrong_type", { type: "webauthn.create" }],
    ["rp_id_mismatch", { rpId: "open-ping.someone.workers.dev" }],
    ["user_handle_mismatch", { userHandle: "b3RoZXI" }],
  ])("rejects %s (%o)", async (code, overrides) => {
    const { auth, reg } = await registered();
    const challenge = newChallenge();
    const res = await auth.authenticate({ challenge, rpId: RP_ID }, ORIGIN, overrides);
    await expectCode(verifyAuthentication(res, { ...expected(challenge), userHandle: USER_HANDLE }, reg), code);
  });

  it("rejects an assertion without user verification", async () => {
    const auth = await SoftAuthenticator.create({ userVerified: false });
    const res = await auth.authenticate({ challenge: newChallenge(), rpId: RP_ID }, ORIGIN);
    const challenge = challengeOf(res.response.clientDataJSON);
    await expectCode(
      verifyAuthentication(
        res,
        { ...expected(challenge), userHandle: USER_HANDLE },
        { credentialId: auth.id, publicKey: auth.publicKey, signCount: 0 },
      ),
      "user_not_verified",
    );
  });

  it("rejects an assertion for a credential other than the stored one", async () => {
    const { auth } = await registered();
    const { reg: other } = await registered();
    const challenge = newChallenge();
    const res = await auth.authenticate({ challenge, rpId: RP_ID }, ORIGIN);
    await expectCode(verifyAuthentication(res, { ...expected(challenge), userHandle: USER_HANDLE }, other), "credential_id_mismatch");
  });
});
