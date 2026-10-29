/**
 * Reads a server's TLS certificate with a TLS 1.2 handshake written by hand
 * (docs/SSL_EXPIRY_SPIKE.md).
 *
 * A Worker's `fetch()` and TLS sockets never show the peer certificate. But in
 * TLS 1.2 the server sends its Certificate message in the clear, right after
 * ServerHello (RFC 5246 section 7.4.2), so over a plain TCP socket a Worker can
 * send a ClientHello that offers only TLS 1.2, read the server's first flight,
 * take the leaf certificate out of it and close the socket. No key exchange and
 * no cryptography: the handshake is never finished.
 *
 * The hello offers no TLS 1.3 (no supported_versions extension), because in
 * TLS 1.3 the certificate is encrypted (RFC 8446 section 4.4.2). A server that
 * only speaks TLS 1.3 answers with a protocol_version alert, which is reported
 * as such so the monitor can say why it can't read the certificate.
 *
 * Everything here except {@link readCertificate} is pure, so it is tested with
 * byte fixtures (tls.test.ts).
 */
import { connect } from "cloudflare:sockets";

// ---------------------------------------------------------------------------
// ClientHello
// ---------------------------------------------------------------------------

/**
 * The cipher suites offered: what browsers offer for TLS 1.2, then older ones
 * an old server may still need. Only offering matters (nothing is negotiated
 * past ServerHello), and a broad list keeps a server from refusing the hello.
 */
const CIPHER_SUITES = [
  0xc02b, 0xc02f, 0xc02c, 0xc030, 0xcca9, 0xcca8, // ECDHE with AES-GCM and ChaCha20
  0xc023, 0xc027, 0xc024, 0xc028, 0xc009, 0xc013, 0xc00a, 0xc014, // ECDHE with AES-CBC
  0x009e, 0x009f, // DHE-RSA with AES-GCM
  0x009c, 0x009d, 0x003c, 0x003d, 0x002f, 0x0035, // RSA key exchange
  0x000a, // RSA with 3DES, for the oldest servers
];

/** Signature algorithms offered (RFC 8446 section 4.2.3 code points, valid for TLS 1.2). */
const SIGNATURE_ALGORITHMS = [
  0x0403, 0x0503, 0x0603, // ECDSA with SHA-256/384/512
  0x0804, 0x0805, 0x0806, // RSA-PSS
  0x0401, 0x0501, 0x0601, // RSA PKCS#1 v1.5
  0x0201, 0x0203, // SHA-1, for old servers
];

/** Named groups offered: X25519, P-256, P-384, P-521. */
const SUPPORTED_GROUPS = [0x001d, 0x0017, 0x0018, 0x0019];

const u8 = (n: number) => [n & 0xff];
const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u24 = (n: number) => [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];

