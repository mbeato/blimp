# Visuals in 3D: a visual can be a folder, and the kit gets three.js

Date: 2026-11-15. Branch `visuals-3d`. Size: M. Built 11/15; as built.

## Why

Max, from the phone, in the apartment session: "make it so we can see a 3d render from my phone", then "need a
better way prob in app browser or something to actually go in and interact with the render". Asked how, he gave
the test: "whatever will work the best cross platform between mobile and desktop plus not be limited by a single
model, as they improve should be able to use/generate better assets".

Today a session can't show 3D in blimp:

- A visual is one HTML page of at most 2 MB with everything inside it, and the kit has charts and diagrams only.
- A page can make no requests, so it can't load a model file or a photo that sits beside it.
- That session published its pages on claude.ai instead. On the phone those links leave blimp for Safari, and
  only Claude can make them.

## Decisions (11/15, with Max)

- **3D goes in blimp's own viewer**, the page a session shows with the `show` tool. It is the same page on the
  phone and the Mac, and any agent that has the tool can make one.
- **Open standards, so better models mean better pictures with no change to blimp.** The kit gets three.js (MIT),
  the web's most used 3D library, which every coding model writes. Models and photos come as plain files:
  GLB (the format the AI 3D generators export), PNG, JPEG, WebP.
- **A visual can bring files with it**: `show` takes a folder as well as a page.
- **The lockdown stays.** A page still reaches nothing but blimp's kit and now its own folder.

Looked at and left out: Google's model-viewer (shows one model, with AR on the iPhone, but can't build a scene from
code; it could join the kit later), floor-plan apps like blueprint3d and openPlan3D (whole apps, not parts), an
in-app browser for claude.ai links (Claude only).

## Spike (11/15, done; throwaway, in the session's scratchpad)

A test server sent a page with the headers below, three.js r187 from the kit's place, and a GLB and a PNG beside
the page. Playwright's Chromium and WebKitGTK 2.54 (MiniBrowser over WebKitWebDriver) loaded it top-level (the
phone's case) and in an `<iframe sandbox="allow-scripts">` under the Mac app's policy (the Mac's case). Both
engines, both cases:

1. three.js loads as ES modules through an import map, draws with WebGL (the centre pixel read back), and
   OrbitControls attaches. Neither needs `'unsafe-eval'`.
2. Modules load only when the kit's files are sent with `Access-Control-Allow-Origin`: the page's origin is `null`
   (from `sandbox`), so every module request is cross-origin.
3. `GLTFLoader` reads a GLB beside the page with its texture, `TextureLoader` reads a PNG, and `fetch` reads a
   file, when the policy names the page's own folder and the files are sent with `Access-Control-Allow-Origin`.
4. WebKit needs the folder written with its scheme (`http://host/visuals/<key>/<id>/`). Without a scheme, or as
   `'self'`, WebKit refuses `connect-src` under `sandbox`. Chromium takes all three.
5. `connect-src` needs `blob:` too: `GLTFLoader` reads a texture inside a GLB through a blob URL. Without it the
   model comes in with no texture.
6. Still blocked: another visual, any other blimpd route (GET and POST), the internet, an image from another
   visual.
7. A kit file asked for under the page's folder and answered with a 307 to the shared kit loads, as a module too.
8. With `script-src 'self'`, a page can `import()` another visual's script file and read what it exports (the
   files are sent with `Access-Control-Allow-Origin`). With `script-src` naming only the page's folder and the
   kit's, written with their scheme, that fails and three.js still loads.

Not covered by the spike: iOS's WKWebView and the Mac's real web view. Since then the phone's UI test has drawn
the fixture in the simulator's WKWebView (GitHub's Macs), and the Mac's e2e in Chromium with WebGL on. A real
iPhone and the real Mac app are on the checklists.

## The tool

- **`path` is a page, as now, or a folder** with the page in it as `index.html`. A page alone works as today.
- **A folder is copied whole**: every file in it and under it, so the card keeps showing what you were shown.
  Names that start with a dot are skipped (`.git`, `.DS_Store`).
