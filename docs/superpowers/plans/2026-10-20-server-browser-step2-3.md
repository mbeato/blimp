# Server browser, steps 2–3 (live tabs replace the Mac's) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Every browser tab in blimp is a tab of the server's Chrome. The app shows it live (a
screencast) and sends clicks, scrolling and typing back. The Mac's native web views and the
browser build's iframe are removed.

**Architecture:**
- blimpd opens a CDP session of its own on the tab (straight on the pipe, beside the gate) per
  viewer WebSocket `GET /browser/tabs/<id>/view` (token, like every route).
- It streams `Page.startScreencast` JPEG frames as binary messages. Each frame is acked by the
  app, then acked to Chrome, so a slow link drops frames instead of queueing them.
- Input, navigation, size, dialogs and copy come in as JSON text messages.
- The app's browser tabs are the folder's server tabs from the events socket. ⌘T, port Open and
  close all go through `/browser/tabs`.

**Spec:** `docs/superpowers/specs/2026-10-20-server-browser-design.md`, steps 2 and 3.

## Global Constraints

- blimpd: no npm deps.
- Messages over the view socket:
  - **server → app:**
    - binary: one JPEG frame;
    - text: `{type:"info", url, title, loading, canGoBack, canGoForward}`;
    - text: `{type:"dialog", kind, message, defaultPrompt}`, `{type:"dialog-closed"}`;
    - text: `{type:"copied", text}`.
  - **app → server:**
    - `{type:"ack"}` (after drawing a frame);
    - `{type:"size", width, height, scale}`;
    - `{type:"mouse", event, x, y, button, buttons, clickCount, modifiers, deltaX?, deltaY?}`;
    - `{type:"key", event, key, code, keyCode, text?, modifiers}`;
    - `{type:"text", text}`;
    - `{type:"go", url}`, `{type:"nav", action: "back"|"forward"|"reload"}`;
    - `{type:"copy"}`, `{type:"dialog", accept, text?}`.
- CDP modifiers: Alt 1, Ctrl 2, Meta 4, Shift 8. Mac ⌘ shortcuts for editing (A C V X Z) map to
  Ctrl for Linux Chrome. ⌘C and ⌘V go through the Mac clipboard (`copy` → `copied`; paste →
  `text`). Other ⌘ combos stay the app's.
- A hidden tab has no view socket: no frames cross the network for tabs not on screen.
- Keep the Tauri `unstable` feature: `windows.rs` uses `get_window`/`Window`.

---

### Task 1: The view socket in blimpd

**Files:**
- Create `src/browser/view.ts`.
- Modify `src/browser/chrome.ts` (`onMessage` returns an unsubscribe), `src/browser/service.ts`
  (export `currentChrome()` and the tab check), `src/server.ts` (route and WsData kind).
- Test `test/browser-view.test.ts`, live; skip without Chrome.

`openView(ws, chrome, targetId)`:
- Setup: `Target.attachToTarget {flatten}`, then `Page.enable`, then send `info`.
- On `size`: `Emulation.setDeviceMetricsOverride {width, height, deviceScaleFactor: scale,
  mobile: false}`, then (re)start `Page.startScreencast {format: "jpeg", quality: 70, maxWidth:
  width*scale, maxHeight: height*scale}`.
- Frames: on `Page.screencastFrame`, send the bytes and keep its `sessionId`. On `ack`:
  `Page.screencastFrameAck`.
- Input: `mouse` → `Input.dispatchMouseEvent`; `key` → `Input.dispatchKeyEvent` (type `event`,
  `windowsVirtualKeyCode: keyCode`); `text` → `Input.insertText`.
- Navigation:
  - `go` → `Page.navigate`;
  - `nav` back/forward → `Page.getNavigationHistory` + `Page.navigateToHistoryEntry`;
  - `nav` reload → `Page.reload`.
- Info: sent again on main-frame `Page.frameNavigated`, `Page.navigatedWithinDocument`,
  `frameStartedLoading` / `frameStoppedLoading`. The title comes from
  `Runtime.evaluate("document.title")`; back and forward from the history.
- `copy` → `Runtime.evaluate("String(getSelection())")` → `copied`.
- Dialogs: `Page.javascriptDialogOpening` → `dialog`; the app's `dialog` →
  `Page.handleJavaScriptDialog`; `Page.javascriptDialogClosed` → `dialog-closed`.
- On close: `Page.stopScreencast`, `Target.detachFromTarget`, unsubscribe.

Route: `GET /browser/tabs/<id>/view` → upgrade with `{kind: "view", id}`. 404 if no such tab,
503 if Chrome isn't running.

