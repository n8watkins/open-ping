import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Hosted customers can share a parent domain with each other, the platform
 * and the owner's other sites (customers at <slug>.openping.n8builds.dev).
 * Every cookie must stay on the exact host that set it: no cookie anywhere in
 * OpenPing or the platform may carry a Domain attribute, which would send it
 * to every sibling host (docs/hosted/CONTRACT.md, section 10). This reads the
 * source, so a new cookie with a Domain fails here before review.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

const files = [...sources(join(ROOT, "src/worker")), ...sources(join(ROOT, "platform/src"))];

describe("cookie scope", () => {
  it("finds the cookie code it checks", () => {
    expect(files.some((f) => f.endsWith("lib/sessions.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("auth/cookies.ts"))).toBe(true);
  });

  it("never sets a cookie with a Domain attribute", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      // A raw Set-Cookie string with "Domain=", or a Hono setCookie/deleteCookie option `domain:`.
      if (/;\s*Domain=/i.test(text)) offenders.push(`${file}: Domain= in a cookie string`);
      for (const call of text.matchAll(/(?:setCookie|deleteCookie)\(([^;]*?)\);/gs)) {
        if (/\bdomain\s*:/.test(call[1] ?? "")) offenders.push(`${file}: a domain option in ${call[0].slice(0, 60)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
