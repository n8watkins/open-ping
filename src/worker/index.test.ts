import { describe, it, expect } from "vitest";
import worker from "./index";
import type { Env } from "./types";

/**
 * Simulate a Cloudflare ASSETS / `fetch()` response: readable body, but with
 * IMMUTABLE headers (any mutation throws). Returning one of these directly is
 * what made the global secureHeaders middleware throw "Can't modify immutable
 * headers" and 500 every direct-loaded client route (regression guard).
 */
function immutableAssetResponse(): Response {
  const res = new Response("<!doctype html><title>spa</title>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
  const block = () => {
    throw new TypeError("Can't modify immutable headers");
  };
  res.headers.set = block as never;
  res.headers.append = block as never;
  res.headers.delete = block as never;
  return res;
}

function makeEnv(): Env {
  return {
    ASSETS: { fetch: async () => immutableAssetResponse() },
  } as unknown as Env;
}

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

describe("worker fetch — SPA fallback + secureHeaders", () => {
  it("serves a direct-loaded client route (/status) as 200 with security headers", async () => {
    const res = await worker.fetch!(
      new Request("https://example.com/status"),
      makeEnv(),
      ctx,
    );
    // Before the fix this threw on the immutable ASSETS headers → 500.
    expect(res.status).toBe(200);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
  });

  it("returns JSON 404 for an unmatched /api route (never the SPA shell)", async () => {
    const res = await worker.fetch!(
      new Request("https://example.com/api/does-not-exist"),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      error: "not_found",
      path: "/api/does-not-exist",
    });
  });
});
