// The blimp mark's files (docs/superpowers/specs/2026-10-25-brand-refresh-design.md): every copy the apps ship is
// brand/'s source unchanged, and the iPhone icon is what App Store Connect takes (1024 square, RGB, no alpha).

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { rgbPng } from "../scripts/icons";

const root = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(root, p));

const copies: [string, string][] = [
  ["brand/blimp-silver.svg", "ios/Blimp/Assets.xcassets/BlimpGlyph.imageset/blimp-silver.svg"],
  ["brand/blimp-ink.svg", "ios/Blimp/Assets.xcassets/BlimpGlyph.imageset/blimp-ink.svg"],
  ["brand/blimp-silver.svg", "ios/Blimp/Assets.xcassets/BlimpGlyphOnDark.imageset/blimp-silver.svg"],
  ["brand/blimp-silver.svg", "app/src/assets/blimp-silver.svg"],
];

test.each(copies)("%s is shipped unchanged as %s", (source, copy) => {
  expect(read(copy).toString()).toBe(read(source).toString());
});

test("the iPhone icon is a 1024 × 1024 PNG, 8-bit RGB with no alpha", () => {
  const png = read("ios/Blimp/Assets.xcassets/AppIcon.appiconset/AppIcon.png");
  expect(png.subarray(12, 16).toString()).toBe("IHDR");
  expect(png.readUInt32BE(16)).toBe(1024);
  expect(png.readUInt32BE(20)).toBe(1024);
  expect(png[24]).toBe(8);
  expect(png[25]).toBe(2);
});

test("rgbPng drops the alpha and keeps each pixel's colour, rows unfiltered", () => {
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 255]);
  const png = rgbPng(rgba, 2, 2);
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(png.readUInt32BE(16)).toBe(2);
  expect(png[25]).toBe(2);
  expect(png.subarray(37, 41).toString()).toBe("IDAT");
  const raw = inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)));
  expect([...raw]).toEqual([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 9, 9, 9]);
  expect(png.subarray(png.length - 8, png.length - 4).toString()).toBe("IEND");
});
