# Brand Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The refined blimp mark (direction A) as both apps' icons, monochrome buttons on the iPhone, and the blimp on
the pair screen, lock cover, empty inbox and connecting bar (iPhone) and the welcome page and connecting pill (Mac).

**Architecture:** `brand/` holds the mark's two SVG sources (silver for dark backgrounds, ink for light); the apps
ship byte-identical copies, which a test checks. `scripts/icons.ts` renders the icon SVGs to the iPhone's
`AppIcon.png` (RGB, no alpha) and the Mac's `app-icon.png`, which `tauri icon` turns into the Mac's set. The iPhone
gets the mark through two asset-catalog image sets and a small `Brand.swift`; the Mac through an imported SVG.

**Tech Stack:** Bun + TypeScript (`bun test`), `@resvg/resvg-js` (dev only, renders SVG), Tauri CLI (`tauri icon`);
SwiftUI (iOS 26, Swift 6, XcodeGen); React + Vite (the Mac app, `app/`).

**Spec:** `docs/superpowers/specs/2026-10-25-brand-refresh-design.md`

## Global Constraints

- Work in the worktree `/Users/mbeato/blimp-brand` on branch `brand-refresh` (made from main at v0.3.11). Never
  touch `/Users/mbeato/blimp`, which is on another branch.
- Commits: plain sentences with an area prefix (`Brand: …`, `iPhone: …`, `Mac: …`, `Docs: …`). Never a
  `Co-Authored-By` line or any Claude attribution.
- bun is at `~/.bun/bin/bun` and not on PATH: run as `PATH=$HOME/.bun/bin:$PATH bun …`.
- There is no Swift toolchain here (Linux): Swift compiles only in CI, with warnings as errors. Write Swift exactly
  as given and re-read every edited region.
- Colours (spec): icon tile `#2b2c33` → `#0c0c0f` top to bottom; envelope `#ffffff` → `#eceef2` → `#c3c7d1`; seams
  `#9aa0ae` at 45%; highlight white at 90%; top and bottom fins `#a9aebb`; side fin `#878d9c`; gondola `#d6d9e0`;
  windows `#15161b`. The ink glyph: envelope `#55585f` → `#3a3c43` → `#202126`, fins `#1b1c21`, side fin
  `#111216`, gondola `#2c2e34`, windows `#f2f2f5`.
- The wordmark: "blimp" in the system's rounded font, heavy (iOS `.system(size:weight: .heavy, design: .rounded)`;
  the Mac `font-family: ui-rounded`). No font files.
- Tint: the iPhone's root tint is `Color.primary`. Swipe actions keep their own tints; links in chat stay blue.
- Motion: nothing drifts with Reduce Motion on, or when UIKit animations are off (the UI tests launch with
  `-noAnimations YES`, and an endless animation would keep them waiting).
- UI tests' ids and labels stay: `pairField`, `scanButton`, `connectButton`, the "Unlock" button, `openTailscale`.
- The widgets' "All quiet" blimp is not in this plan: the widgets branch isn't merged yet (a follow-up).
- iOS CI: never start a manual iOS run while main's push iOS run is going.

## File map

- Create `brand/blimp-silver.svg`, `brand/blimp-ink.svg` (sources).
- Replace `ios/app-icon.svg`, `app/src-tauri/app-icon.svg`; regenerate `ios/Blimp/Assets.xcassets/AppIcon.appiconset/AppIcon.png`,
  `app/src-tauri/app-icon.png`, `app/src-tauri/icons/*`.
- Create `ios/Blimp/Assets.xcassets/BlimpGlyph.imageset/` (Contents.json, both SVGs) and
  `ios/Blimp/Assets.xcassets/BlimpGlyphOnDark.imageset/` (Contents.json, silver SVG); `app/src/assets/blimp-silver.svg`.
- Create `scripts/icons.ts`, `test/brand.test.ts`; modify `package.json` and `bun.lock` (the dev dependency).
- Create `ios/Blimp/Views/Brand.swift`; modify `ios/Blimp/Views/PairView.swift`, `ios/Blimp/Lock.swift`
  (`LockedView`), `ios/Blimp/Views/InboxView.swift`, `ios/Blimp/Views/ConnectionBar.swift`, `ios/Blimp/BlimpApp.swift`,
  `ios/Blimp/Views/MessageViews.swift` (`AssistantText`), `ios/Blimp/Views/PromptBar.swift`.
