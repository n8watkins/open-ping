import { describe, expect, it } from "vitest";
import {
  ALERT_PROTOCOL_VERSION,
  buildClientHello,
  certificateCovers,
  MAX_FLIGHT_BYTES,
  MAX_FLIGHT_READS,
  parseCertificate,
  readCertificate,
  ServerFlightReader,
  type ConnectFn,
  type TlsSocket,
} from "./tls";

// Fixtures made with openssl 3.0 (`openssl req -x509` with an EC key) and read
// back with `openssl x509 -noout -dates -serial -ext subjectAltName`:
//   A: O=OpenPing Test CA, CN=example.test, self-issued, UTCTime validity
//      Oct 29 05:23:35 2026 GMT to Jan 27 05:23:35 2027 GMT, serial
//      0A77A79C1FEFE9F23EFAD2226E3AFEAC3EA19423, SAN DNS:example.test,
//      DNS:*.example.test, IP:192.0.2.1.
//   B: CN=long.example.test, no extensions, notAfter Mar 16 05:23:35 2054 GMT
//      (GeneralizedTime, as RFC 5280 requires from 2050).
const CERT_A = Buffer.from(
  "MIIB6jCCAZCgAwIBAgIUCnennB/v6fI++tIibjr+rD6hlCMwCgYIKoZIzj0EAwIwMjEZMBcGA1UECgwQT3BlblBpbmcgVGVzdCBDQTEVMBMGA1UEAwwMZXhhbXBsZS50ZXN0MB4XDTI2MTAyOTA1MjMzNVoXDTI3MDEyNzA1MjMzNVowMjEZMBcGA1UECgwQT3BlblBpbmcgVGVzdCBDQTEVMBMGA1UEAwwMZXhhbXBsZS50ZXN0MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAERKu2jyUUQ43KXcdprO0O0TZpkr9C6X0PSV6h/NktcDbMGkmg0uXAWov8r/FKnLY0UJSU70I0XiANVVhyONXlTKOBgzCBgDAdBgNVHQ4EFgQUuiCOsbK7tV/6Yb3EMR2HmJrQo+0wHwYDVR0jBBgwFoAUuiCOsbK7tV/6Yb3EMR2HmJrQo+0wDwYDVR0TAQH/BAUwAwEB/zAtBgNVHREEJjAkggxleGFtcGxlLnRlc3SCDiouZXhhbXBsZS50ZXN0hwTAAAIBMAoGCCqGSM49BAMCA0gAMEUCIGP01s3hpatVJjyG2AZ9oMFBIzM6yO/qAu7SIMi1gkZBAiEAnLSnk7mOpyDqhwqpLMzwfN9FAEDwdy49FrZGERQGSwQ=",
  "base64",
);
const CERT_B = Buffer.from(
  "MIIBjjCCATWgAwIBAgIUbAFs6AyPhy2sG8rq+IBaYh41a4cwCgYIKoZIzj0EAwIwHDEaMBgGA1UEAwwRbG9uZy5leGFtcGxlLnRlc3QwIBcNMjYxMDI5MDUyMzM1WhgPMjA1NDAzMTYwNTIzMzVaMBwxGjAYBgNVBAMMEWxvbmcuZXhhbXBsZS50ZXN0MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAERKu2jyUUQ43KXcdprO0O0TZpkr9C6X0PSV6h/NktcDbMGkmg0uXAWov8r/FKnLY0UJSU70I0XiANVVhyONXlTKNTMFEwHQYDVR0OBBYEFLogjrGyu7Vf+mG9xDEdh5ia0KPtMB8GA1UdIwQYMBaAFLogjrGyu7Vf+mG9xDEdh5ia0KPtMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDRwAwRAIga3lxBz7aq1ublvi6x9N8QmbS5dpGbcg6LZBcdJVS3BQCIFJeRkY7245zEoAh8P35xyKLR36uoAz1cIjYL17gGm6j",
  "base64",
);

// --- A fake server's first flight -------------------------------------------

