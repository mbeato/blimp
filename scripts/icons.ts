// Renders the app icons from their SVGs (docs/superpowers/specs/2026-10-25-brand-refresh-design.md): the iPhone's
// AppIcon.png (1024, RGB with no alpha, which App Store Connect requires) and the Mac's app-icon.png (1024, keeping
// its transparent margin), which `bun run tauri icon src-tauri/app-icon.png` in app/ turns into the Mac's icon set.
// Run from the repo root: bun scripts/icons.ts

import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { Resvg } from "@resvg/resvg-js";

const render = (svg: string) => new Resvg(readFileSync(svg, "utf8"), { fitTo: { mode: "width", value: 1024 } }).render();

// CRC-32, as PNG's chunks carry it.
const table = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// An 8-bit RGB PNG (colour type 2) from RGBA pixels, alpha dropped, each row unfiltered.
export function rgbPng(rgba: Uint8Array, width: number, height: number): Buffer {
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const o = y * stride + 1 + x * 3;
      raw[o] = rgba[i];
      raw[o + 1] = rgba[i + 1];
      raw[o + 2] = rgba[i + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]);
}

if (import.meta.main) {
  const ios = render("ios/app-icon.svg");
  writeFileSync("ios/Blimp/Assets.xcassets/AppIcon.appiconset/AppIcon.png", rgbPng(ios.pixels, ios.width, ios.height));
  writeFileSync("app/src-tauri/app-icon.png", render("app/src-tauri/app-icon.svg").asPng());
  console.log("wrote AppIcon.png and app-icon.png; next, in app/: bun run tauri icon src-tauri/app-icon.png");
}
