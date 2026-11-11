import { describe, expect, it } from "vitest";
import { fetchFavicon, iconCandidates, iconIsStale, iconOrigin, ICON_MAX_BYTES, ICON_REFRESH_MS, sniffImage } from "./favicon";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

/** A fetch that answers from a table of URL -> Response and records what it was asked. */
function fakeFetch(routes: Record<string, () => Response>) {
  const asked: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    const make = routes[url];
    return make ? make() : new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { fn, asked };
}

const html = (head: string) => () => new Response(`<html><head>${head}</head><body></body></html>`, { headers: { "content-type": "text/html" } });
const image = (bytes: Uint8Array) => () => new Response(bytes, { headers: { "content-type": "image/png" } });

describe("iconCandidates", () => {
  const page = new URL("https://example.com/app/");

  it("lists declared icons best first, then /favicon.ico, resolving relative links", () => {
    const urls = iconCandidates(
      `<link rel="apple-touch-icon" href="/touch.png">
       <link rel="icon" sizes="192x192" href="big.png">
       <link rel='shortcut icon' href='/fav.png' sizes="32x32">
       <link rel="mask-icon" href="/mask.svg">
       <link rel="stylesheet" href="/a.css">`,
      page,
    ).map((u) => u.href);
    expect(urls).toEqual([
      "https://example.com/fav.png",
      "https://example.com/app/big.png",
      "https://example.com/touch.png",
      "https://example.com/favicon.ico",
    ]);
  });

  it("skips SVGs and data: links, and always ends with /favicon.ico", () => {
    const urls = iconCandidates(
      `<link rel="icon" type="image/svg+xml" href="/i.svg"><link rel="icon" href="data:image/png;base64,AAAA"><link rel="icon" href="/x.svg">`,
      page,
    ).map((u) => u.href);
    expect(urls).toEqual(["https://example.com/favicon.ico"]);
  });
});

describe("sniffImage", () => {
  it("knows the formats it serves by their bytes, and nothing else", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(Uint8Array.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32]))).toBe("image/x-icon");
    expect(sniffImage(SVG)).toBeNull();
    expect(sniffImage(new TextEncoder().encode("<html>not an image at all</html>"))).toBeNull();
  });
});

describe("fetchFavicon", () => {
  it("reads the icon the page declares, from the page's own host", async () => {
    const { fn, asked } = fakeFetch({
      "https://example.com/": html('<link rel="icon" href="/icon.png">'),
      "https://example.com/icon.png": image(PNG),
    });
    const got = await fetchFavicon("https://example.com/", fn);
    expect(got?.contentType).toBe("image/png");
    expect(got?.bytes.length).toBe(PNG.length);
    expect(asked).toEqual(["https://example.com/", "https://example.com/icon.png"]);
  });

  it("falls back to /favicon.ico when the page declares none", async () => {
    const { fn } = fakeFetch({ "https://example.com/": html(""), "https://example.com/favicon.ico": image(PNG) });
    expect((await fetchFavicon("https://example.com/", fn))?.contentType).toBe("image/png");
  });

  it("never fetches an icon from another host", async () => {
    const { fn, asked } = fakeFetch({
      "https://example.com/": html('<link rel="icon" href="https://tracker.example.net/i.png">'),
      "https://tracker.example.net/i.png": image(PNG),
    });
    expect(await fetchFavicon("https://example.com/", fn)).toBeNull();
    expect(asked.some((u) => u.includes("tracker"))).toBe(false);
  });

  it("does not follow an icon redirect to another host or to a private address", async () => {
    const { fn, asked } = fakeFetch({
      "https://example.com/": html('<link rel="icon" href="/a.png">'),
      "https://example.com/a.png": () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } }),
      "https://example.com/favicon.ico": () => new Response(null, { status: 302, headers: { location: "https://elsewhere.test/f.ico" } }),
    });
    expect(await fetchFavicon("https://example.com/", fn)).toBeNull();
    expect(asked.every((u) => u.startsWith("https://example.com/"))).toBe(true);
  });

  it("refuses private and loopback monitor addresses without any request", async () => {
    const { fn, asked } = fakeFetch({});
    for (const url of ["http://127.0.0.1/", "http://10.0.0.5/app", "http://localhost:8080/", "http://printer.local/", "file:///etc/passwd"]) {
      expect(await fetchFavicon(url, fn)).toBeNull();
    }
    expect(asked).toEqual([]);
  });

  it("rejects an oversized icon and an SVG that sneaks in as /favicon.ico, then tries the next candidate", async () => {
    const big = new Uint8Array(ICON_MAX_BYTES + 100);
    big.set(PNG);
    const { fn } = fakeFetch({
      "https://example.com/": html('<link rel="icon" href="/big.png"><link rel="icon" href="/small.png" sizes="16x16">'),
      "https://example.com/big.png": image(big),
      "https://example.com/small.png": image(PNG),
    });
    expect((await fetchFavicon("https://example.com/", fn))?.bytes.length).toBe(PNG.length);

    const svgOnly = fakeFetch({ "https://example.com/": html(""), "https://example.com/favicon.ico": image(SVG) });
    expect(await fetchFavicon("https://example.com/", svgOnly.fn)).toBeNull();
  });

  it("gives up quietly when the site errors or times out", async () => {
    const throwing = (async () => {
      throw new Error("boom");
    }) as typeof fetch;
    expect(await fetchFavicon("https://example.com/", throwing)).toBeNull();
    const hanging = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) reject(new Error("aborted"));
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    const started = Date.now();
    expect(await fetchFavicon("https://example.com/", hanging)).toBeNull();
    expect(Date.now() - started).toBeLessThan(8000);
  }, 10_000);

  it("follows the page's own redirect (to www) and takes the icon from where it lands", async () => {
    const { fn } = fakeFetch({
      "https://example.com/": () => new Response(null, { status: 301, headers: { location: "https://www.example.com/" } }),
      "https://www.example.com/": html('<link rel="icon" href="/w.png">'),
      "https://www.example.com/w.png": image(PNG),
    });
    expect((await fetchFavicon("https://example.com/", fn))?.contentType).toBe("image/png");
  });
});

describe("when an icon is due", () => {
  const http = (url: string) => ({ type: "http" as const, config: { url } }) as never;
  const now = 1_000_000_000_000;

  it("is for HTTP monitors only, and its origin ignores path and query", () => {
    expect(iconOrigin(http("https://example.com/a?token=1"))).toBe("https://example.com");
    expect(iconOrigin({ type: "tcp", config: { host: "x", port: 1 } } as never)).toBeNull();
    expect(iconOrigin(http("http://10.0.0.1/"))).toBeNull();
  });

  it("is due when never fetched, when the site changed, and after a week, not before", () => {
    const m = http("https://example.com/x");
    expect(iconIsStale(m, undefined, now)).toBe(true);
    expect(iconIsStale(m, { origin: "https://example.com", fetchedAt: now - 1000, hasIcon: true }, now)).toBe(false);
    expect(iconIsStale(m, { origin: "https://example.com", fetchedAt: now - 1000, hasIcon: false }, now)).toBe(false);
    expect(iconIsStale(m, { origin: "https://old.example.com", fetchedAt: now - 1000, hasIcon: true }, now)).toBe(true);
    expect(iconIsStale(m, { origin: "https://example.com", fetchedAt: now - ICON_REFRESH_MS, hasIcon: true }, now)).toBe(true);
    expect(iconIsStale({ type: "heartbeat", config: {} } as never, undefined, now)).toBe(false);
  });
});