const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u24 = (n: number) => [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const record = (type: number, body: number[]) => [type, 0x03, 0x03, ...u16(body.length), ...body];
const handshake = (type: number, body: number[]) => [type, ...u24(body.length), ...body];
const serverHello = handshake(2, [0x03, 0x03, ...new Array(32).fill(7), 0, 0xc0, 0x2f, 0]);
const certificateMsg = (...certs: Uint8Array[]) => {
  const list = certs.flatMap((c) => [...u24(c.length), ...c]);
  return handshake(11, [...u24(list.length), ...list]);
};
const helloDone = handshake(14, []);

/** ServerHello, Certificate and ServerHelloDone, each in its own record, as most servers send them. */
function flight(...certs: Uint8Array[]): Uint8Array {
  return Uint8Array.from([
    ...record(0x16, serverHello),
    ...record(0x16, certificateMsg(...certs)),
    ...record(0x16, helloDone),
  ]);
}

describe("buildClientHello", () => {
  const hello = buildClientHello("Example.COM.", new Uint8Array(32).fill(1));
  const bytes = [...hello];

  it("is one handshake record carrying a TLS 1.2 client_hello", () => {
    expect(bytes.slice(0, 3)).toEqual([0x16, 0x03, 0x01]);
    expect((bytes[3]! << 8) | bytes[4]!).toBe(bytes.length - 5);
    expect(bytes[5]).toBe(0x01); // client_hello
    expect(bytes.slice(9, 11)).toEqual([0x03, 0x03]); // client_version
  });

  it("sends the host name (lowercase, no trailing dot) as SNI", () => {
    const sni = new TextDecoder().decode(hello).includes("example.com");
    expect(sni).toBe(true);
    expect(new TextDecoder().decode(hello).includes("Example")).toBe(false);
  });

  it("never offers TLS 1.3 (no supported_versions extension)", () => {
    // Walk the extensions: type 0x002b must be absent.
    let off = 5 + 4 + 2 + 32;
    off += 1 + bytes[off]!; // session id
    off += 2 + ((bytes[off]! << 8) | bytes[off + 1]!); // cipher suites
    off += 1 + bytes[off]!; // compression
    const end = off + 2 + ((bytes[off]! << 8) | bytes[off + 1]!);
    off += 2;
    const types: number[] = [];
    while (off < end) {
      types.push((bytes[off]! << 8) | bytes[off + 1]!);
      off += 4 + ((bytes[off + 2]! << 8) | bytes[off + 3]!);
    }
    expect(off).toBe(bytes.length);
    expect(types).toContain(0x0000); // server_name
    expect(types).not.toContain(0x002b);
  });

  it("sends no SNI for an IP address", () => {
    const ip = buildClientHello("192.0.2.1", new Uint8Array(32));
    expect(new TextDecoder().decode(ip).includes("192.0.2.1")).toBe(false);
  });

  it("refuses a random of the wrong size", () => {
    expect(() => buildClientHello("example.com", new Uint8Array(16))).toThrow();
  });
});

describe("parseCertificate", () => {
  it("reads issuer, subject, validity (UTCTime), names and serial", () => {
    const c = parseCertificate(CERT_A);
    expect(c).toEqual({
      subject: "example.test",
      issuerOrg: "OpenPing Test CA",
      issuerName: "example.test",
      validFrom: Date.UTC(2026, 9, 29, 5, 23, 35),
      validTo: Date.UTC(2027, 0, 27, 5, 23, 35),
      sans: ["example.test", "*.example.test", "192.0.2.1"],
      sanCount: 3,
      serial: "0a77a79c1fefe9f23efad2226e3afeac3ea19423",
    });
  });

  it("reads GeneralizedTime and a certificate without extensions", () => {
    const c = parseCertificate(CERT_B);
    expect(c.validTo).toBe(Date.UTC(2054, 2, 16, 5, 23, 35));
    expect(c.sans).toEqual([]);
    expect(c.issuerOrg).toBeNull();
    expect(c.subject).toBe("long.example.test");
  });

  it("throws on bytes that aren't a certificate", () => {
    expect(() => parseCertificate(new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x00]))).toThrow();
    expect(() => parseCertificate(CERT_A.subarray(0, 100))).toThrow();
    expect(() => parseCertificate(new Uint8Array([0x04, 0x00]))).toThrow();
  });
});

