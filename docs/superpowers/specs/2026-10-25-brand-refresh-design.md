# The blimp mark, and blimp touches in both apps

Date: 2026-10-25. Branch `brand-refresh`. Directions and app screens:
https://claude.ai/artifact/8T8dK3FvGUW8z6CHAta2od (private to Max).

## Why

Max: the logo is "generated geometry" (three shapes: a lozenge, a fin block, a gondola), and the apps have no
blimp anywhere but the icon. He wants the logo polished and more blimp around the apps, so they feel finished.

## Decisions (Max, 10/25)

- Direction A, "refined", over B (a cream blimp in an indigo night sky) and C (a blimp towing a banner of typing
  dots): the same white blimp on black, drawn properly.
- The apps go monochrome to match: buttons black, white in dark mode, instead of iPhone blue. The colours that mean
  something stay: amber for needs you, blue for unread, red, green and grey on swipe actions.
- The blimp appears on the pair screen, the lock cover, an empty inbox, the connecting bar, the Mac's welcome page and
  its connecting state, and the widgets' "All quiet" (once the widgets branch is merged).

## The mark

One drawing, facing right, in a 1024 box (the page's SVGs are the source):

- The envelope: a teardrop, round nose right, soft point left, shaded white to cool grey top to bottom
  (`#ffffff` → `#eceef2` → `#c3c7d1`), with two panel seams (`#9aa0ae`, 45%) and a highlight along its top
  (white, 90%).
- Four fins at the tail: top and bottom (`#a9aebb`) behind the envelope, the near side fin (`#878d9c`) in front.
- A gondola under the middle (`#d6d9e0`) with three dark windows (`#15161b`).

Renderings:

| File | What | Where |
|---|---|---|
| `ios/app-icon.svg` | The mark on a full graphite square, `#2b2c33` → `#0c0c0f` top to bottom (iOS rounds it) | The iPhone app icon (`AppIcon.png`, 1024, RGB, no transparency) |
| `app/src-tauri/app-icon.svg` | The same on a rounded tile with the macOS icon margin (824 tile, radius 185, as now) | The Mac icon set (`tauri icon` from `app-icon.png`) |
| `brand/blimp-silver.svg` | The mark alone, as above | On dark: the pair header, the lock cover, the Mac |
| `brand/blimp-ink.svg` | The mark alone in graphite (`#55585f` → `#202126`, fins `#1b1c21`, windows light) | On light: the empty inbox in light mode |

`brand/` at the repo root holds the two glyph sources. The iPhone gets them as one asset that switches with the
appearance (`BlimpGlyph`: ink in light mode, silver in dark) and one that's always silver (`BlimpGlyphOnDark`),
both vector SVGs in the asset catalog (Preserve Vector Data). The Mac imports the silver one.

The wordmark: "blimp" in the system's rounded font, heavy (iOS `.fontDesign(.rounded)` with `.heavy`; the Mac
`font-family: ui-rounded`), so there's no font file to ship. It's used for the name only.

## The iPhone

- **App icon:** A.
- **Pair screen** (`PairView`): above what's there now, a graphite card (the icon's gradient, 28 pt corners) with the
  silver blimp and the wordmark. The pairing controls and their words stay as they are.
- **Lock cover** (`LockedView`): the graphite gradient full screen, the silver blimp, the wordmark and "Locked" in
  grey, and Unlock as a white button with dark text. Still no session names, and the Unlock button keeps its label
  (the UI tests find it by it).
- **An empty inbox** (`InboxView`, when a project has nothing): `BlimpGlyph` drifting slowly over a dashed flight
  path, above the words there today (the project's name, "What should Claude do here?").
- **Connecting** (`ConnectionBar`, "Connecting…" and "Reconnecting…"): a small `BlimpGlyph` before the words,
  bobbing 3 pt up and down every 2 s. Offline (the reason it can't connect) it stays still.
- **Motion:** with Reduce Motion on, nothing drifts or bobs.
- **Tint:** the root view's tint becomes `.primary` (black, white in dark mode), so buttons and controls go
  monochrome. Tints set on purpose stay (the swipe actions' red, green, blue and grey). Links inside chat messages
  stay blue, so they still read as links.
- **Widgets** (after the widgets branch is merged): "All quiet" shows `BlimpGlyph` above it.

## The Mac

- **App icon:** A.
- **Welcome page** (`Welcome.tsx`): the silver blimp above the wordmark, in place of the plain "blimp" heading.
- **Connecting:** the same small bobbing blimp beside the Mac's connecting words (respecting reduced motion).
- **Buttons:** the primary button white with near-black text (the Mac app is dark), instead of any blue.

## Not in this change

- Sounds, haptics, a launch animation.
- A new name or a website.
- The README's screenshots (they get redone after, from CI's).

## Tests

- No behaviour changes, so no new logic tests. The UI tests' ids and labels stay (`pairField`, Unlock,
  `drawerProject`…); CI's layout run checks the screens still work, and its screenshots are the visual check.
- The iPhone icon PNG is 1024 × 1024, RGB, no alpha (App Store Connect refuses transparency): checked in CI or by
  `sips -g hasAlpha`.
- Max's checklist: the icon on the home screen, the pair screen, the lock cover, an empty project, Connecting with
  Reduce Motion on and off, light and dark mode, the Mac's welcome page.

## Docs

- `docs/DESIGN.md`: a short "Brand" section (the mark, its files, the wordmark, the monochrome rule and the
  colours that keep their meaning).
- `ios/README.md`: the icon line points at the new source.