- Modify `app/src/components/Welcome.tsx`, `app/src/App.tsx`, `app/src/styles/app.css`.
- Docs: `docs/DESIGN.md`, `ios/README.md`, `docs/PHONE-CHECKLIST.md`.

---

### Task 1: The mark's files, the icons, and the copies test

**Files:**
- Create: `brand/blimp-silver.svg`, `brand/blimp-ink.svg`, `scripts/icons.ts`, `test/brand.test.ts`,
  `ios/Blimp/Assets.xcassets/BlimpGlyph.imageset/{Contents.json,blimp-silver.svg,blimp-ink.svg}`,
  `ios/Blimp/Assets.xcassets/BlimpGlyphOnDark.imageset/{Contents.json,blimp-silver.svg}`, `app/src/assets/blimp-silver.svg`
- Replace: `ios/app-icon.svg`, `app/src-tauri/app-icon.svg`
- Regenerate: `ios/Blimp/Assets.xcassets/AppIcon.appiconset/AppIcon.png`, `app/src-tauri/app-icon.png`, `app/src-tauri/icons/*`
- Modify: `package.json`, `bun.lock`, `ios/README.md` (the icon line)

**Interfaces:**
- Produces: image sets `BlimpGlyph` (ink in light, silver in dark) and `BlimpGlyphOnDark` (silver); the Mac asset
  `app/src/assets/blimp-silver.svg` (650 × 300); `rgbPng(rgba: Uint8Array, width: number, height: number): Buffer`
  exported from `scripts/icons.ts`.

- [ ] **Step 1: The sources**

`brand/blimp-silver.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="650" height="300" viewBox="170 336 650 300">
  <defs>
    <linearGradient id="bodyS" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="0.55" stop-color="#eceef2"/>
      <stop offset="1" stop-color="#c3c7d1"/>
    </linearGradient>
  </defs>
  <path d="M300 446 L244 366 Q238 354 252 354 L306 354 Q318 354 326 364 L384 428 Z" fill="#a9aebb"/>
  <path d="M300 514 L244 594 Q238 606 252 606 L306 606 Q318 606 326 596 L384 532 Z" fill="#a9aebb"/>
  <rect x="520" y="570" width="120" height="52" rx="20" fill="#d6d9e0"/>
  <rect x="537" y="598" width="18" height="12" rx="4" fill="#15161b"/>
  <rect x="565" y="598" width="18" height="12" rx="4" fill="#15161b"/>
  <rect x="593" y="598" width="18" height="12" rx="4" fill="#15161b"/>
  <path d="M236 480 C290 420 420 368 572 368 C712 368 796 420 796 480 C796 540 712 592 572 592 C420 592 290 540 236 480 Z" fill="url(#bodyS)"/>
  <path d="M470 374 C452 430 452 530 470 586" fill="none" stroke="#9aa0ae" stroke-opacity="0.45" stroke-width="6" stroke-linecap="round"/>
  <path d="M650 374 C634 430 634 530 650 588" fill="none" stroke="#9aa0ae" stroke-opacity="0.45" stroke-width="6" stroke-linecap="round"/>
  <path d="M430 392 C500 378 610 376 700 398" fill="none" stroke="#ffffff" stroke-opacity="0.9" stroke-width="14" stroke-linecap="round"/>
  <path d="M352 472 L212 466 Q192 466 192 480 Q192 494 212 494 L352 488 Z" fill="#878d9c"/>
</svg>
```

