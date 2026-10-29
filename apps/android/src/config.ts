/**
 * The app's build-time settings.
 *
 * HOSTED_DOMAIN: OpenPing Hosted's domain, whose `<name>.<domain>` addresses
 * the "OpenPing Hosted" choice opens. Empty until Hosted opens (its domain
 * isn't bought yet, docs/HOSTED_BUILD_PLAN.md decision D2); the choice then
 * says "Opening soon". Set it for a build with `VITE_HOSTED_DOMAIN=example.com`.
 */
export const HOSTED_DOMAIN: string = (import.meta.env.VITE_HOSTED_DOMAIN ?? "").trim().toLowerCase();
