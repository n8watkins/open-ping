import { describe, it, expect } from "vitest";
import {
  assertSafeUrl,
  isIPv4,
  isBlockedIPv4,
  isBlockedIPv6,
} from "./ssrf";

const BLOCKED = [
  "http://localhost",
  "http://127.0.0.1",
  "http://10.1.2.3",
  "http://192.168.0.5",
  "http://169.254.169.254",
  "http://[::1]",
  "https://user:pass@example.com",
  "ftp://example.com",
  "http://metadata.google.internal",
  "http://172.16.5.5",
];

const ALLOWED = [
  "https://example.com",
  "https://1.1.1.1",
  "http://93.184.216.34", // example.com public IP
  "https://api.github.com",
];

describe("assertSafeUrl", () => {
  for (const raw of BLOCKED) {
    it(`blocks ${raw}`, () => {
      expect(assertSafeUrl(raw).ok).toBe(false);
    });
  }

  for (const raw of ALLOWED) {
    it(`allows ${raw}`, () => {
      const result = assertSafeUrl(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.url).toBeInstanceOf(URL);
      }
    });
  }

  it("reports specific rejection reasons", () => {
    expect(assertSafeUrl("not a url").reason).toBe("invalid_url");
    expect(assertSafeUrl("ftp://example.com").reason).toBe("bad_scheme");
    expect(assertSafeUrl("https://user:pass@example.com").reason).toBe(
      "embedded_credentials",
    );
    expect(assertSafeUrl("http://localhost").reason).toBe("loopback_host");
    expect(assertSafeUrl("http://printer.local").reason).toBe("loopback_host");
    expect(assertSafeUrl("http://metadata.google.internal").reason).toBe(
      "metadata_host",
    );
    expect(assertSafeUrl("http://169.254.169.254").reason).toBe("metadata_host");
    expect(assertSafeUrl("http://10.1.2.3").reason).toBe("private_ipv4");
    expect(assertSafeUrl("http://[::1]").reason).toBe("private_ipv6");
  });
});

describe("isIPv4", () => {
  it("recognizes dotted-quad literals", () => {
    expect(isIPv4("1.2.3.4")).toBe(true);
    expect(isIPv4("255.255.255.255")).toBe(true);
  });
  it("rejects non-literals", () => {
    expect(isIPv4("example.com")).toBe(false);
    expect(isIPv4("1.2.3")).toBe(false);
    expect(isIPv4("1.2.3.256")).toBe(false);
    expect(isIPv4("[::1]")).toBe(false);
  });
});

describe("isBlockedIPv4", () => {
  it("flags private and reserved ranges", () => {
    expect(isBlockedIPv4("10.0.0.1")).toBe(true);
    expect(isBlockedIPv4("172.16.5.5")).toBe(true);
    expect(isBlockedIPv4("192.168.1.1")).toBe(true);
    expect(isBlockedIPv4("127.0.0.1")).toBe(true);
    expect(isBlockedIPv4("169.254.10.10")).toBe(true);
    expect(isBlockedIPv4("100.64.0.1")).toBe(true);
  });
  it("allows public addresses", () => {
    expect(isBlockedIPv4("1.1.1.1")).toBe(false);
    expect(isBlockedIPv4("8.8.8.8")).toBe(false);
    expect(isBlockedIPv4("93.184.216.34")).toBe(false);
  });
});

describe("isBlockedIPv6", () => {
  it("flags loopback, ULA, link-local and mapped privates", () => {
    expect(isBlockedIPv6("[::1]")).toBe(true);
    expect(isBlockedIPv6("::")).toBe(true);
    expect(isBlockedIPv6("[fc00::1]")).toBe(true);
    expect(isBlockedIPv6("[fe80::1]")).toBe(true);
    expect(isBlockedIPv6("[::ffff:10.0.0.1]")).toBe(true);
  });
  it("allows public IPv6", () => {
    expect(isBlockedIPv6("[2606:4700:4700::1111]")).toBe(false);
  });
});