`brand/blimp-ink.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="650" height="300" viewBox="170 336 650 300">
  <defs>
    <linearGradient id="bodyI" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#55585f"/>
      <stop offset="0.55" stop-color="#3a3c43"/>
      <stop offset="1" stop-color="#202126"/>
    </linearGradient>
  </defs>
  <path d="M300 446 L244 366 Q238 354 252 354 L306 354 Q318 354 326 364 L384 428 Z" fill="#1b1c21"/>
  <path d="M300 514 L244 594 Q238 606 252 606 L306 606 Q318 606 326 596 L384 532 Z" fill="#1b1c21"/>
  <rect x="520" y="570" width="120" height="52" rx="20" fill="#2c2e34"/>
  <rect x="537" y="598" width="18" height="12" rx="4" fill="#f2f2f5"/>
  <rect x="565" y="598" width="18" height="12" rx="4" fill="#f2f2f5"/>
  <rect x="593" y="598" width="18" height="12" rx="4" fill="#f2f2f5"/>
  <path d="M236 480 C290 420 420 368 572 368 C712 368 796 420 796 480 C796 540 712 592 572 592 C420 592 290 540 236 480 Z" fill="url(#bodyI)"/>
  <path d="M470 374 C452 430 452 530 470 586" fill="none" stroke="#ffffff" stroke-opacity="0.12" stroke-width="6" stroke-linecap="round"/>
  <path d="M650 374 C634 430 634 530 650 588" fill="none" stroke="#ffffff" stroke-opacity="0.12" stroke-width="6" stroke-linecap="round"/>
  <path d="M430 392 C500 378 610 376 700 398" fill="none" stroke="#ffffff" stroke-opacity="0.35" stroke-width="14" stroke-linecap="round"/>
  <path d="M352 472 L212 466 Q192 466 192 480 Q192 494 212 494 L352 488 Z" fill="#111216"/>
</svg>
```

- [ ] **Step 2: The icon SVGs**

