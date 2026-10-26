# Visuals: Claude shows you a chart, a diagram or a small page, on the phone and the Mac

Date: 2026-10-26. Branch `visuals`. Size: L (about the widgets' size).

## Why

Max: "blimp needs the ability to generate/render better visuals at least in mobile as well as desktop". Today a
session can only answer in text:

- The phone's chat shows a table as monospace text, a Mermaid diagram as its code, and an image a tool returned
  as "[image]" (`MessageViews.swift` `BlockView`, `chat.ts` `resultText`).
- The Mac shows replies only in the terminal. It can open an image, Markdown or PDF file in a tab, and an HTML file
  with its scripts removed (`FileViews.tsx` `HtmlView`), but nothing appears next to a reply.
- A session can open a page in the server's browser, which both apps show, but that's a video of a Chrome on the
  server (soft, laggy to scroll on the phone), the phone keeps it in the drawer rather than the chat, and the
  page runs in the profile you're signed in to sites with.

## Decisions (10/26, with Max)

- **Claude makes visuals on purpose**, with a new tool, rather than blimp guessing which replies or files to draw.
- **Visuals are web pages that run scripts**, not pictures: tap a bar for its value, switch tabs, scroll a long
  table, follow light and dark. One format covers charts, diagrams, mockups and reports.
- **Each app shows the page itself** (a web view on the phone, a frame in a Mac tab), locked down: no internet,
  no reach into the server, the app, your files or your logins. Not the server's browser.
- **blimp ships a look kit** (its colours, a chart library, a diagram library) so pages look like blimp and need
  no internet.

## How a visual travels

```
session: Claude writes chart.html, calls mcp__blimp__show { path, title }
  └─ blimpd visuals-mcp (stdio, run by Claude Code) ── POST /visuals (unix socket, Mac token) ──> blimpd
       blimpd: copies the page to ~/.blimp/visuals/<id>.html, publishes { type: "visual" } on /events
       └─ tool result: "Shown on the phone and the Mac. visual: <id>"
phone: the chat sees the tool call in the transcript ──> a card ──> tap ──> GET /visuals/<key>/<id> in a web view
Mac:   the "visual" event ──> a tab in that project ──> GET /visuals/<key>/<id> in a frame
```

1. Claude writes one HTML file, in the project or anywhere under home.
2. It calls `show` with the file and a title.
3. blimpd keeps a copy of the page as it was then. If Claude changes the file later, the card still shows what
   you were shown. Each call makes a new copy.
4. The phone's chat already gets every tool call from the transcript and hides it. A `show` call becomes a card,
   where Claude made it in the conversation.
5. The Mac gets an event at once and opens the page in that project's window.
6. Both apps load the page from blimpd with the visual key, which reads visuals and nothing else.

## The tool

- **`blimpd visuals-mcp`**: a small MCP server over stdio (JSON-RPC 2.0, one message per line), written in
  blimpd with no MCP library: `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`. One
  tool, `show`. Claude Code sees it as `mcp__blimp__show`.
- It knows its session from `ZMX_SESSION`, as `browser-mcp` does, and reaches blimpd over the unix socket with the
  Mac token from `~/.blimp/token`, as `blimpd send` does (`src/send.ts`).
- **Every session blimp starts gets it**, with or without Chrome. Today `mcp.json` is written only by the browser
  gate and `launchFor` adds `--mcp-config` only when Chrome and npx are there (`kinds.ts`). New: blimpd writes
  `~/.blimp/mcp.json` when it starts, with `blimp` always and `blimp-browser` when the browser is ready, and
  Claude Code always gets `--mcp-config`. Codex gets `mcp_servers.blimp.*` overrides the same way.
- **Input:** `path` (absolute, or relative to the session's folder) and `title` (short; shown on the card and the
  tab, at most 80 characters).
- **Refused, with the reason in the tool's result** (`isError`), so Claude can fix it: no such file; not under
  home or one of blimp's own files (`guardFile`'s rules); over 2 MB; not UTF-8 text; no title; blimpd not
  running.
- **Result:** `Shown on the phone and the Mac. visual: <id>`. The chat reads the id from that line.

### What the tool's description tells Claude

The description is Claude's instructions; it reads it with the tool. Roughly:

