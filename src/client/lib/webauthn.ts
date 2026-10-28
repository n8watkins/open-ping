import { api } from "./api";

/**
 * Browser half of passkeys: turn the server's JSON options into the
 * ArrayBuffers navigator.credentials wants, and the resulting credential back
 * into base64url JSON (src/worker/lib/webauthn.ts verifies it). Written by
 * hand rather than with PublicKeyCredential.parseCreationOptionsFromJSON /
 * toJSON, which not every supported browser has yet.
 */

export function base64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of view) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface CredentialDescriptorJSON {
  type: "public-key";
  id: string;
  transports?: string[];
}

export interface CreationOptionsJSON {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: "public-key"; alg: number }[];
  timeout?: number;
  attestation?: AttestationConveyancePreference;
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  excludeCredentials?: CredentialDescriptorJSON[];
  extensions?: AuthenticationExtensionsClientInputs;
}

export interface RequestOptionsJSON {
  challenge: string;
  rpId: string;
  timeout?: number;
  userVerification?: UserVerificationRequirement;
  allowCredentials?: CredentialDescriptorJSON[];
}

function descriptor(d: CredentialDescriptorJSON): PublicKeyCredentialDescriptor {
  return { type: d.type, id: base64urlToBytes(d.id), transports: d.transports as AuthenticatorTransport[] | undefined };
}

export function toCreationOptions(o: CreationOptionsJSON): PublicKeyCredentialCreationOptions {
  return {
    ...o,
    challenge: base64urlToBytes(o.challenge),
    user: { ...o.user, id: base64urlToBytes(o.user.id) },
    excludeCredentials: o.excludeCredentials?.map(descriptor),
  };
}

export function toRequestOptions(o: RequestOptionsJSON): PublicKeyCredentialRequestOptions {
  return {
    ...o,
    challenge: base64urlToBytes(o.challenge),
    allowCredentials: o.allowCredentials?.map(descriptor),
  };
}

export function registrationToJSON(cred: PublicKeyCredential) {
  const response = cred.response as AuthenticatorAttestationResponse;
  return {
    id: bytesToBase64url(cred.rawId),
    rawId: bytesToBase64url(cred.rawId),
    type: "public-key" as const,
    response: {
      clientDataJSON: bytesToBase64url(response.clientDataJSON),
      attestationObject: bytesToBase64url(response.attestationObject),
      transports: typeof response.getTransports === "function" ? response.getTransports() : [],
    },
  };
}

export function authenticationToJSON(cred: PublicKeyCredential) {
  const response = cred.response as AuthenticatorAssertionResponse;
  return {
    id: bytesToBase64url(cred.rawId),
    rawId: bytesToBase64url(cred.rawId),
    type: "public-key" as const,
    response: {
      clientDataJSON: bytesToBase64url(response.clientDataJSON),
      authenticatorData: bytesToBase64url(response.authenticatorData),
      signature: bytesToBase64url(response.signature),
      userHandle: response.userHandle ? bytesToBase64url(response.userHandle) : null,
    },
  };
}

/** Whether this browser can use passkeys at all. */
export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function" && !!navigator.credentials;
}

/** Whether the browser can offer passkeys in an input's autofill (conditional mediation). */
export async function conditionalMediationAvailable(): Promise<boolean> {
  if (!passkeysSupported()) return false;
  const pkc = window.PublicKeyCredential as typeof PublicKeyCredential & {
    isConditionalMediationAvailable?: () => Promise<boolean>;
  };
  try {
    return (await pkc.isConditionalMediationAvailable?.()) ?? false;
  } catch {
    return false;
  }
}

/**
 * Whether a passkey bound to `rpId` can be used from this page: the page's
 * hostname must be the RP ID or a subdomain of it.
 */
export function hostMatchesRpId(rpId: string | undefined, hostname = window.location.hostname): boolean {
  if (!rpId) return false;
  return hostname === rpId || hostname.endsWith(`.${rpId}`);
}

/** Create a passkey from server options; resolves with the JSON to send back. */
export async function createPasskey(options: CreationOptionsJSON) {
  const cred = (await navigator.credentials.create({ publicKey: toCreationOptions(options) })) as PublicKeyCredential | null;
  if (!cred) throw new DOMException("No passkey was created.", "NotAllowedError");
  return registrationToJSON(cred);
}

/** Ask for a passkey assertion; `conditional` puts it in the autofill instead of a dialog. */
export async function getPasskey(
  options: RequestOptionsJSON,
  opts: { conditional?: boolean; signal?: AbortSignal } = {},
) {
  const cred = (await navigator.credentials.get({
    publicKey: toRequestOptions(options),
    mediation: opts.conditional ? ("conditional" as CredentialMediationRequirement) : undefined,
    signal: opts.signal,
  })) as PublicKeyCredential | null;
  if (!cred) throw new DOMException("No passkey was chosen.", "NotAllowedError");
  return authenticationToJSON(cred);
}

/** A friendly message for a failed create()/get() or server answer. */
export function passkeyErrorMessage(err: unknown): string {
  if (err instanceof DOMException) {
    switch (err.name) {
      case "NotAllowedError":
        return "No passkey was used. The request was cancelled or timed out, or this device has no passkey for this OpenPing.";
      case "InvalidStateError":
        return "This device already has a passkey for this OpenPing.";
      case "SecurityError":
        return "Passkeys can't be used at this address. Open OpenPing at its own address and try again.";
      case "AbortError":
        return "The passkey request was cancelled.";
      case "NotSupportedError":
        return "This browser or device can't create a passkey OpenPing accepts.";
    }
  }
  const code = err instanceof Error ? err.message : "";
  switch (code) {
    case "challenge_invalid":
      return "That took too long and expired. Please try again.";
    case "unknown_passkey":
      return "That passkey isn't registered on this OpenPing. It may have been removed.";
    case "passkey_exists":
      return "That passkey is already added.";
    case "passkey_invalid":
      return "That passkey couldn't be verified. Please try again.";
    case "rate_limited":
      return "Too many attempts. Give it a minute and try again.";
    case "origin_mismatch":
      return "Passkeys can't be used at this address. Open OpenPing at its own address and try again.";
    default:
      return "Something went wrong with the passkey. Please try again.";
  }
}

/**
 * The whole registration round trip against one of the three registration
 * endpoints (Settings, setup wizard, recovery), which all take
 * `${base}/options` with `{ name }` and `${base}/verify` with `{ credential }`.
 * `request` carries that endpoint's own auth (CSRF token or setup token).
 */
export async function registerPasskey<T>(
  base: string,
  name: string,
  request: { csrf?: string; headers?: Record<string, string> },
): Promise<T> {
  const { options } = await api<{ options: CreationOptionsJSON }>(`${base}/options`, {
    method: "POST",
    json: { name },
    ...request,
  });
  const credential = await createPasskey(options);
  return api<T>(`${base}/verify`, { method: "POST", json: { credential }, ...request });
}
