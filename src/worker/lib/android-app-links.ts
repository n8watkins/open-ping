import type { Env } from "../types";
import { ANDROID_PACKAGE } from "../../shared/native-app";

/**
 * `/.well-known/assetlinks.json` (Digital Asset Links), served only when the
 * ANDROID_APP_LINKS var is set.
 *
 * The OpenPing Android app always signs in through the phone's browser
 * (routes/app-signin.ts), which needs nothing on the install. This file is an
 * optional extra: with it, Android trusts the app to use this install's
 * passkeys inside its own web view too (Credential Manager in WebView), and it
 * names the app as this site's.
 *
 * ANDROID_APP_LINKS lists the SHA-256 fingerprints of the app's signing
 * certificates, comma separated (Play Console, App integrity, "App signing key
 * certificate"). An entry may name another package as `package=fingerprint`,
 * for a build of your own.
 */

export interface AssetLinkTarget {
  packageName: string;
  fingerprints: string[];
}

const PACKAGE_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

/** `AB:CD:...` (32 bytes, upper case), from colon-separated or plain hex; null otherwise. */
export function normalizeFingerprint(value: string): string | null {
  const hex = value.trim().replace(/:/g, "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) return null;
  return hex.match(/../g)!.join(":");
}

/**
 * The targets ANDROID_APP_LINKS names, grouped by package; an empty list when
 * the var is unset or holds nothing usable (bad entries are skipped and logged).
 */
export function parseAppLinks(raw: string | undefined): AssetLinkTarget[] {
  if (!raw?.trim()) return [];
  const byPackage = new Map<string, string[]>();
  for (const entry of raw.split(",")) {
    const item = entry.trim();
    if (!item) continue;
    const eq = item.indexOf("=");
    const packageName = eq >= 0 ? item.slice(0, eq).trim() : ANDROID_PACKAGE;
    const fingerprint = normalizeFingerprint(eq >= 0 ? item.slice(eq + 1) : item);
    if (!PACKAGE_PATTERN.test(packageName) || !fingerprint) {
      console.warn(`[assetlinks] ignoring an ANDROID_APP_LINKS entry that isn't a package and SHA-256 fingerprint: ${item}`);
      continue;
    }
    const list = byPackage.get(packageName) ?? [];
    if (!list.includes(fingerprint)) list.push(fingerprint);
    byPackage.set(packageName, list);
  }
  return [...byPackage].map(([packageName, fingerprints]) => ({ packageName, fingerprints }));
}

/** The file's JSON, or null when there is nothing to serve. */
export function assetLinks(env: Pick<Env, "ANDROID_APP_LINKS">): unknown[] | null {
  const targets = parseAppLinks(env.ANDROID_APP_LINKS);
  if (targets.length === 0) return null;
  return targets.map((t) => ({
    relation: ["delegate_permission/common.handle_all_urls", "delegate_permission/common.get_login_creds"],
    target: { namespace: "android_app", package_name: t.packageName, sha256_cert_fingerprints: t.fingerprints },
  }));
}
