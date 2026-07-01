import { describe, it, expect } from "vitest";
import {
  assertSafeUrl,
  assertSafeHost,
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
  // IPv6 literal encodings that embed an internal IPv4 (serialized by WHATWG):
  "http://[::127.0.0.1]", // IPv4-compatible -> [::7f00:1]
  "http://[2002:7f00:0001::]", // 6to4 of 127.0.0.1 -> [2002:7f00:1::]
  "http://[64:ff9b::7f00:1]", // NAT64 of 127.0.0.1
  "http://[fec0::1]", // deprecated site-local fec0::/10
  "http://[::2]", // single-hextet IPv4-compatible -> 0.0.0.2 (0.0.0.0/8)
  // Encoded-loopback forms that rely on WHATWG normalizing the host to a
  // dotted-quad before the IPv4 denylist sees it — regression guards.
  "http://0x7f000001", // hex 127.0.0.1
  "http://2130706433", // decimal 127.0.0.1
  "http://0177.0.0.1", // octal-first-octet 127.0.0.1
  "http://127.1", // short-form 127.0.0.1
  "http://0", // 0.0.0.0 ("this" network)
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
    const reasonOf = (u: string): string | undefined => {
      const r = assertSafeUrl(u);
      return r.ok ? undefined : r.reason;
    };
    expect(reasonOf("not a url")).toBe("invalid_url");
    expect(reasonOf("ftp://example.com")).toBe("bad_scheme");
    expect(reasonOf("https://user:pass@example.com")).toBe("embedded_credentials");
    expect(reasonOf("http://localhost")).toBe("loopback_host");
    expect(reasonOf("http://printer.local")).toBe("loopback_host");
    expect(reasonOf("http://metadata.google.internal")).toBe("metadata_host");
    expect(reasonOf("http://169.254.169.254")).toBe("metadata_host");
    expect(reasonOf("http://10.1.2.3")).toBe("private_ipv4");
    expect(reasonOf("http://[::1]")).toBe("private_ipv6");
  });
});

describe("assertSafeHost", () => {
  const reasonOf = (h: string): string | undefined => {
    const r = assertSafeHost(h);
    return r.ok ? undefined : r.reason;
  };

  it("blocks loopback / .local / .localhost names", () => {
    expect(reasonOf("localhost")).toBe("loopback_host");
    expect(reasonOf("printer.local")).toBe("loopback_host");
    expect(reasonOf("api.localhost")).toBe("loopback_host");
  });

  it("blocks cloud-metadata endpoints", () => {
    expect(reasonOf("metadata.google.internal")).toBe("metadata_host");
    expect(reasonOf("169.254.169.254")).toBe("metadata_host");
  });

  it("blocks private/loopback IPv4 literals", () => {
    expect(reasonOf("10.0.0.1")).toBe("private_ipv4");
    expect(reasonOf("127.0.0.1")).toBe("private_ipv4");
    expect(reasonOf("192.168.1.1")).toBe("private_ipv4");
  });

  it("blocks private IPv6 literals, bracketed or bare", () => {
    expect(reasonOf("[::1]")).toBe("private_ipv6");
    expect(reasonOf("::1")).toBe("private_ipv6");
    expect(reasonOf("fc00::1")).toBe("private_ipv6");
    expect(reasonOf("[fe80::1]")).toBe("private_ipv6");
  });

  it("rejects an empty host", () => {
    expect(reasonOf("")).toBe("invalid_host");
    expect(reasonOf("   ")).toBe("invalid_host");
  });

  it("allows public hostnames and IP literals", () => {
    expect(assertSafeHost("example.com").ok).toBe(true);
    expect(assertSafeHost("api.github.com").ok).toBe(true);
    expect(assertSafeHost("1.1.1.1").ok).toBe(true);
    expect(assertSafeHost("[2606:4700:4700::1111]").ok).toBe(true);
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
  it("flags IPv4-compatible, 6to4 and NAT64 encodings of internal IPv4", () => {
    // WHATWG serializes these (verified) to the bracketed forms below.
    expect(isBlockedIPv6("[::7f00:1]")).toBe(true); // ::127.0.0.1 (compat)
    expect(isBlockedIPv6("[::a00:1]")).toBe(true); // ::10.0.0.1 (compat)
    expect(isBlockedIPv6("[2002:7f00:1::]")).toBe(true); // 6to4 of 127.0.0.1
    expect(isBlockedIPv6("[2002:a9fe:a9fe::]")).toBe(true); // 6to4 of 169.254.169.254
    expect(isBlockedIPv6("[64:ff9b::7f00:1]")).toBe(true); // NAT64 of 127.0.0.1
  });
  it("does not over-block public 6to4 / compatible forms", () => {
    expect(isBlockedIPv6("[2002:0808:0808::]")).toBe(false); // 6to4 of 8.8.8.8
  });
  it("flags deprecated site-local (fec0::/10)", () => {
    expect(isBlockedIPv6("[fec0::1]")).toBe(true); // start of the range
    expect(isBlockedIPv6("[fed0::1]")).toBe(true); // middle of the range
    expect(isBlockedIPv6("[feff::1]")).toBe(true); // end of the range
  });
  it("flags single-hextet IPv4-compatible forms (::x -> 0.0.0.0/8)", () => {
    expect(isBlockedIPv6("::2")).toBe(true); // 0.0.0.2
    expect(isBlockedIPv6("[::ff]")).toBe(true); // 0.0.0.255
    expect(isBlockedIPv6("[::100]")).toBe(true); // 0.0.1.0
    expect(isBlockedIPv6("[::ffff]")).toBe(true); // 0.0.255.255
  });
});
