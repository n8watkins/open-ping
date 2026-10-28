/** Compiled in at build time by scripts/bundle-module.ts. */
declare module "virtual:openping-bundle" {
  /** The OpenPing version (package.json) of this build. */
  export const version: string;
  /** Every migration in migrations/, in order, split into statements. */
  export const migrations: readonly { readonly name: string; readonly queries: readonly string[] }[];
}
