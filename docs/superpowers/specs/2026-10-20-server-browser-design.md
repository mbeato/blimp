# Server browser: Claude browses, you watch

Date: 2026-10-20. Status: design approved by Max; spike passed (below); building step 1. Size: L (a week or more). Step 1 alone
is M.

## Problem

Browser tabs (v0.2.7) are a native web view on the Mac. Sessions run on the server and can't
reach them: Claude can't open a page, read its source, or see its network requests. Max won't use
the browser much unless a session can. The Mac's web view can't give network data anyway (WebKit
doesn't expose it to the app).

## Decisions

- **The browser lives on the server.** One Chrome, kept running by blimpd, as sessions are. Its
  tabs belong to the server, so every Mac that connects sees the same tabs.
- **Server tabs replace the Mac's browser tabs.** One kind of tab. Everyday browsing is a bit
  slower (the picture comes over the network) and Google may ask "are you a robot" from a server
  address; Max uses his own browser for that.
- **Tabs belong to a folder.** A tab a session opens shows in that session's folder; a tab Max
  opens stays in the folder he opened it in. A session sees only its folder's tabs, so it can look
  at the page Max has open. It's a way to keep things tidy, not a security boundary: all tabs share
  one set of logins.
- **Every session blimp starts gets the browser,** with nothing to switch on. Logins persist on the
  server.
- **A tab Claude opens doesn't come to the front.** It appears in the tab strip with a marker.
- **Claude's tools are Google's Chrome DevTools MCP** (`chrome-devtools-mcp`, 1.11.0 checked):
  page source, network requests with headers and bodies, console, screenshots, clicks, typing.
  blimp doesn't write its own browser tools.

## How it fits together

```
 session (claude / codex)                  blimpd                         Chrome (no window)
   chrome-devtools-mcp  ──ws://127.0.0.1:P/s/<session>──▶  gate  ──pipe──▶  --remote-debugging-pipe
                                                            │
 Mac app (live tab)  ◀──── existing blimpd socket, ssh ─────┘  screencast frames out, input in
```

1. **Chrome.** blimpd starts Chrome (`--headless=new --remote-debugging-pipe`, its own
   `--user-data-dir` under `~/.blimp/browser`) the first time something needs it. No debugging
   port: only blimpd holds the pipe. If Chrome exits, blimpd starts it again and reopens the tabs
   at their last addresses (what was typed into a page is lost).
2. **The gate.** `chrome-devtools-mcp` (Puppeteer) connects only over `ws://`, not a unix socket.
   So blimpd listens on one more port, `127.0.0.1` only, as a CDP proxy. It lets in only
   connections owned by blimpd's own uid (the `uid` column of `/proc/net/tcp` for the peer's
   address; `ports.ts` already reads that file). The path names the session (`/s/<session>`).
   That tells the gate whose folder a new tab belongs to. No secret is needed, so nothing secret
   goes in argv.
3. **Folder scoping in the gate.** Per connection, the gate:
   - tags each target the connection creates (`Target.createTarget` result) with the session's
     folder;
   - passes on target events, `Target.getTargets` results and auto-attach only for targets of
     that folder;
   - refuses `Target.attachToTarget` / `Target.activateTarget` / `Target.closeTarget` for
     another folder's target.

   Fallback, if Puppeteer's handling of filtered targets proves fragile (see the spike): no
   filtering. Sessions see all tabs, and the gate only tags new ones with their folder.
4. **Wiring sessions.** In `kinds.ts`, when blimpd starts a session:
   - **Claude Code** (both kinds) gets `--mcp-config ~/.blimp/browser/mcp-<session>.json`. The
     user's own MCP servers still load (no `--strict-mcp-config`).
   - **Codex** gets the same server through `-c mcp_servers.blimp-browser.…`.
   - **Shells** get nothing. **Sessions already running** get it at their next start.

   The server entry runs `chrome-devtools-mcp --wsEndpoint ws://127.0.0.1:<P>/s/<session>`.
5. **Which Chrome.** The first found of: `google-chrome`, `chromium`, `chromium-browser`,
   Playwright's `~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome`. None → the tab and
   `blimpd browser` say how to install one: `npx playwright install chromium`. Playwright builds
   for arm64 servers too; Chrome for Testing doesn't. Missing system libraries → Chrome's own
   error, shown with the command to install them.

## Step 1: Claude can browse (M)

Everything above, plus a read-only tab list in the app: the folder's browser tabs with title and
address, and a marker on ones a session opened. Clicking one opens its address in the Mac's
browser for now. The Mac's native browser tabs stay as they are until step 2.

API (blimpd, over the existing socket, token as today):
- `GET /browser/tabs?dir=` → `[{ id, url, title, folder, openedBy? }]`.
- `GET /browser/events?dir=` (WebSocket): tabs opened, closed, retitled, navigated.
- `POST /browser/tabs { dir, url }` → `{ id }`; `DELETE /browser/tabs/<id>`.

## Step 2: you can watch and use it (L)

