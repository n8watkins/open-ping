import { describe, expect, it } from "vitest";
import { keysHealthy, type RekeyStatusResponse } from "./encryption";

const healthy: RekeyStatusResponse = {
  encryptionConfigured: true,
  currentKeyId: "k7f3a9c1",
  previousKey: { configured: false, valid: false, keyId: null, sameAsCurrent: false },
  classes: [{ id: "channels", label: "Channels", rows: 3, current: 3, previous: 0, legacy: 0, unsealed: 0, unreadable: 0 }],
  needsReencryption: 0,
  dependsOnPreviousKey: 0,
  unverified: 0,
  unreadable: [],
  unreadableCount: 0,
  safeToRemovePreviousKey: false,
  summary: "Every value is on the current key.",
};

describe("keysHealthy", () => {
  it("is true when every value opens with the current key", () => {
    expect(keysHealthy(healthy)).toBe(true);
    // A finished rotation whose previous key can go is still healthy.
    expect(
      keysHealthy({
        ...healthy,
        previousKey: { configured: true, valid: true, keyId: "k0ld", sameAsCurrent: false },
        safeToRemovePreviousKey: true,
      }),
    ).toBe(true);
  });

  it("asks for attention when anything needs the owner", () => {
    expect(keysHealthy({ ...healthy, encryptionConfigured: false })).toBe(false);
    expect(keysHealthy({ ...healthy, currentKeyId: null })).toBe(false);
    expect(keysHealthy({ ...healthy, unreadableCount: 2 })).toBe(false);
    expect(keysHealthy({ ...healthy, needsReencryption: 1 })).toBe(false);
    expect(keysHealthy({ ...healthy, dependsOnPreviousKey: 1 })).toBe(false);
    expect(keysHealthy({ ...healthy, unverified: 1 })).toBe(false);
    expect(
      keysHealthy({ ...healthy, previousKey: { configured: true, valid: false, keyId: null, sameAsCurrent: false } }),
    ).toBe(false);
  });
});
