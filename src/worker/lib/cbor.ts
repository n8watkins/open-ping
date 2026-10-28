/**
 * A small, strict CBOR (RFC 8949) decoder for WebAuthn, plus an encoder that
 * the tests use to build authenticator responses.
 *
 * WebAuthn only ever sends CTAP2 canonical CBOR: definite lengths, integer or
 * text map keys, no tags and no floats. Anything else is rejected rather than
 * guessed at, and every length is checked against the input before it is read,
 * so a hostile attestation object can't make the Worker allocate or loop.
 */

export type CborValue =
  | number
  | string
  | boolean
  | null
  | undefined
  | Uint8Array
  | CborValue[]
  | CborMap;

/** CBOR maps keep their key types (COSE keys use negative integer labels). */
export type CborMap = Map<number | string, CborValue>;

export class CborError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CborError";
  }
}

const MAX_DEPTH = 16;
const MAX_ITEMS = 4096;

interface Cursor {
  bytes: Uint8Array;
  view: DataView;
  offset: number;
  items: number;
}

function need(cur: Cursor, n: number): void {
  if (n < 0 || cur.offset + n > cur.bytes.length) throw new CborError("truncated");
}

function readArgument(cur: Cursor, info: number): number {
  if (info < 24) return info;
  switch (info) {
    case 24:
      need(cur, 1);
      return cur.view.getUint8(cur.offset++);
    case 25: {
      need(cur, 2);
      const v = cur.view.getUint16(cur.offset);
      cur.offset += 2;
      return v;
    }
    case 26: {
      need(cur, 4);
      const v = cur.view.getUint32(cur.offset);
      cur.offset += 4;
      return v;
    }
    case 27: {
      need(cur, 8);
      const v = cur.view.getBigUint64(cur.offset);
      cur.offset += 8;
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new CborError("integer too large");
      return Number(v);
    }
    case 31:
      throw new CborError("indefinite length not allowed");
    default:
      throw new CborError("reserved additional information");
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

function readItem(cur: Cursor, depth: number): CborValue {
  if (depth > MAX_DEPTH) throw new CborError("nested too deeply");
  if (++cur.items > MAX_ITEMS) throw new CborError("too many items");
  need(cur, 1);
  const initial = cur.view.getUint8(cur.offset++);
  const major = initial >> 5;
  const info = initial & 0x1f;

  switch (major) {
    case 0:
      return readArgument(cur, info);
    case 1:
      return -1 - readArgument(cur, info);
    case 2: {
      const len = readArgument(cur, info);
      need(cur, len);
      const out = cur.bytes.slice(cur.offset, cur.offset + len);
      cur.offset += len;
      return out;
    }
    case 3: {
      const len = readArgument(cur, info);
      need(cur, len);
      let text: string;
      try {
        text = utf8.decode(cur.bytes.subarray(cur.offset, cur.offset + len));
      } catch {
        throw new CborError("invalid utf-8");
      }
      cur.offset += len;
      return text;
    }
    case 4: {
      const len = readArgument(cur, info);
      // Each item takes at least one byte, so a longer claim is a lie.
      need(cur, len);
      const out: CborValue[] = [];
      for (let i = 0; i < len; i++) out.push(readItem(cur, depth + 1));
      return out;
    }
    case 5: {
      const len = readArgument(cur, info);
      need(cur, len * 2);
      const out: CborMap = new Map();
      for (let i = 0; i < len; i++) {
        const key = readItem(cur, depth + 1);
        if (typeof key !== "number" && typeof key !== "string") {
          throw new CborError("map keys must be integers or text");
        }
        if (out.has(key)) throw new CborError("duplicate map key");
        out.set(key, readItem(cur, depth + 1));
      }
      return out;
    }
    case 6:
      throw new CborError("tags not allowed");
    default: {
      // Major type 7: simple values. Floats never appear in WebAuthn.
      switch (info) {
        case 20:
          return false;
        case 21:
          return true;
        case 22:
          return null;
        case 23:
          return undefined;
        default:
          throw new CborError("unsupported simple value");
      }
    }
  }
}

function cursorFor(bytes: Uint8Array): Cursor {
  return { bytes, view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset: 0, items: 0 };
}

/**
 * Decode the first CBOR item and report how many bytes it took. Authenticator
 * data embeds the credential public key as CBOR followed by more bytes, so the
 * caller needs the length.
 */
export function decodeCborFirst(bytes: Uint8Array): { value: CborValue; length: number } {
  const cur = cursorFor(bytes);
  const value = readItem(cur, 0);
  return { value, length: cur.offset };
}

/** Decode exactly one CBOR item; trailing bytes are an error. */
export function decodeCbor(bytes: Uint8Array): CborValue {
  const { value, length } = decodeCborFirst(bytes);
  if (length !== bytes.length) throw new CborError("trailing bytes");
  return value;
}

function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 0x100) return [(major << 5) | 24, n];
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];
  if (n < 0x100000000) return [(major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  throw new CborError("length too large to encode");
}

/**
 * Encode a value as CBOR (definite lengths, map entries in insertion order).
 * Used by the tests' software authenticator; the Worker itself only decodes.
 */
export function encodeCbor(value: CborValue): Uint8Array {
  const out: number[] = [];
  const write = (v: CborValue) => {
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v)) throw new CborError("only integers can be encoded");
      out.push(...(v >= 0 ? head(0, v) : head(1, -1 - v)));
    } else if (typeof v === "string") {
      const b = new TextEncoder().encode(v);
      out.push(...head(3, b.length), ...b);
    } else if (v instanceof Uint8Array) {
      out.push(...head(2, v.length), ...v);
    } else if (Array.isArray(v)) {
      out.push(...head(4, v.length));
      v.forEach(write);
    } else if (v instanceof Map) {
      out.push(...head(5, v.size));
      for (const [k, item] of v) {
        write(k);
        write(item);
      }
    } else if (v === false) out.push(0xf4);
    else if (v === true) out.push(0xf5);
    else if (v === null) out.push(0xf6);
    else out.push(0xf7);
  };
  write(value);
  return new Uint8Array(out);
}
