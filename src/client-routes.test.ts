import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLIENT_ROUTES, isClientRoute } from "./shared/client-routes";

describe("client routes", () => {
  it("lists every top-level route App.tsx renders", () => {
    const app = readFileSync("src/client/App.tsx", "utf8");
    const paths = [...app.matchAll(/<Route\s+path="(\/[^"]*)"/g)].map((match) => match[1]);
    expect(paths.length).toBeGreaterThan(20);
    for (const path of paths) expect(CLIENT_ROUTES, path).toContain(path);
  });

  it("matches params, nested sections and trailing slashes", () => {
    for (const path of ["/", "/monitors", "/monitors/42", "/monitors/42/edit", "/status/acme", "/settings/security", "/developers/x/y", "/tools/"]) {
      expect(isClientRoute(path), path).toBe(true);
    }
  });

  it("rejects everything else", () => {
    for (const path of ["/zz-no-such-page", "/monitors/42/edit/more", "/status/a/b", "/toolsx", "/wp-login.php.bak/x"]) {
      expect(isClientRoute(path), path).toBe(false);
    }
  });
});