> Show the user a visual on their phone and Mac: a chart, a diagram, a table, a timeline or a small report, as
> one HTML file you wrote. Use it when a picture explains better than text.
> The page has no internet. Load only blimp's kit, by relative paths: `kit/blimp.css` (blimp's colours for light
> and dark, the system font, `.card`, `.stat`, `.grid`, tables), `kit/chart.js` (Chart.js), `kit/mermaid.js`
> (Mermaid; put a diagram in `<pre class="mermaid">`) and `kit/blimp.js` last (sets both to blimp's look and
> follows light and dark). Put everything else in the file: inline styles, scripts, SVG, `data:` images.
> Design for a phone first (about 390 px wide) and make it work in a wide Mac tab: one column that becomes a grid
> where there's room. Text at least 14 px. Nothing only on hover: a tap shows a chart's values. Start with
> `<meta name="viewport" content="width=device-width, initial-scale=1">`. At most 2 MB. After you change the
> file, call show again.

The exact text is written and tested in the plan.

## The server

- **The copies:** `~/.blimp/visuals/<id>.html` and `<id>.json` (`{ id, title, session, dir, source, at }`), mode
  600. The id: 12 random hex characters. A copy is kept 30 days, cleaned when blimpd starts and once a day.
- **`POST /visuals { session, path, title }`** (Mac or phone token, as other routes): checks the file, makes the
  copy, publishes the event, returns `{ id }`.
- **The event**, on `/events` like `browser` and `fs`: `{ type: "visual", id, title, session, dir, source, at }`.
  Older Macs drop unknown types; the phone ignores them (`EventsMessage` `.other`).
- **The visual key:** HMAC-SHA256 of a token with the text `blimp visuals`, hex, for the Mac's token and the
  phone's (as the widget key is for the phone's). `GET /visuals/key` (Mac or phone token) gives the caller its
  own. It reads `/visuals/<key>/...` and nothing else; anywhere else it is refused like a wrong token. Revoking
  the phone (`blimpd pair --revoke`) changes the phone's.
- **The key is in the path**, so the page's relative `kit/...` paths carry it: the page is
  `GET /visuals/<key>/<id>` and the kit is `GET /visuals/<key>/kit/<file>`. A missing or expired copy is 404.
- **Every page is sent with these headers:**
  - `Content-Security-Policy: default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self'
    'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; frame-src 'none';
    object-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts`
  - `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: private, max-age=2592000,
    immutable` (a copy never changes).
  - If the spike finds WebKit doesn't match `'self'` in a sandboxed page, blimpd names its own origin instead.
- **The chat** (`chat.ts`): a `tool_use` named `mcp__blimp__show` is a hidden `tool` message as now; when its
  result comes back without an error, the same id becomes `{ role: "visual", title, visual: <id>, gone?,
  summary: "Showed <title>" }`. `gone: true` when the copy is no longer kept, worked out when the chat is sent.
  An older phone app decodes the unknown role as `tool` and keeps hiding it; `summary` is what its working row
  shows.

## The look kit