describe("certificateCovers", () => {
  const cert = { sans: ["example.test", "*.example.test"], subject: "ignored.test" };
  it("matches exact names and one wildcard label", () => {
    expect(certificateCovers(cert, "example.test")).toBe(true);
    expect(certificateCovers(cert, "WWW.Example.test.")).toBe(true);
    expect(certificateCovers(cert, "a.b.example.test")).toBe(false);
    expect(certificateCovers(cert, "other.test")).toBe(false);
    expect(certificateCovers(cert, "ignored.test")).toBe(false);
  });
  it("falls back to the common name only without subjectAltNames", () => {
    expect(certificateCovers({ sans: [], subject: "long.example.test" }, "long.example.test")).toBe(true);
    expect(certificateCovers({ sans: [], subject: null }, "long.example.test")).toBe(false);
  });
});

describe("ServerFlightReader", () => {
  it("finds the leaf certificate, however the bytes are split", () => {
    const bytes = flight(CERT_A, CERT_B);
    for (const size of [3, 5, 7, 64, 500, bytes.length]) {
      const reader = new ServerFlightReader();
      let result = null;
      for (let i = 0; i < bytes.length && !result; i += size) result = reader.push(bytes.subarray(i, i + size));
      expect(result, `chunks of ${size}`).toMatchObject({ kind: "certificate", chainLength: 2 });
      expect(Buffer.from((result as { der: Uint8Array }).der).equals(CERT_A)).toBe(true);
    }
  });

  it("reads handshake messages packed into one record", () => {
    const bytes = Uint8Array.from(record(0x16, [...serverHello, ...certificateMsg(CERT_B), ...helloDone]));
    expect(new ServerFlightReader().push(bytes)).toMatchObject({ kind: "certificate", chainLength: 1 });
  });

  it("reports a TLS alert (a TLS 1.3-only server's protocol_version)", () => {
    const r = new ServerFlightReader().push(Uint8Array.from(record(0x15, [2, ALERT_PROTOCOL_VERSION])));
    expect(r).toEqual({ kind: "alert", level: 2, description: 70 });
  });

  it("says when the answer isn't TLS", () => {
    const r = new ServerFlightReader().push(new TextEncoder().encode("HTTP/1.1 400 Bad Request\r\n\r\n"));
    expect(r).toEqual({ kind: "malformed", reason: "not_tls" });
  });

  it("says when the server sends no certificate", () => {
    const bytes = Uint8Array.from([...record(0x16, serverHello), ...record(0x16, helloDone)]);
    expect(new ServerFlightReader().push(bytes)).toEqual({ kind: "malformed", reason: "no_certificate" });
  });

  it("refuses a certificate before ServerHello, and encrypted records", () => {
    expect(new ServerFlightReader().push(Uint8Array.from(record(0x16, certificateMsg(CERT_A))))).toEqual({
      kind: "malformed",
      reason: "bad_handshake",
    });
    expect(new ServerFlightReader().push(Uint8Array.from(record(0x17, [1, 2, 3])))).toEqual({
      kind: "malformed",
      reason: "bad_handshake",
    });
  });

  it("gives up at once on a handshake message bigger than anything it would read", () => {
    const reader = new ServerFlightReader();
    expect(reader.push(Uint8Array.from(record(0x16, serverHello)))).toBeNull();
    // A Certificate message that claims 16 MB.
    expect(reader.push(Uint8Array.from(record(0x16, [11, 0xff, 0xff, 0xff])))).toEqual({
      kind: "malformed",
      reason: "too_large",
    });
  });

  it("gives up once the answer passes MAX_FLIGHT_BYTES", () => {
    const reader = new ServerFlightReader();
    reader.push(Uint8Array.from(record(0x16, serverHello)));
    // A Certificate message just under the limit, then filler that never completes it.
    reader.push(Uint8Array.from(record(0x16, [11, ...u24(MAX_FLIGHT_BYTES - 1)])));
    let r = null;
    const filler = Uint8Array.from(record(0x16, new Array(16000).fill(0)));
    for (let i = 0; i < 20 && !r; i++) r = reader.push(filler);
    expect(r).toEqual({ kind: "malformed", reason: "too_large" });
  });

  it("refuses an empty record", () => {
    expect(new ServerFlightReader().push(Uint8Array.from(record(0x16, [])))).toEqual({
      kind: "malformed",
      reason: "bad_handshake",
    });
  });

  it("reads past a warning alert (an unrecognized_name warning, say)", () => {
    const bytes = Uint8Array.from([...record(0x15, [1, 112]), ...flight(CERT_A)]);
    expect(new ServerFlightReader().push(bytes)).toMatchObject({ kind: "certificate" });
  });

  it("refuses an answer dribbled a byte per read, or a byte per record", () => {
    const bytes = flight(CERT_A, CERT_B);
    const reader = new ServerFlightReader();
    let r = null;
    let reads = 0;
    for (let i = 0; i < bytes.length && !r; i++, reads++) r = reader.push(bytes.subarray(i, i + 1));
    expect(r).toEqual({ kind: "malformed", reason: "too_fragmented" });
    expect(reads).toBe(MAX_FLIGHT_READS + 1);

    const tiny = new ServerFlightReader();
    tiny.push(Uint8Array.from(record(0x16, serverHello)));
    const oneByte = Uint8Array.from(Array.from({ length: 100 }, () => record(0x16, [0])).flat());
    expect(tiny.push(oneByte)).toEqual({ kind: "malformed", reason: "too_fragmented" });
  });


  it("needs more bytes while a record is incomplete", () => {
    const bytes = flight(CERT_A);
    expect(new ServerFlightReader().push(bytes.subarray(0, 20))).toBeNull();
  });
});