The live tab replaces `PageView`'s native view and iframe.
- **Picture.** `Page.startScreencast` (JPEG, about quality 70) on the tab in front, sent over a
  per-tab WebSocket (`/browser/tabs/<id>/view`). Chrome sends a frame only when the page changes.
  The app draws frames in a canvas and acks each one (`Page.screencastFrameAck`), so a slow link
  drops frames instead of queueing them.
- **Size.** The tab's area in CSS pixels, at the Mac's `devicePixelRatio`
  (`Emulation.setDeviceMetricsOverride`). Two Macs on one tab: the one last used sets the size;
  the other scales the picture to fit.
- **Input.** `Input.dispatchMouseEvent` (move, click, wheel), `Input.dispatchKeyEvent` (keys, with
  ⌘ shortcuts mapped to Ctrl for Linux Chrome), and `Input.insertText` for IME, accents, emoji and
  paste. ⌘C: the page's selection through `Runtime.evaluate`, put on the Mac clipboard.
- **Dialogs.** `Page.javascriptDialogOpening` shows in blimp; the answer goes back with
  `Page.handleJavaScriptDialog`.
- **New windows.** A link that opens a window opens a new tab in the same folder.
- **Bar.** Back, Forward, Reload, and the address with v0.2.7's rules (`typedUrl`: anything not
  an address is a Google search). New tab at Google.
  - **Send to session** pastes `Browser tab <id> (<url>)`, so the session can find it with its
    tools.
  - **Open in Browser** opens the address on the Mac, going through an ssh forward for the
    server's localhost (`forward_port`, as port tabs do today).
- **Connection lost.** The last frame stays, greyed, with "Reconnecting".
- **Chrome restarted.** Tabs reload at their addresses with a short "Browser restarted" note.

## Step 3: clean up (S)

- Remove the Mac native views:
  - `src-tauri/src/browser.rs`
  - its commands in `build.rs` and the capabilities
  - the `unstable` multiwebview feature, if nothing else uses it
  - the iframe path
- "Port 3000 is open · Open" opens a server tab at `http://localhost:3000` directly; no forward.
- Update `docs/DESIGN.md` and `docs/SECURITY.md`.

## Spike first (before step 1)

The gate's folder filtering is the one uncertain part. Puppeteer expects to see every target it
gets events for, and filtering may confuse it (pages opened by a page, service workers, iframes
out of process).

Spike: a throwaway CDP proxy in front of this box's Playwright Chromium, and two
`chrome-devtools-mcp` clients with different session paths. Each opens a page, lists pages, reads
network requests and a page's source. Pass: each sees only its own pages, with no errors.
Fail: use the fallback (tag only).

**Result (2026-10-20): pass, filtering works; no fallback.** Chromium 156 (Playwright's), two and
three `chrome-devtools-mcp@1.11.0` clients through a throwaway gate:
- Each folder sees only its own pages; another folder's page id is "No page found".
- Network requests come with headers and response bodies; source (`evaluate_script`), console,
  and snapshot all work.
- A page opened by a page (`window.open`) lands in the opener's folder.
- A second session in the same folder sees the folder's pages, and keeps them after the first one
  leaves.

What the gate must do, learned there:
- **`--password-store=basic` is required.** Without it, Chrome on a server with no desktop waits
  on the keyring for the cookie key, and every page load hangs after the request is sent. Cookies
  are then encrypted with a fixed key; the profile folder is the user's own (0700).
- **Answer in Chrome's order.** `Target.setDiscoverTargets`: the `targetCreated` events for
  existing targets, then the reply. `Target.setAutoAttach`: attached to existing targets, then
  the reply. Replying first leaves Puppeteer with no pages on its first call.
- **`Target.createTarget`:** Chrome's `targetCreated` can come before or after the reply. The
  gate announces the target once it has both.
- **Folder lookups.** The client's own attach goes through the gate's attach queue. Child
  sessions (iframes, workers) attached inside a session belong to that session's client.
- **Sites see "HeadlessChrome"** in the user agent. Launch with `--user-agent` set to the same
  string without "Headless", so Google treats it as a normal Chrome.
- **Not `--enable-automation`**: it isn't needed, and it marks the browser as automated.
- A folder with no pages: `list_pages` answers with empty text, and Claude opens one with
  `new_page`. Most tools need `pageId` (1.11).

## Not now

- File downloads (they'd land on the server) and file upload inputs (Mac files would go to the
  server first, then `Page.setInterceptFileChooserDialog`).
- Video-smooth pictures (WebRTC). Screencast is enough for dev pages.
- Keeping the Mac web view as a second kind of tab.

## Testing

- **Server (`bun test`, real Chromium on the box):**
  - the gate admits only blimpd's uid (the `/proc/net/tcp` check, on fixture lines and on a live
    connection);
  - a session sees only its folder's tabs, and a tab it opens lands in its folder;
  - Chrome restarts after a kill, with the tabs back;
  - a screencast frame arrives, and a click changes the page.
- **MCP through the gate:** `chrome-devtools-mcp` lists pages, reads network requests and the
  page source.
- **Browser e2e:** a live tab shows frames from the server's Chrome; typing in the address bar
  navigates it.
- **Native e2e (WebKitGTK):** the same, through the real app.
- **Mac checklist (Max):** smoothness, typing latency, Retina sharpness, ⌘C/⌘V.
