/**
 * A software WebAuthn authenticator for tests. It makes real ES256 or RS256
 * key pairs with Web Crypto at run time (no key material lives in the repo)
 * and produces the same JSON a browser's navigator.credentials.create() and
 * .get() responses serialize to, so the Worker's verification is tested
 * against genuine signatures rather than hand-written fixtures.
 */
import { encodeCbor, type CborMap } from "../../src/worker/lib/cbor";
import {
  base64urlDecode,
  base64urlEncode,
  COSE_ALG_ES256,
  COSE_ALG_RS256,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "../../src/worker/lib/webauthn";

const enc = new TextEncoder();

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Raw r || s (Web Crypto's ECDSA output) to the DER form authenticators send. */
export function rawToDerEcdsa(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.subarray(i);
    if ((v[0]! & 0x80) !== 0) v = concat(new Uint8Array([0]), v);
    return concat(new Uint8Array([0x02, v.length]), v);
  };
  const body = concat(int(raw.subarray(0, 32)), int(raw.subarray(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

export interface SoftAuthenticatorOptions {
  alg?: typeof COSE_ALG_ES256 | typeof COSE_ALG_RS256;
  /** Whether the authenticator keeps a signature counter (synced passkeys don't). */
  counter?: boolean;
  /** Clear the UV flag to simulate a tap-only security key. */
  userVerified?: boolean;
  userPresent?: boolean;
}

export interface ClientDataOverrides {
  type?: string;
  challenge?: string;
  origin?: string;
  crossOrigin?: boolean;
  rpId?: string;
}

export class SoftAuthenticator {
  readonly alg: number;
  readonly credentialId: Uint8Array;
  private keys!: CryptoKeyPair;
  private cose!: Uint8Array;
  private count = 0;
  userHandle: string | null = null;

  private constructor(private readonly opts: SoftAuthenticatorOptions) {
    this.alg = opts.alg ?? COSE_ALG_ES256;
    this.credentialId = crypto.getRandomValues(new Uint8Array(32));
  }

  static async create(opts: SoftAuthenticatorOptions = {}): Promise<SoftAuthenticator> {
    const a = new SoftAuthenticator(opts);
    await a.init();
    return a;
  }

  get id(): string {
    return base64urlEncode(this.credentialId);
  }

  /** Set the counter directly, to simulate a cloned authenticator. */
  setCounter(n: number) {
    this.count = n;
  }

  private async init() {
    if (this.alg === COSE_ALG_ES256) {
      this.keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
      ])) as CryptoKeyPair;
      const jwk = (await crypto.subtle.exportKey("jwk", this.keys.publicKey)) as JsonWebKey;
      const map: CborMap = new Map();
      map.set(1, 2);
      map.set(3, COSE_ALG_ES256);
      map.set(-1, 1);
      map.set(-2, base64urlDecode(jwk.x!));
      map.set(-3, base64urlDecode(jwk.y!));
      this.cose = encodeCbor(map);
    } else {
      this.keys = (await crypto.subtle.generateKey(
        {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["sign", "verify"],
      )) as CryptoKeyPair;
      const jwk = (await crypto.subtle.exportKey("jwk", this.keys.publicKey)) as JsonWebKey;
      const map: CborMap = new Map();
      map.set(1, 3);
      map.set(3, COSE_ALG_RS256);
      map.set(-1, base64urlDecode(jwk.n!));
      map.set(-2, base64urlDecode(jwk.e!));
      this.cose = encodeCbor(map);
    }
  }

  /** The COSE public key, as the Worker stores it. */
  get publicKey(): string {
    return base64urlEncode(this.cose);
  }

  private flags(attested: boolean): number {
    let f = 0;
    if (this.opts.userPresent !== false) f |= 0x01;
    if (this.opts.userVerified !== false) f |= 0x04;
    f |= 0x08 | 0x10; // backup eligible + backed up, like a synced passkey
    if (attested) f |= 0x40;
    return f;
  }

  private nextCount(): number {
    if (this.opts.counter === false) return 0;
    this.count += 1;
    return this.count;
  }

  private clientData(type: string, challenge: string, origin: string, o: ClientDataOverrides) {
    const data: Record<string, unknown> = {
      type: o.type ?? type,
      challenge: o.challenge ?? challenge,
      origin: o.origin ?? origin,
    };
    if (o.crossOrigin !== undefined) data.crossOrigin = o.crossOrigin;
    return enc.encode(JSON.stringify(data));
  }

  /** Answer navigator.credentials.create() options. */
  async register(
    options: { challenge: string; rp: { id: string }; user: { id: string } },
    origin: string,
    overrides: ClientDataOverrides & { fmt?: string; attStmt?: CborMap } = {},
  ): Promise<RegistrationResponseJSON> {
    this.userHandle = options.user.id;
    const rpId = overrides.rpId ?? options.rp.id;
    const idLen = new Uint8Array([this.credentialId.length >> 8, this.credentialId.length & 0xff]);
    const authData = concat(
      await sha256(enc.encode(rpId)),
      new Uint8Array([this.flags(true)]),
      u32(this.nextCount()),
      new Uint8Array(16), // aaguid: zero, as with "none" attestation
      idLen,
      this.credentialId,
      this.cose,
    );
    const att: CborMap = new Map();
    att.set("fmt", overrides.fmt ?? "none");
    att.set("attStmt", overrides.attStmt ?? new Map());
    att.set("authData", authData);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: base64urlEncode(this.clientData("webauthn.create", options.challenge, origin, overrides)),
        attestationObject: base64urlEncode(encodeCbor(att)),
        transports: ["internal", "hybrid"],
      },
    };
  }

  /** Answer navigator.credentials.get() options. */
  async authenticate(
    options: { challenge: string; rpId: string },
    origin: string,
    overrides: ClientDataOverrides & { userHandle?: string | null } = {},
  ): Promise<AuthenticationResponseJSON> {
    const rpId = overrides.rpId ?? options.rpId;
    const authData = concat(
      await sha256(enc.encode(rpId)),
      new Uint8Array([this.flags(false)]),
      u32(this.nextCount()),
    );
    const clientData = this.clientData("webauthn.get", options.challenge, origin, overrides);
    const signed = concat(authData, await sha256(clientData));
    let signature: Uint8Array;
    if (this.alg === COSE_ALG_ES256) {
      signature = rawToDerEcdsa(
        new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, signed)),
      );
    } else {
      signature = new Uint8Array(await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, this.keys.privateKey, signed));
    }
    const handle = overrides.userHandle === undefined ? this.userHandle : overrides.userHandle;
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: base64urlEncode(clientData),
        authenticatorData: base64urlEncode(authData),
        signature: base64urlEncode(signature),
        userHandle: handle,
      },
    };
  }
}