// --- readCertificate over a fake socket --------------------------------------

function fakeSocket(opts: {
  opened?: Promise<unknown>;
  answer?: Uint8Array[];
  /** Never answer (a server that hangs). */
  silent?: boolean;
}): { connect: ConnectFn; written: Uint8Array[]; closed: () => boolean } {
  const written: Uint8Array[] = [];
  let closed = false;
  const connect: ConnectFn = () => {
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        if (opts.silent) return;
        for (const chunk of opts.answer ?? []) controller.enqueue(chunk);
        controller.close();
      },
    });
    const writable = new WritableStream<Uint8Array>({ write: (c) => void written.push(c) });
    const socket: TlsSocket = {
      readable,
      writable,
      opened: opts.opened ?? Promise.resolve({}),
      close: async () => {
        closed = true;
      },
    };
    return socket;
  };
  return { connect, written, closed: () => closed };
}

// The worst a hostile server can make the reader do, in CPU time. A Free-plan
// Worker run has 10 ms of CPU for everything, so each case must stay far below
// that. Measured 2026-10-28 in Node: 0.02 to 0.27 ms per case; the bound
// leaves room for a slow CI machine and is still far under the quadratic
// copying this replaced (126 to 265 ms measured).
describe("ServerFlightReader worst cases", () => {
  const cpuMs = (fn: () => void) => {
    const before = process.cpuUsage();
    fn();
    const used = process.cpuUsage(before);
    return (used.user + used.system) / 1000;
  };
  const drain = (reader: ServerFlightReader, chunks: Uint8Array[]) => {
    for (const c of chunks) if (reader.push(c)) return;
  };
  const cases: Record<string, () => Uint8Array[]> = {
    "a byte per read": () => {
      const filler = Uint8Array.from([...record(0x16, serverHello), ...record(0x16, [11, ...u24(100_000)])]);
      return Array.from({ length: 2000 }, (_, i) => filler.subarray(i % filler.length, (i % filler.length) + 1));
    },
    "a byte per record": () => [
      Uint8Array.from(record(0x16, serverHello)),
      ...Array.from({ length: 2000 }, () => Uint8Array.from(record(0x16, [0]))),
    ],
    "full records up to the byte limit": () => [
      Uint8Array.from(record(0x16, serverHello)),
      Uint8Array.from(record(0x16, [11, ...u24(MAX_FLIGHT_BYTES - 1)])),
      ...Array.from({ length: 20 }, () => Uint8Array.from(record(0x16, new Array(16_000).fill(0)))),
    ],
    "full records split into 300-byte reads": () => {
      const all = Uint8Array.from([
        ...record(0x16, serverHello),
        ...record(0x16, [11, ...u24(MAX_FLIGHT_BYTES - 1)]),
        ...Array.from({ length: 9 }, () => record(0x16, new Array(16_000).fill(0))).flat(),
      ]);
      return Array.from({ length: Math.ceil(all.length / 300) }, (_, i) => all.subarray(i * 300, i * 300 + 300));
    },
  };

  for (const [name, make] of Object.entries(cases)) {
    it(`stays cheap with ${name}`, () => {
      const chunks = make();
      // Warm up the JIT, then take the best of three.
      drain(new ServerFlightReader(), chunks);
      const ms = Math.min(...[0, 1, 2].map(() => cpuMs(() => drain(new ServerFlightReader(), chunks))));
      expect(ms).toBeLessThan(5);
    });
  }
});