function extension(type: number, body: number[]): number[] {
  return [...u16(type), ...u16(body.length), ...body];
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * A TLS 1.2-only ClientHello record for `host`. SNI carries the host name (not
 * an IP literal, which SNI doesn't allow), so the server picks the certificate
 * it serves for that name. `random` is the 32-byte client random.
 */
export function buildClientHello(host: string, random: Uint8Array): Uint8Array {
  if (random.length !== 32) throw new Error("client random must be 32 bytes");
  const name = host.replace(/\.$/, "").toLowerCase();
  const extensions: number[] = [];
  if (!IPV4.test(name) && !name.includes(":")) {
    const bytes = [...new TextEncoder().encode(name)];
    const entry = [0x00, ...u16(bytes.length), ...bytes]; // host_name
    extensions.push(...extension(0x0000, [...u16(entry.length), ...entry]));
  }
  const groups = SUPPORTED_GROUPS.flatMap(u16);
  extensions.push(...extension(0x000a, [...u16(groups.length), ...groups]));
  extensions.push(...extension(0x000b, [1, 0])); // ec_point_formats: uncompressed
  const sigs = SIGNATURE_ALGORITHMS.flatMap(u16);
  extensions.push(...extension(0x000d, [...u16(sigs.length), ...sigs]));
  extensions.push(...extension(0x0017, [])); // extended_master_secret
  extensions.push(...extension(0x0023, [])); // session_ticket
  extensions.push(...extension(0xff01, [0])); // renegotiation_info (initial handshake)
  const alpn = [...new TextEncoder().encode("http/1.1")];
  const protocols = [...u8(alpn.length), ...alpn];
  extensions.push(...extension(0x0010, [...u16(protocols.length), ...protocols]));

  const suites = CIPHER_SUITES.flatMap(u16);
  const body = [
    0x03, 0x03, // client_version: TLS 1.2
    ...random,
    0, // session_id: empty
    ...u16(suites.length),
    ...suites,
    1, 0, // compression_methods: null
    ...u16(extensions.length),
    ...extensions,
  ];
  const handshake = [0x01, ...u24(body.length), ...body]; // client_hello
  // Record version 1.0 for the hello, as browsers send it: some old servers
  // reject a first record marked 1.2.
  return Uint8Array.from([0x16, 0x03, 0x01, ...u16(handshake.length), ...handshake]);
}

// ---------------------------------------------------------------------------
// The server's first flight
// ---------------------------------------------------------------------------

/** What the server's answer to the hello was. */
export type ServerFlight =
  /** The leaf certificate (DER) and how many certificates the chain held. */
  | { kind: "certificate"; der: Uint8Array; chainLength: number }
  /** The server refused the hello with a TLS alert (RFC 5246 section 7.2). */
  | { kind: "alert"; level: number; description: number }
  /** The answer was not a TLS handshake we can read. */
  | { kind: "malformed"; reason: "not_tls" | "bad_handshake" | "no_certificate" | "too_large" | "too_fragmented" };

/** TLS alert descriptions, for messages (RFC 5246 section 7.2, RFC 8446 section 6). */
export const ALERT_NAMES: Record<number, string> = {
  0: "close_notify",
  10: "unexpected_message",
  20: "bad_record_mac",
  22: "record_overflow",
  40: "handshake_failure",
  42: "bad_certificate",
  47: "illegal_parameter",
  50: "decode_error",
  51: "decrypt_error",
  70: "protocol_version",
  71: "insufficient_security",
  80: "internal_error",
  86: "inappropriate_fallback",
  90: "user_canceled",
  109: "missing_extension",
  110: "unsupported_extension",
  112: "unrecognized_name",
  116: "certificate_required",
  120: "no_application_protocol",
};

/** The protocol_version alert: the server won't speak TLS 1.2. */
export const ALERT_PROTOCOL_VERSION = 70;

/** The most of the server's answer read before giving up (a long chain is about 10 KB). */
export const MAX_FLIGHT_BYTES = 128 * 1024;
/** The most TLS records read (a real first flight is a handful). */
export const MAX_FLIGHT_RECORDS = 64;
/** The most reads from the socket (a real first flight arrives in a few dozen at most). */
export const MAX_FLIGHT_READS = 512;

const RECORD_HANDSHAKE = 0x16;
const RECORD_ALERT = 0x15;
const ALERT_LEVEL_WARNING = 1;
const HANDSHAKE_SERVER_HELLO = 2;
const HANDSHAKE_CERTIFICATE = 11;
const HANDSHAKE_SERVER_HELLO_DONE = 14;

/**
 * A byte queue that appends in place and consumes by moving an offset, so a
 * server sending its answer a byte at a time costs linear, not quadratic, work.
 * It never holds more than MAX_FLIGHT_BYTES (the reader stops before that).
 */
class ByteQueue {
  private buf = new Uint8Array(4096);
  private start = 0;
  private end = 0;

  get length(): number {
    return this.end - this.start;
  }

  append(chunk: Uint8Array): void {
    if (this.end + chunk.length > this.buf.length) {
      const needed = this.length + chunk.length;
      if (needed <= this.buf.length) {
        this.buf.copyWithin(0, this.start, this.end);
      } else {
        const grown = new Uint8Array(Math.max(needed, this.buf.length * 2));
        grown.set(this.buf.subarray(this.start, this.end));
        this.buf = grown;
      }
      this.end -= this.start;
      this.start = 0;
    }
    this.buf.set(chunk, this.end);
    this.end += chunk.length;
  }

  byte(i: number): number {
    return this.buf[this.start + i]!;
  }

  /** A view of `len` bytes from `i`; valid until the next append. */
  view(i: number, len: number): Uint8Array {
    return this.buf.subarray(this.start + i, this.start + i + len);
  }

  consume(n: number): void {
    this.start += n;
    if (this.start === this.end) this.start = this.end = 0;
  }
}

/**
 * Reads the server's answer as it arrives, one chunk at a time. `push` returns
 * the result once there is one, and null while it needs more bytes.
 *
 * A hostile or broken server can't make it spend much: it gives up after
 * MAX_FLIGHT_BYTES, MAX_FLIGHT_RECORDS records or MAX_FLIGHT_READS reads, at
 * once when a record or handshake message declares more than that, and on an
 * empty record. Each byte is copied a bounded number of times (tls.test.ts
 * measures the worst cases).
 */
export class ServerFlightReader {
  private records = new ByteQueue();
  private handshake = new ByteQueue();
  private total = 0;
  private reads = 0;
  private recordCount = 0;
  private sawServerHello = false;
  private done: ServerFlight | null = null;

  push(chunk: Uint8Array): ServerFlight | null {
    if (this.done) return this.done;
    this.total += chunk.length;
    if (this.total > MAX_FLIGHT_BYTES) return (this.done = { kind: "malformed", reason: "too_large" });
    if (++this.reads > MAX_FLIGHT_READS) return (this.done = { kind: "malformed", reason: "too_fragmented" });
    this.records.append(chunk);
    const q = this.records;
    for (;;) {
      if (q.length < 5) return null;
      const type = q.byte(0);
      const length = (q.byte(3) << 8) | q.byte(4);
      // A TLS record: a known content type, version 3.x, at most 2^14 + 2048 bytes.
      if (type < 0x14 || type > 0x18 || q.byte(1) !== 3 || length > 18432) {
        return (this.done = { kind: "malformed", reason: "not_tls" });
      }
      if (length === 0) return (this.done = { kind: "malformed", reason: "bad_handshake" });
      if (q.length < 5 + length) return null;
      if (++this.recordCount > MAX_FLIGHT_RECORDS) {
        return (this.done = { kind: "malformed", reason: "too_fragmented" });
      }
      const fragment = q.view(5, length);
      if (type === RECORD_ALERT) {
        if (length !== 2) return (this.done = { kind: "malformed", reason: "bad_handshake" });
        const level = fragment[0]!;
        const description = fragment[1]!;
        q.consume(5 + length);
        // A warning (unrecognized_name, say) doesn't end the handshake: read on.
        if (level === ALERT_LEVEL_WARNING) continue;
        return (this.done = { kind: "alert", level, description });
      }
      if (type !== RECORD_HANDSHAKE) {
        // ChangeCipherSpec or application data before a certificate: not a
        // TLS 1.2 handshake we can read.
        return (this.done = { kind: "malformed", reason: "bad_handshake" });
      }
      this.handshake.append(fragment);
      q.consume(5 + length);
      const result = this.readHandshake();
      if (result) return (this.done = result);
    }
  }

  /** Walks, and consumes, the complete handshake messages received so far. */
  private readHandshake(): ServerFlight | null {
    const hs = this.handshake;
    while (hs.length >= 4) {
      const type = hs.byte(0);
      const len = (hs.byte(1) << 16) | (hs.byte(2) << 8) | hs.byte(3);
      // Waiting for a message bigger than we'd ever read is pointless.
      if (len > MAX_FLIGHT_BYTES) return { kind: "malformed", reason: "too_large" };
      if (hs.length - 4 < len) return null;
      if (type === HANDSHAKE_SERVER_HELLO) {
        this.sawServerHello = true;
      } else if (!this.sawServerHello) {
        return { kind: "malformed", reason: "bad_handshake" };
      } else if (type === HANDSHAKE_CERTIFICATE) {
        return parseCertificateMessage(hs.view(4, len));
      } else if (type === HANDSHAKE_SERVER_HELLO_DONE) {
        return { kind: "malformed", reason: "no_certificate" };
      }
      // Anything else (a status message, say): skip it and keep reading.
      hs.consume(4 + len);
    }
    return null;
  }
}

/** The leaf certificate of a TLS 1.2 Certificate message (RFC 5246 section 7.4.2). */
function parseCertificateMessage(body: Uint8Array): ServerFlight {
  if (body.length < 3) return { kind: "malformed", reason: "bad_handshake" };
  const listLen = (body[0]! << 16) | (body[1]! << 8) | body[2]!;
  if (listLen + 3 > body.length) return { kind: "malformed", reason: "bad_handshake" };
  let off = 3;
  let leaf: Uint8Array | null = null;
  let count = 0;
  while (off + 3 <= 3 + listLen) {
    const len = (body[off]! << 16) | (body[off + 1]! << 8) | body[off + 2]!;
    off += 3;
    if (off + len > 3 + listLen) return { kind: "malformed", reason: "bad_handshake" };
    // Only the leaf is kept (copied out of the reader's buffer).
    if (!leaf) leaf = body.slice(off, off + len);
    count++;
    off += len;
  }
  if (!leaf) return { kind: "malformed", reason: "no_certificate" };
  return { kind: "certificate", der: leaf, chainLength: count };
}

// ---------------------------------------------------------------------------
// X.509 (just the fields the monitor shows)
// ---------------------------------------------------------------------------

/** What the monitor shows of a certificate. */
export interface CertificateInfo {
  /** The subject's common name, when it has one. */
  subject: string | null;
  /** The issuer's organization and common name, e.g. "Let's Encrypt" and "R11". */
  issuerOrg: string | null;
  issuerName: string | null;
  /** notBefore and notAfter (epoch ms). */
  validFrom: number;
  validTo: number;
  /** DNS names and IP addresses from the subjectAltName extension, at most MAX_SANS. */
  sans: string[];
  /** How many names the extension held, when there were more than MAX_SANS. */
  sanCount: number;
  /** The serial number, in hex. */
  serial: string;
}

/** The most subjectAltName entries kept (a CDN certificate can list hundreds). */
export const MAX_SANS = 100;

interface Tlv {
  tag: number;
  /** Where the value starts and ends. */
  start: number;
  end: number;
}

class DerError extends Error {}

function readTlv(buf: Uint8Array, off: number, limit = buf.length): Tlv {
  if (off + 2 > limit) throw new DerError("truncated");
  const tag = buf[off]!;
  let len = buf[off + 1]!;
  let start = off + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || start + n > limit) throw new DerError("bad length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[start + i]!;
    start += n;
  }
  const end = start + len;
  if (end > limit) throw new DerError("truncated");
  return { tag, start, end };
}

/** The children of a constructed value. */
function children(buf: Uint8Array, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let off = parent.start;
  while (off < parent.end) {
    const t = readTlv(buf, off, parent.end);
    out.push(t);
    off = t.end;
  }
  return out;
}

const OID_CN = "2.5.4.3";
const OID_O = "2.5.4.10";
const OID_SAN = "2.5.29.17";

function decodeOid(bytes: Uint8Array): string {
  if (!bytes.length) return "";
  const parts = [Math.floor(bytes[0]! / 40), bytes[0]! % 40];
  let v = 0;
  for (let i = 1; i < bytes.length; i++) {
    v = v * 128 + (bytes[i]! & 0x7f);
    if (!(bytes[i]! & 0x80)) {
      parts.push(v);
      v = 0;
    }
  }
  return parts.join(".");
}

function decodeString(tag: number, bytes: Uint8Array): string | null {
  switch (tag) {
    case 0x0c: // UTF8String
      return new TextDecoder().decode(bytes);
    case 0x13: // PrintableString
    case 0x16: // IA5String
    case 0x14: // TeletexString, read as Latin-1
    case 0x1a: // VisibleString
      return String.fromCharCode(...bytes);
    case 0x1e: {
      // BMPString: UTF-16 big-endian
      let s = "";
      for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
      return s;
    }
    default:
      return null;
  }
}

/** The common name and organization of an X.509 Name. */
function readName(buf: Uint8Array, name: Tlv): { cn: string | null; o: string | null } {
  let cn: string | null = null;
  let o: string | null = null;
  for (const set of children(buf, name)) {
    for (const atv of children(buf, set)) {
      const [type, value] = children(buf, atv);
      if (!type || !value || type.tag !== 0x06) continue;
      const oid = decodeOid(buf.subarray(type.start, type.end));
      const text = decodeString(value.tag, buf.subarray(value.start, value.end));
      if (oid === OID_CN && cn === null) cn = text;
      if (oid === OID_O && o === null) o = text;
    }
  }
  return { cn, o };
}

/** UTCTime (YYMMDDHHMMSSZ) or GeneralizedTime (YYYYMMDDHHMMSSZ) as epoch ms. */
function readTime(buf: Uint8Array, t: Tlv): number {
  const s = String.fromCharCode(...buf.subarray(t.start, t.end));
  let m: RegExpMatchArray | null;
  let year: number;
  if (t.tag === 0x17 && (m = s.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/))) {
    const yy = Number(m[1]);
    year = yy >= 50 ? 1900 + yy : 2000 + yy; // RFC 5280 section 4.1.2.5.1
  } else if (t.tag === 0x18 && (m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\.\d+)?Z$/))) {
    year = Number(m[1]);
  } else {
    throw new DerError(`unreadable time ${s}`);
  }
  return Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
}

