# Server browser, step 1 (Claude can browse) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sessions blimp starts can drive a Chrome on the server (open pages, read source, network,
console) through Google's Chrome DevTools MCP. Each session sees only its folder's tabs. The app
lists a folder's server tabs.

**Architecture:**
- blimpd starts Chrome lazily over `--remote-debugging-pipe`.
- A gate on `127.0.0.1:<port>` admits only blimpd's own uid. It gives each WebSocket client
  (`/s/<session>`) a virtual browser holding only that session's folder's page targets. This is the
  spike's design (`docs/superpowers/spikes/2026-10-20-cdp-gate.ts`) with its fixes.
- Sessions get the MCP through one static config that runs `blimpd browser-mcp`. That command
  reads `ZMX_SESSION` and the gate port, then runs `npx chrome-devtools-mcp`.
- Tabs persist in `~/.blimp/browser/tabs.json` and reopen when Chrome starts.

**Tech Stack:** Bun (blimpd, no npm deps), Chrome DevTools Protocol over a pipe,
`chrome-devtools-mcp@1.11.0` (run by npx), React app (existing).

**Spec:** `docs/superpowers/specs/2026-10-20-server-browser-design.md` (read "Spike first",
"Result").

## Global Constraints

- blimpd has no npm dependencies. Use Bun and node built-ins only.
- **Chrome flags:**
  - Always `--headless=new --remote-debugging-pipe --password-store=basic --no-first-run`,
    `--user-data-dir=<blimpDir>/browser/profile` (0700), and
    `--disable-blink-features=AutomationControlled`.
  - Also `--user-agent=<Chrome UA without "Headless">`.
  - Never `--enable-automation`.
- The gate listens on `127.0.0.1` only and admits a connection only if `/proc/net/tcp(6)` says the
  peer socket's uid is `process.getuid()`.
- No secrets in argv.
- MCP pinned: `chrome-devtools-mcp@1.11.0` with `--no-usage-statistics --no-performance-crux`.
- Comments and docs follow the repo's style: plain English, short sentences.
- Tests: `bun test` (root) for blimpd and `bun test src` (app). Browser-dependent tests skip with
  a message when no Chrome is found, never fail.

## File Structure

- `src/browser/chrome.ts`:
  - `findChrome()`, `userAgentFor(version)`, `chromeArgs(dir, ua)`
  - `launchChrome(path, dir) → Chrome`: pipe framing (`send`, `onMessage`, `exited`, `kill`).
- `src/browser/gate.ts`: `Gate`, the folder-scoped CDP multiplexer over a `Chrome`.
  - `connect(client)`, `tabs()`, `createTab(folder, url, openedBy?)`, `closeTab(id)`,
    `onChange`.
- `src/browser/peer.ts`: `tcpOwner(lines, address, port) → uid | null` and
  `peerUid(address, port)`.
- `src/browser/service.ts`: the browser service.
  - It holds the Chrome lifecycle (lazy start, restart on exit) and the `Gate`.
  - It runs the TCP listener, writes the port file and `mcp.json`, and persists `tabs.json`.
  - API: `browserTabs()`, `openTab()`, `closeTab()`, `onBrowserChange()`, `startBrowserGate()`.
- `src/browser/mcp.ts`: `mcpConfig(self)`, `runBrowserMcp()` (the `blimpd browser-mcp`
  subcommand), `selfCommand()`.
- Modify `src/kinds.ts`: add `npx` to `LOOK_FOR`. `launchFor` adds the MCP for claude,
  claude-glm and codex when `browserAvailable(have)`.
- Modify `src/server.ts`: `/browser/tabs` routes; start the gate in `serve()`.
- Modify `src/events.ts`: send `{type:"browser", tabs}` on open and on change.
- Modify `src/main.ts`: `browser-mcp` and `browser` (status) commands.
- App: `app/src/lib/api.ts` (`BrowserTab`), `app/src/lib/events.ts` (`onBrowser`),
  `app/src/lib/connection.ts` (`browserTabs`), `app/src/components/TerminalPane.tsx` (Browser
  section), `app/src/components/Workbench.tsx` (open a listed tab in a blimp tab).
- Docs: `docs/DESIGN.md`, `docs/SECURITY.md`, `README.md`.

---

### Task 1: Chrome launcher (find, flags, pipe)

**Files:** Create `src/browser/chrome.ts`, `test/browser-chrome.test.ts`