Replace `ios/app-icon.svg` with (a full square: iOS rounds the corners itself):

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <!-- iPhone app icon: the refined blimp (brand/blimp-silver.svg's drawing) on a full graphite square; iOS rounds the corners. -->
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2b2c33"/>
      <stop offset="1" stop-color="#0c0c0f"/>
    </linearGradient>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="0.55" stop-color="#eceef2"/>
      <stop offset="1" stop-color="#c3c7d1"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" fill="url(#tile)"/>
  <g transform="translate(21 24)">
    <path d="M300 446 L244 366 Q238 354 252 354 L306 354 Q318 354 326 364 L384 428 Z" fill="#a9aebb"/>
    <path d="M300 514 L244 594 Q238 606 252 606 L306 606 Q318 606 326 596 L384 532 Z" fill="#a9aebb"/>
    <rect x="520" y="570" width="120" height="52" rx="20" fill="#d6d9e0"/>
    <rect x="537" y="598" width="18" height="12" rx="4" fill="#15161b"/>
    <rect x="565" y="598" width="18" height="12" rx="4" fill="#15161b"/>
    <rect x="593" y="598" width="18" height="12" rx="4" fill="#15161b"/>
    <path d="M236 480 C290 420 420 368 572 368 C712 368 796 420 796 480 C796 540 712 592 572 592 C420 592 290 540 236 480 Z" fill="url(#body)"/>
    <path d="M470 374 C452 430 452 530 470 586" fill="none" stroke="#9aa0ae" stroke-opacity="0.45" stroke-width="6" stroke-linecap="round"/>
    <path d="M650 374 C634 430 634 530 650 588" fill="none" stroke="#9aa0ae" stroke-opacity="0.45" stroke-width="6" stroke-linecap="round"/>
    <path d="M430 392 C500 378 610 376 700 398" fill="none" stroke="#ffffff" stroke-opacity="0.9" stroke-width="14" stroke-linecap="round"/>
    <path d="M352 472 L212 466 Q192 466 192 480 Q192 494 212 494 L352 488 Z" fill="#878d9c"/>
  </g>
</svg>
```

Replace `app/src-tauri/app-icon.svg` with (the macOS icon margin kept: an 824 tile, radius 185, as before):

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <!-- App icon: the refined blimp (brand/blimp-silver.svg's drawing) on a graphite tile. The tile leaves the macOS icon margin. -->
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2b2c33"/>
      <stop offset="1" stop-color="#0c0c0f"/>
    </linearGradient>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="0.55" stop-color="#eceef2"/>
      <stop offset="1" stop-color="#c3c7d1"/>
    </linearGradient>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#tile)"/>
  <g transform="translate(512 512) scale(0.8) translate(-491 -488)">
    <path d="M300 446 L244 366 Q238 354 252 354 L306 354 Q318 354 326 364 L384 428 Z" fill="#a9aebb"/>
    <path d="M300 514 L244 594 Q238 606 252 606 L306 606 Q318 606 326 596 L384 532 Z" fill="#a9aebb"/>
    <rect x="520" y="570" width="120" height="52" rx="20" fill="#d6d9e0"/>
    <rect x="537" y="598" width="18" height="12" rx="4" fill="#15161b"/>
    <rect x="565" y="598" width="18" height="12" rx="4" fill="#15161b"/>
    <rect x="593" y="598" width="18" height="12" rx="4" fill="#15161b"/>
    <path d="M236 480 C290 420 420 368 572 368 C712 368 796 420 796 480 C796 540 712 592 572 592 C420 592 290 540 236 480 Z" fill="url(#body)"/>
    <path d="M470 374 C452 430 452 530 470 586" fill="none" stroke="#9aa0ae" stroke-opacity="0.45" stroke-width="6" stroke-linecap="round"/>
    <path d="M650 374 C634 430 634 530 650 588" fill="none" stroke="#9aa0ae" stroke-opacity="0.45" stroke-width="6" stroke-linecap="round"/>
    <path d="M430 392 C500 378 610 376 700 398" fill="none" stroke="#ffffff" stroke-opacity="0.9" stroke-width="14" stroke-linecap="round"/>
    <path d="M352 472 L212 466 Q192 466 192 480 Q192 494 212 494 L352 488 Z" fill="#878d9c"/>
  </g>
</svg>
```

- [ ] **Step 3: The copies the apps ship**

```bash
cd /Users/mbeato/blimp-brand
mkdir -p ios/Blimp/Assets.xcassets/BlimpGlyph.imageset ios/Blimp/Assets.xcassets/BlimpGlyphOnDark.imageset app/src/assets
cp brand/blimp-silver.svg brand/blimp-ink.svg ios/Blimp/Assets.xcassets/BlimpGlyph.imageset/
cp brand/blimp-silver.svg ios/Blimp/Assets.xcassets/BlimpGlyphOnDark.imageset/
cp brand/blimp-silver.svg app/src/assets/
```

`ios/Blimp/Assets.xcassets/BlimpGlyph.imageset/Contents.json`:

```json
{
  "images" : [
    {
      "filename" : "blimp-ink.svg",
      "idiom" : "universal"
    },
    {
      "appearances" : [
        {
          "appearance" : "luminosity",
          "value" : "dark"
        }
      ],
      "filename" : "blimp-silver.svg",
      "idiom" : "universal"
    }
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  },
  "properties" : {
    "preserves-vector-representation" : true
  }
}
```

`ios/Blimp/Assets.xcassets/BlimpGlyphOnDark.imageset/Contents.json`:

```json
{
  "images" : [
    {
      "filename" : "blimp-silver.svg",
      "idiom" : "universal"
    }
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  },
  "properties" : {
    "preserves-vector-representation" : true
  }
}
```

- [ ] **Step 4: Write the failing test**

Create `test/brand.test.ts`:

```ts
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
```

Run: `cd /Users/mbeato/blimp-brand && PATH=$HOME/.bun/bin:$PATH bun test test/brand.test.ts`
Expected: FAIL, `Cannot find module '../scripts/icons'`.

- [ ] **Step 5: The dev dependency and `scripts/icons.ts`**

Run: `cd /Users/mbeato/blimp-brand && PATH=$HOME/.bun/bin:$PATH bun add -d @resvg/resvg-js@2.6.2`
(It's in bun's cache; it renders SVG with prebuilt binaries for Linux and macOS.)

Create `scripts/icons.ts`:

```ts
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
```

- [ ] **Step 6: Render the icons**

```bash
cd /Users/mbeato/blimp-brand && PATH=$HOME/.bun/bin:$PATH bun scripts/icons.ts
cd app && PATH=$HOME/.bun/bin:$PATH bun install && PATH=$HOME/.bun/bin:$PATH bun run tauri icon src-tauri/app-icon.png
cd .. && git status --short app/src-tauri/icons
```

`tauri icon` (Tauri 2) also writes `icons/android/` and `icons/ios/`, which this repo doesn't keep: delete any
untracked folder or file it added under `app/src-tauri/icons` (the `??` lines), and keep the modified tracked ones.
Look at `ios/Blimp/Assets.xcassets/AppIcon.appiconset/AppIcon.png` and `app/src-tauri/icons/128x128@2x.png` with your
image viewer (the Read tool shows images): the refined blimp on graphite, the Mac one with its margin.

- [ ] **Step 7: Run the test**

Run: `cd /Users/mbeato/blimp-brand && PATH=$HOME/.bun/bin:$PATH bun test test/brand.test.ts`
Expected: PASS, 6 tests. Then the full suite: `PATH=$HOME/.bun/bin:$PATH bun test` → 0 fail.

- [ ] **Step 8: README**

In `ios/README.md`, replace the icon sentence ("The icon is `Blimp/Assets.xcassets/AppIcon.appiconset/AppIcon.png`,
drawn from `ios/app-icon.svg` (…)") with:

```markdown
The icon is `Blimp/Assets.xcassets/AppIcon.appiconset/AppIcon.png`, rendered from `ios/app-icon.svg` (the refined blimp on a full graphite square; RGB, no transparency, which the App Store requires) by `bun scripts/icons.ts` at the repo root, which also renders the Mac's `app/src-tauri/app-icon.png` (then `bun run tauri icon src-tauri/app-icon.png` in `app/`). The blimp alone is `brand/blimp-silver.svg` (on dark) and `brand/blimp-ink.svg` (on light); the apps ship copies, which `test/brand.test.ts` keeps the same.
```

- [ ] **Step 9: Commit**

```bash
cd /Users/mbeato/blimp-brand
git add brand scripts/icons.ts test/brand.test.ts package.json bun.lock ios/app-icon.svg ios/Blimp/Assets.xcassets app/src-tauri/app-icon.svg app/src-tauri/app-icon.png app/src-tauri/icons app/src/assets ios/README.md
git commit -m "Brand: the refined blimp (a shaded envelope with seams, four fins and a gondola with windows) as the iPhone and Mac icons on graphite, brand/'s silver and ink marks with the copies both apps ship, scripts/icons.ts to render the icons, and a test that the copies match and the iPhone icon is RGB"
```

---

### Task 2: The blimp in the iPhone app, and monochrome buttons

**Files:**
- Create: `ios/Blimp/Views/Brand.swift`
- Modify: `ios/Blimp/Views/PairView.swift`, `ios/Blimp/Lock.swift` (`LockedView`), `ios/Blimp/Views/InboxView.swift`
  (the empty overlay, ~line 72), `ios/Blimp/Views/ConnectionBar.swift` (body), `ios/Blimp/BlimpApp.swift` (`BlimpApp.body`),
  `ios/Blimp/Views/MessageViews.swift` (`AssistantText`), `ios/Blimp/Views/PromptBar.swift` (~line 218)
- Docs: `docs/PHONE-CHECKLIST.md`

**Interfaces:**
- Consumes: the image sets `BlimpGlyph` and `BlimpGlyphOnDark` (Task 1).
- Produces: `Brand.graphite: LinearGradient`, `Wordmark(size:)`, `BlimpMark(width:onDark:)`, `FlightPath()`,
  `View.drift(_ distance: CGFloat, every period: Double)`.

Swift is compiled only in CI, with warnings as errors (Global Constraints).

- [ ] **Step 1: Create `ios/Blimp/Views/Brand.swift`**

```swift
// The blimp in the app (docs/superpowers/specs/2026-10-25-brand-refresh-design.md): the mark (the BlimpGlyph asset,
// ink in light mode and silver in dark; BlimpGlyphOnDark, always silver), the wordmark in the system's rounded font,
// the graphite the icon sits on, an empty inbox's flight path, and a gentle drift that stays still with Reduce Motion
// or with UIKit's animations off (the UI tests turn them off, and an endless animation would keep them waiting).
import SwiftUI
import UIKit

enum Brand {
    /// The icon's graphite, top to bottom (#2b2c33 → #0c0c0f).
    static let graphite = LinearGradient(
        colors: [Color(red: 0x2b / 255, green: 0x2c / 255, blue: 0x33 / 255), Color(red: 0x0c / 255, green: 0x0c / 255, blue: 0x0f / 255)],
        startPoint: .top, endPoint: .bottom)
}

/// "blimp" in the system's rounded font, heavy.
struct Wordmark: View {
    var size: CGFloat = 34

    var body: some View {
        Text(verbatim: "blimp").font(.system(size: size, weight: .heavy, design: .rounded))
    }
}

/// The mark, `width` points wide (it's 650 × 300). onDark: the silver one whatever the appearance.
struct BlimpMark: View {
    var width: CGFloat
    var onDark = false

    var body: some View {
        Image(onDark ? "BlimpGlyphOnDark" : "BlimpGlyph")
            .resizable()
            .aspectRatio(contentMode: .fit)
            .frame(width: width)
            .accessibilityHidden(true)
    }
}

/// An empty inbox's picture: the blimp drifting over a dashed flight path.
struct FlightPath: View {
    var body: some View {
        ZStack {
            Path { p in
                p.move(to: CGPoint(x: 0, y: 70))
                p.addQuadCurve(to: CGPoint(x: 220, y: 70), control: CGPoint(x: 110, y: -10))
            }
            .stroke(.tertiary, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, dash: [5, 6]))
            .frame(width: 220, height: 80)
            .offset(y: 24)
            BlimpMark(width: 130).drift(4, every: 4)
        }
        .frame(height: 120)
    }
}

/// Moves its content up and down by `distance` points, once every `period` seconds. Still with Reduce Motion, with
/// UIKit's animations off, or for a distance of 0.
private struct Drift: ViewModifier {
    var distance: CGFloat
    var period: Double
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var up = false

    private var still: Bool { reduceMotion || distance == 0 || !UIView.areAnimationsEnabled }

    func body(content: Content) -> some View {
        content
            .offset(y: still ? 0 : (up ? -distance : distance))
            .animation(still ? nil : .easeInOut(duration: period / 2).repeatForever(autoreverses: true), value: up)
            .onAppear { if !still { up = true } }
    }
}

extension View {
    func drift(_ distance: CGFloat, every period: Double) -> some View {
        modifier(Drift(distance: distance, period: period))
    }
}
```

- [ ] **Step 2: The pair screen (`PairView.swift`)**

As the first thing inside `Form {` (before `if canScan {`), add:

```swift
                // The blimp, as on the icon.
                Section {
                    VStack(spacing: 8) {
                        BlimpMark(width: 190, onDark: true)
                        Wordmark().foregroundStyle(.white)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 36)
                    .background(Brand.graphite, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                }
```

After `.navigationTitle("Connect")`, add `.navigationBarTitleDisplayMode(.inline)` (the card is the screen's top now).

- [ ] **Step 3: The lock cover (`Lock.swift`, `LockedView`)**

Replace `LockedView`'s `body` with:

```swift
    var body: some View {
        VStack(spacing: 14) {
            Spacer()
            BlimpMark(width: 200, onDark: true)
            Wordmark(size: 40).foregroundStyle(.white)
            Text("Locked").font(.subheadline).foregroundStyle(Color(white: 0.63))
            Spacer()
            Button { Task { await lock.unlock() } } label: {
                Label("Unlock", systemImage: "faceid")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .frame(height: 52)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color(red: 0x0c / 255, green: 0x0c / 255, blue: 0x0f / 255))
            .background(.white, in: Capsule())
            .opacity(lock.locked ? 1 : 0)
            if let note = lock.note, lock.locked { Text(note).font(.footnote).foregroundStyle(Color(white: 0.63)) }
        }
        .padding(.horizontal, 32)
        .padding(.bottom, 48)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Brand.graphite)
        // Over a live Home, .accessibilityHidden doesn't reach Home's UIKit-hosted parts (the navigation bar,
        // the chat), so the cover itself shuts VoiceOver and the UI tests out of everything beside it.
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
    }
```

(The button's label stays "Unlock": the UI tests find it by it. The old `Image(systemName: "lock")` goes.)

- [ ] **Step 4: An empty inbox (`InboxView.swift`)**

In the `.overlay { if inbox.isEmpty && needs.isEmpty { VStack(spacing: 6) { … } } }`, add `FlightPath()` as the
VStack's first child, above `Text(Drawer.name(of: dir))`, and change its spacing to 8:

```swift
                VStack(spacing: 8) {
                    FlightPath()
                    Text(Drawer.name(of: dir)).font(.title2.bold())
                    Text("What should Claude do here?").foregroundStyle(.secondary)
                }
```

- [ ] **Step 5: Connecting (`ConnectionBar.swift`)**

In `body`, make the `HStack`'s first child the mark, shown while connecting or offline (bobbing only while
connecting):

```swift
            HStack(spacing: 10) {
                if case .connecting = store.connection {
                    BlimpMark(width: 24).drift(3, every: 2)
                } else if offline {
                    BlimpMark(width: 24)
                }
                Text(text).font(.footnote)
```

(the rest of the HStack as it is). Add to the file's header comment: `The blimp bobs beside "Connecting…" (still
when offline).`

- [ ] **Step 6: Monochrome tint (`BlimpApp.swift`), links stay blue**

In `BlimpApp.body`, change `Root().environment(store).environment(lock)` to
`Root().environment(store).environment(lock).tint(Color.primary)` and add above it the comment
`// Buttons and controls in black, white in dark mode (the icon's monochrome); tints set on purpose stay.`

In `MessageViews.swift`'s `AssistantText`, add `.tint(.blue)` after its `.frame(maxWidth: .infinity, alignment: .leading)`
with the comment `// Links in a reply stay blue under the app's monochrome tint.` In `PromptBar.swift` (~line 218),
add `.tint(.blue)` to `BlockView(block: block)` the same way.

- [ ] **Step 7: Re-read every edited Swift region**

Check: `Brand.swift` imports UIKit for `UIView.areAnimationsEnabled` (read on the main actor inside a View: fine in
Swift 6); `Image("BlimpGlyph")` names match the image sets exactly; `Label("Unlock", systemImage:)` keeps the
accessibility label "Unlock"; `.stroke(.tertiary, style:)` takes a ShapeStyle; nothing unused (warnings are errors).

- [ ] **Step 8: Checklist**

At the end of `docs/PHONE-CHECKLIST.md`, add:

```markdown
## The blimp

- [ ] The home screen icon: the refined blimp on graphite, in light and dark mode.
- [ ] The pair screen: the graphite card with the blimp and "blimp" above Scan and the link field.
- [ ] The lock cover: graphite, the blimp, "blimp", "Locked", and a white Unlock button; no session names.
- [ ] A project with nothing: the blimp drifting over a dashed path above "What should Claude do here?", dark in light mode, silver in dark.
- [ ] Turn Tailscale off: the blimp beside "Reconnecting…" bobs, then stays still once it says why it's offline. With Reduce Motion on (Settings, Accessibility, Motion), nothing moves.
- [ ] Buttons are black (white in dark mode); links in Claude's replies are still blue; swipe actions keep their colours.
```

- [ ] **Step 9: Commit**

```bash
cd /Users/mbeato/blimp-brand
git add ios/Blimp/Views/Brand.swift ios/Blimp/Views/PairView.swift ios/Blimp/Lock.swift ios/Blimp/Views/InboxView.swift ios/Blimp/Views/ConnectionBar.swift ios/Blimp/BlimpApp.swift ios/Blimp/Views/MessageViews.swift ios/Blimp/Views/PromptBar.swift docs/PHONE-CHECKLIST.md
git commit -m "iPhone: the blimp on the pair screen (a graphite card with the wordmark), the lock cover (graphite, the blimp, a white Unlock), an empty inbox (drifting over a dashed path) and the connecting bar (bobbing, still offline or with Reduce Motion); buttons black, white in dark mode, links in replies still blue"
```

---

### Task 3: The blimp on the Mac, and the docs

**Files:**
- Modify: `app/src/components/Welcome.tsx` (the `<h1>blimp</h1>`), `app/src/App.tsx` (the `conn` pill, ~line 615),
  `app/src/styles/app.css` (`.welcome-col h1`, `.conn`)
- Docs: `docs/DESIGN.md`

**Interfaces:**
- Consumes: `app/src/assets/blimp-silver.svg` (Task 1).

The Mac's primary buttons are already light on dark (`button.primary { background: var(--fg); color: var(--bg) }`
in `app.css`): nothing to change there.

- [ ] **Step 1: The welcome page (`Welcome.tsx`)**

Add `import blimpMark from "../assets/blimp-silver.svg";` with the other imports, and replace `<h1>blimp</h1>` with:

```tsx
        <div className="welcome-brand">
          <img src={blimpMark} alt="" width={132} height={61} />
          <h1>blimp</h1>
        </div>
```

In `app.css`, replace the `.welcome-col h1` rule with:

```css
.welcome-brand {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  margin: 0 0 6px;
}

.welcome-col h1 {
  margin: 0;
  font-family: ui-rounded, -apple-system, system-ui, sans-serif;
  font-size: 30px;
  font-weight: 800;
}
```

- [ ] **Step 2: The connecting pill (`App.tsx`)**

Add `import blimpMark from "./assets/blimp-silver.svg";` with the other imports. In the `conn` span (the one showing
`{link.status === "offline" ? "offline" : "connecting…"}`), put before the text:

```tsx
            {link.status !== "offline" && <img className="conn-mark" src={blimpMark} alt="" />}
```

In `app.css`, after the existing `.conn` rules (find them with `grep -n "^\.conn" app/src/styles/app.css`), add:

```css
/* The blimp bobs beside "connecting…" (still with reduced motion). */
.conn-mark {
  width: 22px;
  height: auto;
  margin-right: 6px;
  vertical-align: -2px;
  animation: blimp-bob 2s ease-in-out infinite;
}

@keyframes blimp-bob {
  0%,
  100% {
    transform: translateY(1.5px);
  }
  50% {
    transform: translateY(-1.5px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .conn-mark {
    animation: none;
  }
}
```

- [ ] **Step 3: Check the Mac app builds and its tests pass**

Run: `cd /Users/mbeato/blimp-brand/app && PATH=$HOME/.bun/bin:$PATH bun run build && PATH=$HOME/.bun/bin:$PATH bun test`
Expected: the Vite build succeeds (the SVG import resolves to an asset URL); tests 0 fail. If `app/package.json`
has a `typecheck` or `tsc` script, run it too.

- [ ] **Step 4: DESIGN.md**

Add at the end of `docs/DESIGN.md`:

```markdown
## Brand

The mark is a refined blimp facing right: a shaded white envelope with two panel seams and a highlight, four fins at the tail, and a gondola with three windows (design in `docs/superpowers/specs/2026-10-25-brand-refresh-design.md`). Its sources are `brand/blimp-silver.svg` (for dark backgrounds) and `brand/blimp-ink.svg` (graphite, for light ones); the iPhone's asset catalog (`BlimpGlyph`, ink in light mode and silver in dark; `BlimpGlyphOnDark`) and the Mac (`app/src/assets/`) ship copies, which `test/brand.test.ts` keeps the same. The icons are the mark on graphite (`#2b2c33` → `#0c0c0f`): `ios/app-icon.svg` and `app/src-tauri/app-icon.svg`, rendered by `bun scripts/icons.ts`.

The name is written in the system's rounded font, heavy. Buttons are monochrome: black, white in dark mode, on the iPhone (its root tint), light on dark on the Mac. Colour means something: amber for needs you, blue for unread and for links, and the swipe actions' red, green, blue and grey. The blimp appears on the pair screen, the lock cover, an empty inbox and beside "Connecting…" on the iPhone, and on the Mac's welcome page and connecting pill; it drifts or bobs, and keeps still with reduced motion.
```

- [ ] **Step 5: Commit**

```bash
cd /Users/mbeato/blimp-brand
git add app/src/components/Welcome.tsx app/src/App.tsx app/src/styles/app.css docs/DESIGN.md
git commit -m "Mac: the blimp above a rounded, heavy wordmark on the welcome page and bobbing beside connecting… (still with reduced motion); Docs: DESIGN.md's Brand section"
```

---

### Task 4: CI verification

- [ ] **Step 1:** Run the whole server suite in the worktree: `PATH=$HOME/.bun/bin:$PATH bun test` → 0 fail.
- [ ] **Step 2:** Ask Max before pushing (it starts the iOS CI on the MacBook): one plain line.
- [ ] **Step 3:** On a yes, push `brand-refresh` and watch its iOS run in the background. Fix compile errors through a
  helper, one commit each.
- [ ] **Step 4:** Check main's iOS runs are idle, then run the layout tests:
  `gh workflow run iOS --ref brand-refresh -f layout=true -f testflight=false`, watch it, and look at the
  screenshots (the pair screen, a chat, the drawer, an empty inbox if one is shot) for the blimp and the black buttons.
- [ ] **Step 5:** Report to Max with the screenshots that show the blimp, and what to check on his phone
  (`docs/PHONE-CHECKLIST.md`, "The blimp"). Note the follow-up: the widgets' "All quiet" blimp once both branches are on main.