function readSans(buf: Uint8Array, value: Tlv): { names: string[]; count: number } {
  const names: string[] = [];
  let count = 0;
  const seq = readTlv(buf, value.start, value.end);
  for (const gn of children(buf, seq)) {
    const bytes = buf.subarray(gn.start, gn.end);
    let name: string | null = null;
    if (gn.tag === 0x82) name = String.fromCharCode(...bytes); // dNSName
    else if (gn.tag === 0x87 && bytes.length === 4) name = [...bytes].join("."); // iPAddress v4
    else if (gn.tag === 0x87 && bytes.length === 16) {
      const groups: string[] = [];
      for (let i = 0; i < 16; i += 2) groups.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16));
      name = groups.join(":");
    }
    if (name === null) continue;
    count++;
    if (names.length < MAX_SANS) names.push(name);
  }
  return { names, count };
}

/** The fields the monitor shows, read from a DER certificate. Throws on anything unreadable. */
export function parseCertificate(der: Uint8Array): CertificateInfo {
  const cert = readTlv(der, 0);
  if (cert.tag !== 0x30) throw new DerError("not a certificate");
  const tbs = children(der, cert)[0];
  if (!tbs || tbs.tag !== 0x30) throw new DerError("no tbsCertificate");
  const f = children(der, tbs);
  let i = f[0]?.tag === 0xa0 ? 1 : 0; // [0] version
  const serial = f[i++];
  i++; // signature algorithm
  const issuer = f[i++];
  const validity = f[i++];
  const subject = f[i++];
  i++; // subjectPublicKeyInfo
  if (!serial || serial.tag !== 0x02 || !issuer || !validity || validity.tag !== 0x30 || !subject) {
    throw new DerError("incomplete tbsCertificate");
  }
  const [notBefore, notAfter] = children(der, validity);
  if (!notBefore || !notAfter) throw new DerError("no validity");

  let sans: { names: string[]; count: number } = { names: [], count: 0 };
  const extsWrapper = f.slice(i).find((t) => t.tag === 0xa3);
  if (extsWrapper) {
    const exts = readTlv(der, extsWrapper.start, extsWrapper.end);
    for (const ext of children(der, exts)) {
      const parts = children(der, ext);
      const oid = parts[0];
      const value = parts[parts.length - 1];
      if (oid?.tag === 0x06 && value?.tag === 0x04 && decodeOid(der.subarray(oid.start, oid.end)) === OID_SAN) {
        sans = readSans(der, value);
      }
    }
  }

  const iss = readName(der, issuer);
  const sub = readName(der, subject);
  return {
    subject: sub.cn,
    issuerOrg: iss.o,
    issuerName: iss.cn,
    validFrom: readTime(der, notBefore),
    validTo: readTime(der, notAfter),
    sans: sans.names,
    sanCount: sans.count,
    serial: [...der.subarray(serial.start, serial.end)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .replace(/^00(?=.)/, ""),
  };
}

/**
 * Whether the certificate covers `host`, by its subjectAltNames (or, without
 * any, its common name), with a wildcard matching exactly one leftmost label
 * (RFC 6125 section 6.4.3).
 */
export function certificateCovers(cert: Pick<CertificateInfo, "sans" | "subject">, host: string): boolean {
  const target = host.replace(/\.$/, "").toLowerCase();
  const names = cert.sans.length ? cert.sans : cert.subject ? [cert.subject] : [];
  return names.some((raw) => {
    const name = raw.replace(/\.$/, "").toLowerCase();
    if (name === target) return true;
    if (!name.startsWith("*.")) return false;
    const suffix = name.slice(1); // ".example.com"
    const label = target.slice(0, target.length - suffix.length);
    return target.endsWith(suffix) && label.length > 0 && !label.includes(".");
  });
}

// ---------------------------------------------------------------------------
// Over the network
// ---------------------------------------------------------------------------

/** What reading one server's certificate found. */
export type TlsReadResult =
  | { ok: true; cert: CertificateInfo; chainLength: number; durationMs: number }
  | {
      ok: false;
      /**
       * connect_failed: the socket didn't open (refused, unreachable, or the
       * runtime refused to connect, as it does for Cloudflare's own IPs);
       * timeout: no answer in time; closed: the server closed the connection
       * before sending a certificate; alert: it refused the hello; malformed:
       * it answered with something we can't read.
       */
      kind: "connect_failed" | "timeout" | "closed" | "alert" | "malformed";
      message: string;
      /** For an alert, its description code. */
      alert?: number;
      durationMs: number;
    };

/** A socket as `cloudflare:sockets` `connect()` returns it, as far as the reader uses it. */
export interface TlsSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened: Promise<unknown>;
  close(): Promise<void>;
}