**Interfaces (produces):**
```ts
export type CdpMessage = { id?: number; method?: string; params?: any; result?: any; error?: any; sessionId?: string };
export function findChrome(home?: string, which?: (n: string) => string | null): string | null; // google-chrome, chromium, chromium-browser, then ~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome (newest)
export function userAgentFor(versionOutput: string): string; // "Chromium 156.0.8078.4" → "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"
export function chromeArgs(profileDir: string, ua: string): string[];
export type Chrome = { send(m: CdpMessage): void; onMessage(f: (m: CdpMessage) => void): void; call(method: string, params?: any, sessionId?: string): Promise<CdpMessage>; exited: Promise<number | null>; kill(): void };
export function launchChrome(path: string, profileDir: string): Chrome; // spawns with stdio [ignore, ignore, ignore, pipe, pipe]; NUL-framed JSON; ids for call() from 1e9 up so the gate's ids never collide
```

- [ ] **Step 1: Write the tests.**
  - `userAgentFor` on "Chromium 156.0.8078.4", "Google Chrome 141.0.7390.54 " and garbage: falls
    back to `Chrome/140.0.0.0`.
  - `chromeArgs` contains each flag in Global Constraints, and not `--enable-automation`.
  - `findChrome` with a fake `which` and a temp home holding
    `.cache/ms-playwright/chromium-1200/chrome-linux64/chrome` and `chromium-1248/...`: picks the
    PATH one first, else the newest Playwright one, else null.
  - **Live (skips without Chrome):**
    - launch with a temp profile; `Browser.getVersion` answers;
    - `Target.createTarget` + attach + `Page.enable` + `Page.navigate` to a local `Bun.serve` page
      reaches `Page.loadEventFired` within 5 s (the keyring regression);
    - `Runtime.evaluate("navigator.userAgent")` has no "Headless", and `navigator.webdriver` is
      false.
- [ ] **Step 2:** `bun test test/browser-chrome.test.ts`: fails (module missing).
- [ ] **Step 3:** Implement. The spike's spawn and framing code, as a module.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit "Server browser: find and launch Chrome over a pipe".

### Task 2: Peer uid check

**Files:** Create `src/browser/peer.ts`, `test/browser-peer.test.ts`

**Interfaces (produces):**
```ts
export function tcpOwner(table: string, address: string, port: number): number | null; // table: /proc/net/tcp or tcp6 text; finds the row whose LOCAL address:port is the peer's; returns its uid column
export function peerUid(address: string, port: number): number | null; // reads /proc/net/tcp and tcp6
```

- [ ] **Step 1: Write the tests.**
  - Fixture lines (v4 `0100007F:D431`, v6 `00000000000000000000FFFF0100007F:D431` for
    `::ffff:127.0.0.1`, and `00000000000000000000000001000000` for `::1`). `tcpOwner` returns the
    uid for a matching local port, and null otherwise.
  - Live: `Bun.listen` on 127.0.0.1:0, `Bun.connect` to it, and
    `peerUid("127.0.0.1", clientLocalPort) === process.getuid()`.
- [ ] **Step 2:** Run: fails.
- [ ] **Step 3:** Implement. Hex little-endian per 32-bit word for addresses; the port is
  big-endian hex. Map `::ffff:a.b.c.d` to the v4 table and to the mapped v6 row.
- [ ] **Step 4:** Pass. **Step 5:** Commit "Server browser: who owns a local TCP connection".

### Task 3: The gate

**Files:** Create `src/browser/gate.ts`, `test/browser-gate.test.ts`

**Interfaces:**
- Consumes: `Chrome` (Task 1).
- Produces:
```ts
export type Tab = { id: string; folder: string; url: string; title: string; openedBy?: string };
export type GateClient = { folder: string; session?: string; send(text: string): void };
export class Gate {
  constructor(chrome: Chrome);
  ready(): Promise<void>;                              // Target.setDiscoverTargets done
  connect(c: GateClient): { message(text: string): void; close(): void };
  tabs(): Tab[];                                       // page targets with a folder
  createTab(folder: string, url: string, openedBy?: string): Promise<string>; // targetId
  closeTab(id: string): Promise<void>;
  onChange(f: () => void): void;                        // a tab opened, closed, retitled or navigated
}
```

The behavior is the spike's (`docs/superpowers/spikes/2026-10-20-cdp-gate.ts`) plus the ordering
fixes in the spec's "Result":
- discover: existing `targetCreated` events, then the reply;
- autoAttach: attached to existing targets, then the reply;
- `createTarget`: announce once both Chrome's `targetCreated` and the reply are in;
- popups: inherit the opener's folder and `openedBy`;
- `Browser.close`: answered `{}` and never forwarded;
- a closing client detaches its sessions.