- **Refused, with the reason in the tool's result**, so the agent can fix it: no `index.html`; `index.html` over
  2 MB or not UTF-8; over 100 MB in all; over 500 files; a symlink (named); a top-level `kit` (that name is
  blimp's); a file outside home or one of blimp's own (`guardFile`'s rules, for every file).
- **The description gains two parts** (the exact text is written and tested in the plan):
  - Files: "To show a page with files beside it (models, images, data), put them in one folder with the page as
    index.html and pass the folder. Load them by relative paths. At most 100 MB."
  - 3D: the import map (`"three": "./kit/three/three.module.js"`, `"three/addons/": "./kit/three/addons/"`), the
    addons the kit has, and how to write for a phone: the canvas fills the page, OrbitControls (one finger turns,
    two fingers zoom and move), `renderer.setPixelRatio(Math.min(devicePixelRatio, 2))`, redraw on resize, a line
    of text while a model loads, plain GLB (no Draco, Meshopt or KTX2).

## The kit

Served from files built into the binary, as the rest of the kit is. Sent gzipped as now.

- three.js 0.187.0 (r187, released 10/30, over two weeks before 11/15), from the npm package, unchanged, with a test
  that the files match their SHA-256 sums:
  - `kit/three/three.module.js` (658,900 bytes,
    `104f56145899722094556490d787aae0617cc2fc3382f31df02d724ea1aee341`) and `kit/three/three.core.js`
    (1,474,799 bytes, `613e370f76638fdef83926642bf256dc9615684922de1ce1f63a8583e5d78578`), which the first imports.
  - `kit/three/addons/`: `controls/OrbitControls.js`, `loaders/GLTFLoader.js`, `utils/BufferGeometryUtils.js` and
    `utils/SkeletonUtils.js` (GLTFLoader imports them), `environments/RoomEnvironment.js` (soft light with no
    image file), `geometries/RoundedBoxGeometry.js`. 223 KB together. Their sums go in the plan.
- WebGL only. The WebGPU builds are left out.
- `blimp.js` doesn't change: a 3D page sets its own colours (the kit's CSS variables are there to read).

## The server

- **The copies:** a new visual is a folder, `~/.blimp/visuals/<id>/`, with `index.html` and the files, beside
  `<id>.json` as now. A page shown alone is a folder with only `index.html`. Earlier copies (`<id>.html`) are
  still read. Mode 700 and 600.
- **Kept:** 30 days, as now, and at most 2 GB in all: over that, the oldest copies go first, and their cards say
  "No longer kept", as they do after 30 days. Checked after each show and in the daily clean-up.
- **Routes**, all under the visual key as now:
  - `GET /visuals/<key>/<id>/`: the page. This is the address both apps now load, so the page's relative paths
    land in its folder.
  - `GET /visuals/<key>/<id>` (no slash): the same page, for an app from before this change. Its kit loads; files
    beside it don't.
  - `GET /visuals/<key>/<id>/<path>`: a file of the copy, streamed from disk. A path that leaves the folder is a
    404. The type comes from the name (`.glb` is `model/gltf-binary`; unknown is `application/octet-stream`).
  - `GET /visuals/<key>/<id>/kit/<file>`: a 307 to `/visuals/<key>/kit/<file>`, so every visual shares one cached
    kit.
- **Headers:**
  - The policy on the page gains its own folder: `img-src data: blob: <folder>`, `connect-src <folder> blob:`
    in place of `connect-src 'none'`, and `script-src 'unsafe-inline' <folder> <kit>` in place of `'self'`
    (the spike's 8), with `<kit>` the kit's `/visuals/<key>/kit/` written as `<folder>` is. `<folder>` is `http://<host>/visuals/<key>/<id>/` and the same with
    `https://`, with `<host>` from the request's `Host` header (blimpd can't tell whether a proxy added TLS, and
    WebKit needs the scheme). A `Host` that isn't letters, digits, dots, colons, hyphens and brackets is left out,
    and the page then gets the policy from before folders and loads no files. Everything else in the policy is
    as it was.
  - Every file of a copy is sent with that policy too, so an HTML file beside the page gets no more than the page.
  - Kit files, the redirect and a copy's files get `Access-Control-Allow-Origin: *`. The address holds the visual
    key, so only something that already has the key can ask.
  - A copy's files are cached like the page (`immutable`, 30 days).
- **`POST /visuals`, the event and the chat message** don't change.

## The phone

- `VisualLink.page` ends the address with `/`. The web view, its one data store per run and its navigation
  delegate don't change: the page's own address still loads and everything else is cancelled.
- Touches go to the page as now. OrbitControls sets `touch-action: none` on its canvas, so a pinch there zooms the
  scene, not the page.
- No new permission, no new screen.

## The Mac

- The frame's address ends with `/` (`api.ts`). Nothing else changes: the app's policy already allows the frame.

## What a page can and can't do

- Can, new: read the files of its own copy (fetch, images, modules), and draw them in 3D.
- Can't, as before: reach another visual, any other blimpd route, the internet, the app, your files or your
  logins; open windows; leave its own address.

## Tests

- Server (`bun test`):
  - visuals.test.ts: a folder is copied with its sub-folders; dot names skipped; each refusal (no `index.html`,
    over 100 MB, over 500 files, a symlink, a top-level `kit`, a file outside home); a page alone becomes a folder
    with `index.html`; an earlier `<id>.html` is still read and cleaned; the 2 GB cap removes the oldest first.
  - server.test.ts: the page at `/<id>/` and `/<id>`; its policy exactly, with the folder in both schemes from
    `Host`, and without it for a bad `Host`; a file's type, policy and `Access-Control-Allow-Origin`; `..` is a
    404; the kit redirect; the kit's three.js files and their header.
  - visuals-mcp.test.ts: the description's new parts; a folder path makes a copy.
  - The kit's three.js files match their pinned sums.
- Mac (Playwright against a real blimpd, `app/e2e/visuals-3d.spec.ts`, with WebGL on): a folder visual with three.js and a GLB
  draws (a pixel of the canvas), reads its own file, and fails to read another visual and a blimpd route.
- Phone: BlimpKit's test for the address. `testVisualCardOpensThePage`'s fixture becomes a folder whose page reads
  a file beside it and draws with three.js, then writes "drawn" for the test to find.
- Checklists (PHONE-CHECKLIST.md, MAC-CHECKLIST.md): "ask for a 3D model of a room; turn it, pinch, move; on
  Wi-Fi and cellular; a narrow and a wide Mac window".

## Docs

- DESIGN.md's Visuals section: the folder, the routes, the policy, the cap, three.js in the kit.
- SECURITY.md's row for a page Claude showed: its own folder, `Access-Control-Allow-Origin`.
- README.md and ios/README.md: one line each. `kit/LICENSES.md`: three.js.

## Not in this change

- Compressed GLB (Draco, Meshopt, KTX2): their decoders are WebAssembly and need a wider policy.
- Photo-real scenes made from photos or video (Gaussian splats, as World Labs' Marble exports): a viewer of about
  3 MB in the kit and files of hundreds of MB. The folder is the way in when it's wanted.
- AR on the iPhone (model-viewer and Quick Look).
- Video or sound in a visual (it needs byte ranges and `media-src`).
- Cards on the phone for Codex sessions: they get the tool and the Mac's tab, but the phone's chat reads Claude
  Code's transcripts only.
- A preview picture on the card.
