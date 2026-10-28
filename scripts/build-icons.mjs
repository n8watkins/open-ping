#!/usr/bin/env node
/**
 * Renders the PNG app icons in public/ from the SVG sources there.
 *
 *   node scripts/build-icons.mjs
 *
 * Android's install sheet, splash screen and notification badge, and iPhone's
 * home screen, want PNGs; the SVGs stay the source of truth. Run this after
 * changing public/icon.svg or public/maskable-icon.svg and commit the PNGs it
 * writes (src/client/lib/manifest.test.ts checks every icon the manifest lists
 * exists at the size it claims).
 *
 * It uses sharp (librsvg), which the Cloudflare tooling already installs.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));

/**
 * The monochrome notification badge: Android draws it from the alpha channel
 * alone, so it is the ring glyph in white on transparent, with no tile.
 */
const BADGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">
  <circle cx="48" cy="48" r="13" fill="#fff"/>
  <circle cx="48" cy="48" r="27" fill="none" stroke="#fff" stroke-width="7"/>
  <circle cx="48" cy="48" r="41" fill="none" stroke="#fff" stroke-width="7" opacity="0.55"/>
</svg>`;

/** [output file, SVG source (a file in public/ or inline markup), size in px] */
export const ICONS = [
  ["icon-192.png", "icon.svg", 192],
  ["icon-512.png", "icon.svg", 512],
  ["maskable-192.png", "maskable-icon.svg", 192],
  ["maskable-512.png", "maskable-icon.svg", 512],
  // iOS rounds the corners itself, so it gets the full-bleed maskable art.
  ["apple-touch-icon.png", "maskable-icon.svg", 180],
  ["badge-96.png", BADGE_SVG, 96],
];

async function loadSharp() {
  try {
    return (await import("sharp")).default;
  } catch {
    console.error("sharp is not installed. Run `npm install` first (wrangler brings it in).");
    process.exit(1);
  }
}

async function main() {
  const sharp = await loadSharp();
  for (const [out, source, size] of ICONS) {
    const svg = source.startsWith("<svg") ? Buffer.from(source) : await readFile(PUBLIC + source);
    // Render at the target size straight from the vector (density scales the
    // 512-unit viewBox), so small icons stay crisp instead of being downscaled.
    const density = Math.max(72, Math.ceil((72 * size) / 96));
    const png = await sharp(svg, { density })
      .resize(size, size)
      .png({ compressionLevel: 9, palette: false })
      .toBuffer();
    await writeFile(PUBLIC + out, png);
    console.log(`public/${out}  ${size}x${size}  ${png.length} bytes`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