- [ ] **Step 1: Write the tests** (live; skip without Chrome). Raw CDP WebSocket-less clients via
  `connect()` with a JSON `send` collector. The cases:
  - A creates a target (url `about:blank`): A gets `targetCreated` and, with autoAttach,
    `attachedToTarget`; B (another folder) gets neither, and `Target.getTargets` for B is empty.
  - A2 (same folder, connects later) gets A's target in `setDiscoverTargets` before its reply.
  - B attaching to A's targetId: error "No target with given id found".
  - A sends a session command for its session: the answer comes back with A's own id.
  - `window.open` from A's page: the popup is in A's folder (`tabs()`).
  - `createTab("/f", url, "s1")` shows in `tabs()` with `openedBy: "s1"`; `closeTab` removes it;
    `onChange` fires for both.
  - `Browser.close` from a client: reply `{}`, Chrome still answers `Browser.getVersion`.
- [ ] **Step 2:** Run: fails.
- [ ] **Step 3:** Implement from the spike, ported to the `Chrome` interface (ids from the gate's
  own counter; `Chrome.call` ids are separate).
- [ ] **Step 4:** Pass. **Step 5:** Commit "Server browser: a CDP gate that shows each folder only its own tabs".

### Task 4: Browser service (lifecycle, listener, persistence) and MCP wiring

**Files:**
- Create `src/browser/service.ts`, `src/browser/mcp.ts`, `test/browser-service.test.ts`
- Modify `src/kinds.ts`, `src/main.ts`, `test/kinds.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3, `blimpDir()`, `parseZmxList`, `zmxListAsync` (sessions.ts).
- Produces:
```ts
// service.ts
export function browserAvailable(): boolean;                   // findChrome() !== null (cached 30 s)
export function startBrowserGate(): Promise<number>;            // listens on 127.0.0.1:0, writes <blimpDir>/browser/port (0600) and mcp.json; returns the port
export function stopBrowser(): void;
export function browserTabs(): Tab[];                           // live tabs, or the saved ones while Chrome isn't running
export function openTab(folder: string, url: string): Promise<string>;
export function closeTab(id: string): Promise<void>;
export function onBrowserChange(f: (tabs: Tab[]) => void): void;
// mcp.ts
export function selfCommand(): string[];                        // compiled: [process.execPath]; dev: [process.execPath, Bun.main]
export function mcpConfig(self: string[]): string;               // {"mcpServers":{"blimp-browser":{"command":self[0],"args":[...self.slice(1),"browser-mcp"]}}}
export function mcpConfigPath(): string;                         // <blimpDir>/browser/mcp.json
export function runBrowserMcp(): Promise<number>;                // reads ZMX_SESSION and the port file; runs npx -y chrome-devtools-mcp@1.11.0 --wsEndpoint ws://127.0.0.1:<port>/s/<session> --no-usage-statistics --no-performance-crux; stdio inherited; exits with its code
```

Service behavior:
- **Listener.** `Bun.serve` on `127.0.0.1:0`.
  - Upgrade `/s/<session>` only if `peerUid(server.requestIP(req))` is our uid (else 403).
  - Look up the session's dir in `parseZmxList(await zmxListAsync())`; unknown session → 404.
  - On open: `ensureChrome()`, then `gate.connect({ folder: realDir, session, send: ws.send })`.
- **`ensureChrome()`.** Launch once, then `gate.ready()`, then reopen `tabs.json` entries with
  `createTab`. On `exited`: close all gate WebSockets (code 1012), then mark Chrome down. The next
  need starts it again, which reopens the tabs.
- **Persistence.** `tabs.json`: `[{folder, url, openedBy?}]`, written (debounced 500 ms) on gate
  change.

kinds.ts:
- `LOOK_FOR = ["claude", "codex", "npx"]`.
- In `launchFor`, `const mcp = have.has("npx") && browserAvailable()`.
  - Claude and claude-glm args become `["claude", ...(mcp ? ["--mcp-config", mcpConfigPath()] : []), ...resumeArgs]`.
  - Codex becomes `["codex", ...(mcp ? ["-c", 'mcp_servers.blimp-browser.command="<self0>"', "-c", "mcp_servers.blimp-browser.args=[...]"] : [])]`, using TOML strings via `JSON.stringify`.

main.ts:
- `browser-mcp` → `process.exit(await runBrowserMcp())`.
- `browser` → print the Chrome found (or "no Chrome or Chromium found; install one: npx playwright install chromium").

- [ ] **Step 1: Write the tests.**
  - `mcpConfig(["/x/blimpd"])` and the dev form.
  - kinds: `launchFor("claude")` with `npx` in a fake installed set and a stubbed
    `browserAvailable` → args include `--mcp-config`; without `npx`, they don't. Follow
    kinds.test.ts's existing seams; if `installed` can't be stubbed, add a parameter like the
    existing `file` and `home` ones.
  - **Service, live (skip without Chrome):**
    - `startBrowserGate()` returns a port, and the port file says it;
    - a WebSocket to `/s/<unknown>` → closed or 404;
    - with a real zmx session (`blimptest-*`, as server.test.ts makes them), a WebSocket to
      `/s/<that session>` speaks CDP, `Target.createTarget`, and the tab shows in `browserTabs()`
      with the session's folder and `openedBy`;
    - `tabs.json` has it;
    - kill Chrome: the tab comes back after the next `openTab`, with the same url.
  - **MCP end to end (skip without Chrome or npx):** run the MCP directly with
    `--wsEndpoint ws://127.0.0.1:<port>/s/<session>` (as `runBrowserMcp` would), then `new_page`
    a local page, `list_network_requests`, and `evaluate_script` for the source.
