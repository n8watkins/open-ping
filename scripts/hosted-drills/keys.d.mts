// Types for keys.mjs, which OpenPing's workerd tests use to seal monitors (test/integration/hosted-drills.test.ts).

export declare const SEALED_CONFIG_KEY: "__openping_sealed_config_v1";
export declare function isValidKey(value: unknown): boolean;
export declare function keyIdFor(masterKey: string): Promise<string>;
export declare function openEscrowedKey(escrowed: { kid: string; ciphertext: string }, tenantId: string, platformKey: string): Promise<string>;
export declare function parseCiphertext(value: unknown): { version: "v1" | "v2"; kid?: string; iv: string; ct: string } | null;
export declare function encryptValue(masterKey: string, plaintext: string): Promise<string>;
export declare function decryptValue(masterKey: string, stored: string): Promise<string>;
export declare function sealConfig(masterKey: string, config: Record<string, unknown>): Promise<Record<string, string>>;