Tests (live):
- a frame (JPEG magic `FF D8`) arrives after `size`;
- `size` 400x300 at scale 1 → `innerWidth` 400;
- a click on a button changes the page;
- focus an input, then `text` "héllo 👋" → its value;
- `key` Enter submits a form;
- `go` + `nav` back → info url back;
- an `alert` → `dialog`, accept → closed;
- a selection → `copy` → `copied`;
- two viewers both get frames;
- unknown id → 404.

- [ ] Write the tests → fail → implement → pass → commit "Server browser: a live view of a tab, with input".

### Task 2: App: the view client and key mapping

**Files:** Create `app/src/lib/serverview.ts` and `app/src/lib/serverview.test.ts`.

- `cdpModifiers(e)`.
- `keyMessage(e, event)`, a pure function: maps a KeyboardEvent-like value to a `key` message,
  or null when the app keeps the key (⌘ combos other than A C V X Z Y).
- `mouseMessage(e, event, rect)`: `button` none/left/middle/right; `clickCount` from `e.detail`.
- `class ServerView`:
  - holds the WebSocket at `api.viewUrl(id)`;
  - `onFrame(bitmap)`, `onInfo`, `onDialog`, `onCopied`;
  - `send(msg)`;
  - acks after `onFrame` resolves.
- `api.viewUrl(id)` builds the URL like `eventsUrl`.

- [ ] Unit-test the pure mappers → implement → commit.

### Task 3: App: live tabs replace native and iframe tabs

**Files:**
- Modify `app/src/components/PageView.tsx` (rewrite), `app/src/components/Workbench.tsx`
  (tabs from `link.browserTabs` for this folder; new, open port, close and send go through the
  API), `app/src/components/TerminalPane.tsx` (remove step 1's Browser list: the tabs are in the
  strip), `app/src/App.tsx`, `app/src/styles/app.css`.
- e2e: rewrite `app/e2e/browser.spec.ts` and `app/e2e/ports.spec.ts`, and fold in
  `app/e2e/server-browser.spec.ts`.

**PageView:**
- a canvas (frames drawn to fit) inside a focusable area holding a hidden textarea for typing
  and IME (`beforeinput` text → `text`; special keys → `key`);
- mouse and wheel → `mouse`;
- the bar: Back and Forward (from info), Reload, the address (`typedUrl`), Open in Browser,
  Send to session;
- a loading mark; the dialog bar (message, input for a prompt, OK, Cancel);
- Copy and Paste go through the clipboard;
- "Reconnecting" over a greyed last frame while the socket is down.

**Workbench:**
- `pageKey = "tab:" + id`; the tab strip lists this folder's server tabs after the files, with ●
  for `openedBy`;
- ⌘T, + and the globe → `POST {dir, url: HOME}` → active `tab:<id>`;
- port Open → `POST {dir, url: http://localhost:<port>/}`;
- close → `DELETE`;
- Send to session pastes `Browser tab <title> <url> ` (no file upload: the session reads the tab
  with its tools).

**Open in Browser:**
- the server's `localhost:<port>` → `openPort` forward, then `openWebLink(base + path)`;
- anything else → `openWebLink(url)`.

**e2e (browser build, real server Chrome):**
- ⌘T shows Google? No: the browser build has no network guarantee. Use a local test server:
  ⌘T, then type its address → a canvas frame shows; a click on a button changes the page (read
  back with `GET /browser/tabs` titles);
- typing in an input, then reading it back through a title change;
- ports: Open → a server tab at `localhost:<port>`;
- closing removes the tab on the server.

- [ ] Implement → typecheck → unit → e2e → commit.

### Task 4: Remove the Mac's native views; docs

**Remove:**
- `src-tauri/src/browser.rs`;
- its commands in `main.rs` and `build.rs`, and the capabilities' browser permissions;
- `lib/browser.ts` native view functions (`view`, `onViewChange`, `pageFile`, `pageFileName` if
  unused) and `lib/overlay.ts` with its users (it only hid the native view);
- the iframe and `frame-src` in the CSP (index.html, tauri.conf.json csp and devCsp);
- e2e-native browser checks: rewrite them to the live tab (frames arrive in the canvas through
  the real app).

**Docs:** DESIGN (Browser tabs section, Rust browser section, CSP), SECURITY (the browser tab row,
and Accepted: "Logins in browser tabs" now on the server), README (web pages section).

Tests: `cargo test`, `bun test src`, e2e, native e2e.

- [ ] Remove → test everything → commit.
