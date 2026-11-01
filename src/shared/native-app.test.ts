import { describe, expect, it } from "vitest";
import { ANDROID_PACKAGE, APP_REDIRECT_URI, appIntentUrl } from "./native-app";

/**
 * What Android's Intent.parseUri(uri, URI_INTENT_SCHEME) makes of an intent
 * URL, for the parts the link uses: the data URI (the scheme put back in front
 * of what follows `intent:`), the package, and the string extras.
 */
function parseIntent(url: string): { data: string; pkg: string | null; extras: Record<string, string> } {
  const hash = url.lastIndexOf("#Intent;");
  expect(hash).toBeGreaterThan(0);
  expect(url.endsWith(";end")).toBe(true);
  const fields = url.slice(hash + "#Intent;".length, -";end".length).split(";");
  let scheme: string | null = null;
  let pkg: string | null = null;
  const extras: Record<string, string> = {};
  for (const field of fields) {
    const eq = field.indexOf("=");
    const key = field.slice(0, eq);
    const value = decodeURIComponent(field.slice(eq + 1));
    if (key === "scheme") scheme = value;
    else if (key === "package") pkg = value;
    else if (key.startsWith("S.")) extras[key.slice(2)] = value;
  }
  let data = url.slice(0, hash);
  expect(data.startsWith("intent:")).toBe(true);
  data = data.slice("intent:".length);
  if (scheme) data = `${scheme}:${data}`;
  return { data, pkg, extras };
}

describe("appIntentUrl", () => {
  const callback = `${APP_REDIRECT_URI}?code=abc_DEF-123&state=st4te&origin=${encodeURIComponent("https://status.example.com")}`;

  it("hands the app the very callback URI, only to the app's package, with a page for phones without it", () => {
    const url = appIntentUrl(callback, "https://status.example.com/auth/app/get-app");
    expect(url).toBe(
      "intent:/signed-in?code=abc_DEF-123&state=st4te&origin=https%3A%2F%2Fstatus.example.com" +
        "#Intent;scheme=dev.n8builds.openping;package=dev.n8builds.openping;" +
        "S.browser_fallback_url=https%3A%2F%2Fstatus.example.com%2Fauth%2Fapp%2Fget-app;end",
    );
    const parsed = parseIntent(url);
    expect(parsed.data).toBe(callback);
    expect(parsed.pkg).toBe(ANDROID_PACKAGE);
    expect(parsed.extras.browser_fallback_url).toBe("https://status.example.com/auth/app/get-app");
  });

  it("only wraps the app's own callback", () => {
    expect(() => appIntentUrl("https://evil.example/x", "https://a.example/")).toThrow();
    expect(() => appIntentUrl(`${APP_REDIRECT_URI}#frag`, "https://a.example/")).toThrow();
  });
});