describe("readCertificate", () => {
  it("sends the hello and reads the certificate, then closes the socket", async () => {
    const bytes = flight(CERT_A);
    const s = fakeSocket({ answer: [bytes.subarray(0, 40), bytes.subarray(40)] });
    const r = await readCertificate("example.test", 443, 1000, s.connect);
    expect(r).toMatchObject({ ok: true, chainLength: 1, cert: { subject: "example.test" } });
    expect(s.written[0]![0]).toBe(0x16);
    expect(s.closed()).toBe(true);
  });

  it("reports a refused connection with the runtime's message", async () => {
    const s = fakeSocket({
      opened: Promise.reject(new Error("proxy request failed, cannot connect to the specified address")),
    });
    const r = await readCertificate("behind.cloudflare.test", 443, 1000, s.connect);
    expect(r).toMatchObject({ ok: false, kind: "connect_failed", message: expect.stringContaining("cannot connect") });
  });

  it("reports a connect() that throws", async () => {
    const r = await readCertificate("x.test", 443, 1000, () => {
      throw new Error("bad address");
    });
    expect(r).toMatchObject({ ok: false, kind: "connect_failed", message: "bad address" });
  });

  it("reports an alert", async () => {
    const s = fakeSocket({ answer: [Uint8Array.from(record(0x15, [2, 70]))] });
    const r = await readCertificate("tls13.test", 443, 1000, s.connect);
    expect(r).toMatchObject({ ok: false, kind: "alert", alert: 70, message: expect.stringContaining("protocol_version") });
  });

  it("reports a server that closes without a certificate", async () => {
    const s = fakeSocket({ answer: [Uint8Array.from(record(0x16, serverHello))] });
    expect(await readCertificate("x.test", 443, 1000, s.connect)).toMatchObject({ ok: false, kind: "closed" });
  });

  it("reports a non-TLS answer and an unreadable certificate", async () => {
    const http = fakeSocket({ answer: [new TextEncoder().encode("SSH-2.0-OpenSSH_9.6\r\n")] });
    expect(await readCertificate("x.test", 22, 1000, http.connect)).toMatchObject({ ok: false, kind: "malformed" });
    const junk = fakeSocket({ answer: [flight(new Uint8Array([0x30, 0x01, 0x00]))] });
    expect(await readCertificate("x.test", 443, 1000, junk.connect)).toMatchObject({
      ok: false,
      kind: "malformed",
      message: expect.stringContaining("certificate couldn't be read"),
    });
  });

  it("rejects a server dribbling its answer a byte at a time quickly", async () => {
    const bytes = flight(CERT_A, CERT_B);
    const s = fakeSocket({ answer: Array.from({ length: bytes.length }, (_, i) => bytes.subarray(i, i + 1)) });
    const startedAt = performance.now();
    const r = await readCertificate("x.test", 443, 5000, s.connect);
    expect(r).toMatchObject({ ok: false, kind: "malformed", message: expect.stringContaining("too many pieces") });
    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(s.closed()).toBe(true);
  });

  it("times out on a server that never answers, and on a connection that never opens", async () => {
    const silent = fakeSocket({ silent: true });
    expect(await readCertificate("x.test", 443, 30, silent.connect)).toMatchObject({
      ok: false,
      kind: "timeout",
      message: expect.stringContaining("no certificate within 30ms"),
    });
    expect(silent.closed()).toBe(true);
    const hanging = fakeSocket({ opened: new Promise(() => {}) });
    expect(await readCertificate("x.test", 443, 30, hanging.connect)).toMatchObject({
      ok: false,
      kind: "timeout",
      message: expect.stringContaining("connecting to x.test:443"),
    });
  });
});