export type ConnectFn = (address: { hostname: string; port: number }) => TlsSocket;

const plainConnect: ConnectFn = (address) => connect(address, { secureTransport: "off", allowHalfOpen: false });

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Connects to `host:port`, sends the TLS 1.2 hello and reads the server's
 * certificate, all within `timeoutMs`. Never throws. `connectFn` is for tests.
 */
export async function readCertificate(
  host: string,
  port: number,
  timeoutMs: number,
  connectFn: ConnectFn = plainConnect,
): Promise<TlsReadResult> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  let socket: TlsSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stage: "connect" | "read" = "connect";
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  const work = async (): Promise<TlsReadResult> => {
    try {
      socket = connectFn({ hostname: host, port });
      await socket.opened;
    } catch (err) {
      return { ok: false, kind: "connect_failed", message: describeError(err), durationMs: elapsed() };
    }
    stage = "read";
    try {
      const writer = socket.writable.getWriter();
      await writer.write(buildClientHello(host, crypto.getRandomValues(new Uint8Array(32))));
      writer.releaseLock();
      const reader = socket.readable.getReader();
      const flight = new ServerFlightReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          return {
            ok: false,
            kind: "closed",
            message: "the server closed the connection before sending its certificate",
            durationMs: elapsed(),
          };
        }
        const r = flight.push(value);
        if (!r) continue;
        reader.releaseLock();
        if (r.kind === "alert") {
          const name = ALERT_NAMES[r.description] ?? "unknown";
          return {
            ok: false,
            kind: "alert",
            alert: r.description,
            message: `the server refused the TLS 1.2 handshake (alert ${r.description}, ${name})`,
            durationMs: elapsed(),
          };
        }
        if (r.kind === "malformed") {
          const why = {
            not_tls: "the server's answer isn't TLS (is this a TLS port?)",
            bad_handshake: "the server's TLS handshake couldn't be read",
            no_certificate: "the server sent no certificate",
            too_large: "the server's handshake was too large to read",
            too_fragmented: "the server sent its handshake in too many pieces to read",
          }[r.reason];
          return { ok: false, kind: "malformed", message: why, durationMs: elapsed() };
        }
        try {
          return { ok: true, cert: parseCertificate(r.der), chainLength: r.chainLength, durationMs: elapsed() };
        } catch (err) {
          return {
            ok: false,
            kind: "malformed",
            message: `the server's certificate couldn't be read (${describeError(err)})`,
            durationMs: elapsed(),
          };
        }
      }
    } catch (err) {
      return {
        ok: false,
        kind: "closed",
        message: `the connection failed during the handshake (${describeError(err)})`,
        durationMs: elapsed(),
      };
    }
  };

  try {
    const r = await Promise.race([work(), timeout]);
    if (r !== "timeout") return r;
    return {
      ok: false,
      kind: "timeout",
      message:
        stage === "connect"
          ? `connecting to ${host}:${port} took longer than ${timeoutMs}ms`
          : `the server sent no certificate within ${timeoutMs}ms`,
      durationMs: elapsed(),
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (socket) await socket.close().catch(() => {});
  }
}