- Served by blimpd from files built into the binary (bun's `with { type: "file" }` imports), in `src/visuals/kit/`:
  - `blimp.css`: the colours from `app/src/styles/theme.css` in light and dark (`prefers-color-scheme`), the
    system font, a 16 px base, and a few classes: `.card`, `.stat` (a big number and its label), `.grid` (one
    column on a phone, more where there's room), tables (lines, numbers right-aligned, scroll sideways).
  - `chart.js`: Chart.js, the UMD build.
  - `mermaid.js`: Mermaid, a build that runs from a plain `<script>`.
  - `blimp.js`: Chart.js's defaults from blimp's colours and font (the terminal palette's six colours for series),
    `mermaid.initialize` with blimp's theme and `securityLevel: "strict"`; redraws both when light and dark
    change.
- Versions: the latest of each released at least two weeks before planning, pinned in the plan with their SHA-256
  sums and a test that the files match them. Both are MIT, like blimp.

## The phone

- **The card** (`MessageRow`'s new `.visual` case): a chart symbol, the title and "Tap to open", in the reply's
  width. `gone`: greyed, "No longer kept", not tappable. No preview picture for now.
- **Tap:** the page full screen over the chat, as a browser tab opens (an `.overlay` in `HomeView`): a top bar with
  the title and Done, the page below. Done goes back to the same place in the chat. The Face ID lock closes it,
  as it closes sheets.
- **The web view** (`WKWebView` in a `UIViewRepresentable`; the app's first): a non-persistent data store, no
  script message handlers, no link previews. Its navigation delegate lets the page load its own URL and cancels
  everything else, so links do nothing. Pinch zoom as the page's viewport allows.
- **BlimpKit:** `ChatRole.visual` and the message's `title`, `visual` and `gone`; the page's URL from the server's
  address, the visual key and the id. The app gets the key with `GET /visuals/key` when it's online, as it gets
  the widget key.

## The Mac

- **The tab:** a new kind, `visual:<source path>`, after the galleries, with a chart icon and the title. When a
  `visual` event's `dir` is an open project's folder, that project gets the tab (or the tab it has for that
  source moves to the new copy) and it becomes that project's front tab. The window doesn't switch projects, and
  focus stays where it is: the terminal keeps your typing. A
  project that isn't open gets nothing; the phone still has the card.
- **`VisualView`:** `<iframe sandbox="allow-scripts" src="<base>/visuals/<key>/<id>">`, filling the tab. The app
  gets its key with `GET /visuals/key` when it connects.
- **The app's CSP** (`tauri.conf.json` and `index.html`, dev too) gets `frame-src http://127.0.0.1:*`. So a
  page can't take its frame to a website. It could take it to a port forwarded on 127.0.0.1, where it would still
  have no token; SECURITY.md says so.
- Closing works as for any tab. `HtmlView` for HTML files doesn't change: scripts are still removed there.

## What a page can and can't do

- Can: run its own scripts and styles, load blimp's kit, draw on canvas and SVG, use `data:` and `blob:` images.
- Can't: make any request (`connect-src 'none'`: no fetch, XHR or WebSocket), load anything from the internet,
  read the app's storage or cookies (an opaque origin, from `sandbox`), open windows, navigate the app, or leave
  its own URL (the phone's navigation delegate; the Mac's `frame-src`).
- Its URL holds the visual key, which only reads other visuals, and it can't send a request with it anyway.

## Spike first (throwaway, before the plan's tasks)

In real WebKit: an iPhone (simulator) web view and the Mac's Tauri webview (and WebKitGTK, which the native e2e
uses), with a page served by a test blimpd with these headers:

1. The kit's scripts load from `'self'` under `sandbox allow-scripts`; if not, an explicit origin does.
2. Chart.js and Mermaid both render with this CSP (no `'unsafe-eval'` needed).
3. A `fetch` to blimpd and to the internet, and `location = "https://example.com"`, all fail.
4. On the Mac: an `http://127.0.0.1` frame inside the app's page loads (the parent is `tauri://localhost`).

If any of these fails and has no fix in the server's headers, stop and report before building.

## Tests

- Server (`bun test`):
  - visuals-mcp.test.ts: the handshake, `tools/list` (the description and input schema), `tools/call` for a good
    file (the copy and the result line) and each refusal (`isError`), blimpd not running among them.
  - visuals.test.ts: the copy and its meta (mode 600), 2 MB and non-UTF-8 refused, a path outside home refused,
    the 30-day clean-up, the event's fields.
  - server.test.ts: `GET /visuals/key` for each token; the visual key reads a page and the kit and is refused on
    other routes; the page's headers exactly; 404 for an expired copy;
    a new phone token gives a new key.
  - chat.test.ts: a `show` call becomes a `visual` message with the id from the result, an errored one stays a
    hidden tool, `gone` when the copy is missing.
  - kinds.test.ts: Claude Code gets `--mcp-config` without Chrome; `mcp.json` has `blimp` always and
    `blimp-browser` only with the browser; Codex's overrides.
  - The kit's files match their pinned sums.
- Mac (Playwright against a real blimpd, `app/e2e/visuals.spec.ts`): a show opens the tab in its project and not
  in another, the terminal keeps focus; showing the same file again reuses the tab; the page draws a chart and a
  diagram; a page that fetches blimpd or the internet, or navigates away, fails; `cspViolations` finds none in
  the app.
- Phone: BlimpKit tests for the role, fields and URL. UI test `testVisualCardOpensThePage`: demo-chat's fixture
  gets a `show` call and a page under `$E2E_WORK`; the card shows, a tap opens the page and its text is there,
  Done goes back; a `gone` card is greyed.
- Checklists: PHONE-CHECKLIST.md and MAC-CHECKLIST.md get "ask Claude for a chart of something; it shows; light
  and dark; a narrow and a wide Mac window".

## Docs

- DESIGN.md: the tool, `/visuals` routes, the visual key, the copies, the event, the kit, the new tab kind.
- SECURITY.md: what a page can and can't do, the visual key, the Mac's `frame-src`.
- README.md: a short "Visuals" paragraph; ios/README.md: the card.

## Not in this change

- A preview picture on the card.
- A list of earlier visuals on the Mac, or opening one for a project that wasn't open.
- Cards for Codex sessions: they get the tool and the Mac tab, but the phone's chat reads Claude Code's
  transcripts only.
- Claude seeing a picture of its own page (the server's Chrome could take one).
- Pages made of several files (images beside the page): they go inline.
- Sharing or exporting a visual.
- Running any HTML file in the project with scripts on.
