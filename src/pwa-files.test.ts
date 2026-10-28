import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { API_CACHE, API_CACHE_MESSAGE, CACHEABLE_API_PATHS, PRECACHE_LIST, PRECACHE_MESSAGE } from "./client/lib/sw-contract";

/*
 * The installable app: public/manifest.webmanifest has what Android and
 * desktop Chrome need for the rich install sheet, every file it, index.html
 * and the service worker's shell name exists, each PNG is the size it
 * claims (scripts/build-icons.mjs writes the icons), and the service worker
 * caches only what the page expects.
 */
const PUBLIC = new URL("../public/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, PUBLIC), "utf8");

interface ImageRef {
  src: string;
  sizes?: string;
  type?: string;
  purpose?: string;
  form_factor?: string;
  label?: string;
}
interface Manifest {
  id?: string;
  name?: string;
  short_name?: string;
  start_url?: string;
  scope?: string;
  display?: string;
  theme_color?: string;
  background_color?: string;
  icons?: ImageRef[];
  shortcuts?: Array<{ name?: string; url?: string; icons?: ImageRef[] }>;
  screenshots?: ImageRef[];
}

const manifest = JSON.parse(read("manifest.webmanifest")) as Manifest;

/** A file in public/ for a root-relative URL. */
function publicFile(src: string): URL {
  expect(src.startsWith("/"), `${src} is root-relative`).toBe(true);
  return new URL(src.slice(1), PUBLIC);
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: URL): { width: number; height: number } {
  const buf = readFileSync(file);
  expect(buf.subarray(0, 8).toString("hex"), `${file.pathname} is a PNG`).toBe("89504e470d0a1a0a");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function expectImage(ref: ImageRef) {
  const file = publicFile(ref.src);
  expect(existsSync(file), `${ref.src} exists in public/`).toBe(true);
  if (ref.type === "image/png") {
    const { width, height } = pngSize(file);
    expect(ref.sizes, `${ref.src} declares its size`).toBe(`${width}x${height}`);
  }
}

describe("manifest.webmanifest", () => {
  it("has the fields an installable app needs", () => {
    expect(manifest.id).toBe("/");
    expect(manifest.name).toBe("OpenPing");
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.short_name!.length).toBeLessThanOrEqual(12);
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
  });

  it("uses the shell's canvas colour for the status bar and splash screen", () => {
    const canvas = /--color-canvas:\s*(#[0-9a-f]{6})/i.exec(
      readFileSync(new URL("./client/index.css", import.meta.url), "utf8"),
    )?.[1];
    expect(canvas).toBeDefined();
    expect(manifest.theme_color).toBe(canvas);
    expect(manifest.background_color).toBe(canvas);
    expect(read("../index.html")).toContain(`<meta name="theme-color" content="${canvas}" />`);
  });

  it("lists 192 and 512 px PNG icons, plain and maskable, all on disk at their sizes", () => {
    const icons = manifest.icons ?? [];
    for (const purpose of ["any", "maskable"]) {
      for (const size of ["192x192", "512x512"]) {
        expect(
          icons.some((i) => i.type === "image/png" && i.sizes === size && (i.purpose ?? "any").split(" ").includes(purpose)),
          `a ${size} ${purpose} PNG`,
        ).toBe(true);
      }
    }
    icons.forEach(expectImage);
  });

  it("has the three shortcuts, each with an icon on disk", () => {
    expect((manifest.shortcuts ?? []).map((s) => [s.name, s.url])).toEqual([
      ["Overview", "/"],
      ["Incidents", "/incidents"],
      ["Add monitor", "/monitors/new"],
    ]);
    for (const s of manifest.shortcuts ?? []) (s.icons ?? []).forEach(expectImage);
  });

  it("has a phone and a desktop screenshot for the rich install sheet", () => {
    const shots = manifest.screenshots ?? [];
    expect(shots.map((s) => s.form_factor).sort()).toEqual(["narrow", "wide"]);
    for (const shot of shots) {
      expect(shot.label).toBeTruthy();
      expectImage(shot);
    }
    const wide = shots.find((s) => s.form_factor === "wide")!;
    const [w, h] = wide.sizes!.split("x").map(Number);
    expect(w! > h!, "the wide one is landscape").toBe(true);
  });
});

describe("index.html and the service worker", () => {
  const html = read("../index.html");

  it("links the manifest, the Apple touch icon and the home-screen meta", () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    const apple = /<link rel="apple-touch-icon" sizes="(\d+)x\1" href="([^"]+)" \/>/.exec(html);
    expect(apple).not.toBeNull();
    expect(pngSize(publicFile(apple![2]!))).toEqual({ width: 180, height: 180 });
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="OpenPing" />');
    expect(html).toContain("viewport-fit=cover");
  });

  it("names only files that exist in its shell", () => {
    const shell = /const SHELL = (\[[^\]]*\]);/.exec(read("sw.js"));
    expect(shell).not.toBeNull();
    const paths = JSON.parse(shell![1]!.replace(/,\s*\]/, "]")) as string[];
    for (const path of paths) {
      if (path === "/") continue;
      // html_handling serves /offline.html at /offline.
      const file = path === "/offline" ? "/offline.html" : path;
      expect(existsSync(publicFile(file)), `${path} exists in public/`).toBe(true);
    }
  });

});

describe("public/sw.js agrees with the page (src/client/lib/sw-contract.ts)", () => {
  const sw = read("sw.js");

  it("uses the same cache name and message type", () => {
    expect(sw).toContain(`const API_CACHE = "${API_CACHE}";`);
    expect(sw).toContain(`const API_CACHE_MESSAGE = "${API_CACHE_MESSAGE}";`);
    expect(sw).toContain(`const PRECACHE_MESSAGE = "${PRECACHE_MESSAGE}";`);
    expect(sw).toContain(`const PRECACHE_LIST = "${PRECACHE_LIST}";`);
  });

  it("saves only the Overview answers", () => {
    const match = /const CACHEABLE_API_PATHS = (\[[^\]]*\]);/.exec(sw);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1]!)).toEqual([...CACHEABLE_API_PATHS]);
  });

  it("forgets saved data on a signed-out answer", () => {
    expect(sw).toMatch(/status === 401 \|\| fresh\.status === 403\)\s*\{\s*event\.waitUntil\(caches\.delete\(API_CACHE\)\)/);
  });

  it("names a version, so a change installs cleanly over the old worker", () => {
    expect(sw).toMatch(/const VERSION = "v\d+";/);
    expect(sw).toContain("const SHELL_CACHE = `openping-shell-${VERSION}`;");
    expect(sw).toContain("self.skipWaiting()");
    expect(sw).toContain("self.clients.claim()");
  });
});
