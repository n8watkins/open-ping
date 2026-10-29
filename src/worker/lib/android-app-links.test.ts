import { describe, expect, it } from "vitest";
import { assetLinks, normalizeFingerprint, parseAppLinks } from "./android-app-links";

const HEX = "0123456789abcdef".repeat(4);
const COLONS = HEX.toUpperCase().match(/../g)!.join(":");

describe("normalizeFingerprint", () => {
  it("accepts plain or colon-separated hex in either case", () => {
    expect(normalizeFingerprint(HEX)).toBe(COLONS);
    expect(normalizeFingerprint(COLONS.toLowerCase())).toBe(COLONS);
    expect(normalizeFingerprint(`  ${COLONS} `)).toBe(COLONS);
  });

  it("refuses anything that isn't 32 bytes of hex", () => {
    expect(normalizeFingerprint("AB:CD")).toBeNull();
    expect(normalizeFingerprint(`${HEX}00`)).toBeNull();
    expect(normalizeFingerprint("zz".repeat(32))).toBeNull();
  });
});

describe("parseAppLinks", () => {
  it("is empty when unset", () => {
    expect(parseAppLinks(undefined)).toEqual([]);
    expect(parseAppLinks("  ")).toEqual([]);
  });

  it("puts bare fingerprints on the OpenPing app and groups named packages", () => {
    const other = "AA".repeat(32);
    expect(parseAppLinks(`${HEX}, com.example.ping=${other}, ${COLONS}`)).toEqual([
      { packageName: "dev.n8builds.openping", fingerprints: [COLONS] },
      { packageName: "com.example.ping", fingerprints: [other.match(/../g)!.join(":")] },
    ]);
  });

  it("skips entries it can't use", () => {
    expect(parseAppLinks(`not-a-fingerprint, bad package=${HEX}`)).toEqual([]);
  });
});

describe("assetLinks", () => {
  it("is null without targets, so nothing is served", () => {
    expect(assetLinks({})).toBeNull();
  });

  it("lists the passkey and link relations for each package", () => {
    expect(assetLinks({ ANDROID_APP_LINKS: HEX })).toEqual([
      {
        relation: ["delegate_permission/common.handle_all_urls", "delegate_permission/common.get_login_creds"],
        target: { namespace: "android_app", package_name: "dev.n8builds.openping", sha256_cert_fingerprints: [COLONS] },
      },
    ]);
  });
});
