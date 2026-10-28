/** What Settings shows about MASTER_KEY (routes/rekey.ts). */

export interface KeyClassStatus {
  id: string;
  label: string;
  rows: number;
  current: number;
  previous: number;
  legacy: number;
  unsealed: number;
  unreadable: number;
}
export interface UnreadableValue {
  class: string;
  id: string;
  field: string;
  reason: string;
}
/** GET /api/admin/rekey/status (routes/rekey.ts). */
export interface RekeyStatusResponse {
  encryptionConfigured: boolean;
  currentKeyId: string | null;
  previousKey: { configured: boolean; valid: boolean; keyId: string | null; sameAsCurrent: boolean };
  classes: KeyClassStatus[];
  needsReencryption: number;
  dependsOnPreviousKey: number;
  unverified: number;
  unreadable: UnreadableValue[];
  unreadableCount: number;
  safeToRemovePreviousKey: boolean;
  summary: string;
}
/**
 * True when nothing about the keys needs the owner: encryption is on, every
 * stored value opens with the current key, and no previous key is in a bad
 * state. Then the card is one line; otherwise it opens with the details.
 */
export function keysHealthy(s: RekeyStatusResponse): boolean {
  return (
    s.encryptionConfigured &&
    !!s.currentKeyId &&
    s.unreadableCount === 0 &&
    s.needsReencryption === 0 &&
    s.dependsOnPreviousKey === 0 &&
    s.unverified === 0 &&
    !(s.previousKey.configured && !s.previousKey.valid)
  );
}