- [ ] **Step 2:** Run: fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Pass, and run the full `bun test` (server suite) for regressions.
- [ ] **Step 5:** Commit "Server browser: blimpd keeps Chrome, gives sessions the DevTools MCP".

### Task 5: API and events

**Files:** Modify `src/server.ts`, `src/events.ts`, `test/server.test.ts`

- `GET /browser/tabs?dir=` → `browserTabs()` filtered to `guard(dir)` (all tabs without `dir`).
- `POST /browser/tabs {dir, url}` → `{id}` 201. The url must be http(s), else 400.
- `DELETE /browser/tabs/<id>` → 204, or 404 if unknown.
- `serve()` calls `startBrowserGate()`; if it fails, log a line and go on.
- `openEvents` also sends `{type:"browser", tabs}`; `onBrowserChange` publishes that message on
  the "sessions" topic.

- [ ] **Step 1:** Tests in server.test.ts (skip the Chrome parts without Chrome):
  - token required;
  - POST then GET shows the tab for that dir and not for another dir;
  - the events socket gets a `browser` message with it;
  - DELETE removes it;
  - a bad url → 400.
- [ ] **Step 2:** Fail. **Step 3:** Implement. **Step 4:** Pass.
- [ ] **Step 5:** Commit "Server browser: tabs over the API and the events socket".

### Task 6: The app lists a folder's server tabs

**Files:**
- Modify `app/src/lib/api.ts`, `app/src/lib/events.ts`, `app/src/lib/connection.ts`,
  `app/src/components/TerminalPane.tsx`, `app/src/components/Workbench.tsx`
- Test: `app/src/lib/browser.test.ts`
- Docs: `docs/DESIGN.md`, `docs/SECURITY.md`, `README.md`

- `BrowserTab = { id; folder; url; title; openedBy? }`. `EventsSocket` handles
  `type:"browser"` → `onBrowser(tabs)`. `ServerLink.browserTabs`.
- **TerminalPane**, under Ports: a "Browser" label and one row per tab of this folder.
  - Each row: title (else host), host on the right, and a ● mark if `openedBy`.
  - Click → `props.onOpenTab(url)`.
- **Workbench `onOpenTab(url)`:**
  - `http://localhost:<n>` or `127.0.0.1:<n>` opens as a port tab (`openPage({port, host})`);
  - anything else opens `newPage(url)`.
  - Pure helper in `lib/browser.ts`: `serverTabTarget(url) → { port: number } | { url: string }`,
    unit-tested.
- Docs:
  - DESIGN: browser service, gate, API, events, kinds wiring.
  - SECURITY: the gate (loopback, uid check, no Browser.close, folder scoping isn't a
    boundary).
  - README: "Browser for sessions" (needs Chromium + npx on the server).

- [ ] **Step 1:** Unit test `serverTabTarget`. **Step 2:** Fail. **Step 3:** Implement the
  helper, then the UI, then typecheck (`npx tsc --noEmit -p .`).
- [ ] **Step 4:** `bun test src`, then the e2e ports and browser specs.
- [ ] **Step 5:** Commit "Server browser: the app lists a folder's server tabs".

## Self-review notes

- Spec step 1 coverage:
  - Chrome lifecycle (T1, T4), gate (T2, T3, T4), wiring (T4), tab list API (T5), app list (T6),
    docs (T6).
  - Crash restart, with tabs reopened (T4).
  - "Sessions already running get it at next start" holds by construction (only `launchFor`
    adds it).
- Not in step 1 (by spec): the live view, removing the Mac views, ports opening server tabs.
