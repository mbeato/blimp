# blimp design (milestones 2–5)

SPEC.md says what blimp does. This file says how the pieces talk, so the server, the app UI and the app shell can be built separately and still fit.

## Repo layout

```
src/            blimpd (Bun + TypeScript, compiled to one binary)
test/           blimpd tests (bun test) + install test
app/            the Mac app (Tauri v2)
  src/          UI: React + TypeScript + Vite
  src-tauri/    native shell: Rust (SSH tunnel, store, notifications)
  e2e/          Playwright tests that drive the UI against a real blimpd over SSH
docs/           this file
install.sh      server setup
.github/workflows/  CI + release
```

Package manager everywhere: bun (`bun install`, `bun run`). No npm lockfiles.

## Connection

```
app UI ──fetch/WebSocket──▶ http://127.0.0.1:<local port>
                               │  ssh -N -L 127.0.0.1:<local port>:<home>/.blimp/blimpd.sock host   (started by the Rust shell)
                               ▼
                        blimpd, listening on the unix socket ~/.blimp/blimpd.sock (mode 600, dir 700)
```

- The Rust shell runs the system `ssh` (`/usr/bin/ssh` on macOS, `ssh` on PATH elsewhere) with `-o BatchMode=yes`, so it uses the user's keys, agent and `~/.ssh/config` and never prompts.
- First it runs one command over SSH to learn the home folder and the token:
  `ssh -o BatchMode=yes [-p PORT] [USER@]HOST 'printf "%s\n" "$HOME"; cat "$HOME/.blimp/token"'`
- Then it starts the tunnel: `ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ControlMaster=no -o ControlPath=none -L 127.0.0.1:<free port>:<home>/.blimp/blimpd.sock [-p PORT] [USER@]HOST`, and waits (up to 10 s) until `GET /health` answers through it. No connection sharing: with `ControlMaster`/`ControlPersist` in `~/.ssh/config`, ssh would hand the forward to a shared master and exit, and the app could no longer close it.
- Both ssh commands get the app's PATH with `/opt/homebrew/bin` and `/usr/local/bin` added, so `ProxyCommand` and `Match exec` helpers from Homebrew are found when the app is opened from Finder.

### Token

The local port is reachable by anything on the Mac, including web pages, and WebSockets skip CORS. So every request carries a token.

- `blimpd serve` creates `<socket dir>/token` (32 random bytes, hex; mode 600) if it doesn't exist. The socket dir is `dirname(BLIMPD_SOCKET)`, default `~/.blimp`.
- HTTP: `Authorization: Bearer <token>`. WebSocket: `?token=<token>` (browsers can't set headers on a WebSocket).
- Wrong or missing token → 401. Compare in constant time.
- CORS: every response has `Access-Control-Allow-Origin: *`. `OPTIONS` returns 204 with `Access-Control-Allow-Headers: Authorization, Content-Type` and `Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS`. (`*` is safe because the token is not a cookie.)

## blimpd API

All paths are absolute server paths. Errors are `{ "error": "<plain message>" }` with a 4xx/5xx status. JSON in, JSON out, except file bodies.

### Sessions

`GET /health` → `{ "version": "0.2.0", "home": "/home/u" }`

`GET /sessions` → `Session[]`, oldest first:

```ts
type Session = {
  name: string;          // zmx session name
  pid: number;
  clients: number;       // attached zmx clients
  created: number;       // unix seconds
  dir: string;           // real path Claude runs in
  cmd: string;
  sessionId?: string;    // Claude's conversation id
  title: string;         // /rename title, else AI title, else first prompt, else "(new session)"
  status: string;        // raw Claude status: busy | idle | waiting | shell | ""
  waitingFor?: string;   // raw Claude field
  updatedAt?: number;    // ms, last activity
  state: "working" | "waiting" | "done" | "unknown";
  stateSince?: number;   // ms
};
```

`state` comes from whichever source is newer:
- Claude's status file (`statusUpdatedAt ?? updatedAt`): `waiting` or a non-empty `waitingFor` → waiting; `busy` or `shell` → working; `idle` → done.
- blimp's hook file `<socket dir>/status/<zmx name>.json` (`at`), so `~/.blimp/status/` by default and next to the temp socket for a test blimpd: see Hooks.
- Neither → `unknown`.

`POST /sessions` body `{ "dir": string, "name"?: string, "resume"?: string }` → 201 `{ "name": string }`.
`resume` is a Claude conversation id (must match `/^[0-9a-f-]{36}$/`); the session runs `claude --resume <id>`. `dir` must be inside the home folder (see Files).

`GET /folders/recent` → `[{ "dir": string, "lastUsed": number /* ms */ }]`, newest first, max 30, only folders that still exist. Source: each `<claude dir>/projects/*/` folder, its newest `*.jsonl`, the first `"cwd"` found in its first 50 lines.

`GET /conversations?dir=<dir>` → `[{ "sessionId": string, "title": string, "updatedAt": number /* ms, file mtime */ }]`, newest first, max 50. The same list `/resume` shows in that folder: transcripts in `<claude dir>/projects/<dir with every non-alphanumeric char replaced by "-">/*.jsonl`.

### Terminal

`GET /sessions/<name>/attach?token=…&cols=<n>&rows=<n>` upgrades to a WebSocket.

- 404 before upgrading if no zmx session has that name (`zmx attach` would otherwise create one).
- blimpd runs `zmx attach <name>` in a PTY (`Bun.spawn` with the `terminal` option) of `cols`×`rows`, env = blimpd's env minus `ZMX_SESSION`, plus `TERM=xterm-256color`, `COLORTERM=truecolor`.
- Server → client: binary frames, raw PTY output.
- Client → server: binary frames = keyboard input bytes; text frames = JSON control messages. Only one for now: `{ "type": "resize", "cols": n, "rows": n }`.
- When the socket closes, blimpd kills that zmx client (SIGTERM). The session keeps running.
- When the zmx client exits (session ended, or the user detached with ctrl+\), blimpd closes the socket with code 4000, reason `"ended"`.
- Several sockets on one session are fine: each gets its own zmx client. zmx keeps them in sync.

### Events

`GET /events?token=…` upgrades to a WebSocket. Server → client text frames:

- `{ "type": "sessions", "sessions": Session[] }`: sent on connect, then whenever the list changes. blimpd checks every 1 s. (A session that starts waiting must show in the app within 5 s.)
- `{ "type": "fs", "paths": string[] }`: watched paths that changed (debounced 150 ms).

Client → server: `{ "type": "watch", "paths": string[] }` replaces this socket's watch set. Each path is watched non-recursively (a folder: its direct entries; a file: its content). The app sends the expanded folders of the tree plus the open files. Paths outside home are ignored.

### Files

Every path must resolve, after following symlinks, to the home folder or something inside it. For a path that doesn't exist yet, its parent folder must. Otherwise 403.

`GET /fs/list?path=<dir>` → `{ "path": string, "entries": [{ "name": string, "kind": "file" | "dir", "size": number, "mtime": number /* ms */ }] }`, folders first, then by name. Symlinks are reported as what they point to; broken links are skipped.

`GET /fs/file?path=<file>` → the raw bytes. Headers: `Content-Type` from the extension (`application/octet-stream` if unknown), `X-Blimp-Mtime: <ms>`, plus CORS `Access-Control-Expose-Headers: X-Blimp-Mtime`. Over 50 MB → 413.

`PUT /fs/file?path=<file>&baseMtime=<ms>` body = raw bytes → `{ "mtime": number }`.
- If `baseMtime` is given and the file's mtime differs → 409 `{ "error": "changed on the server", "mtime": number }`. Without `baseMtime` it overwrites (the app's "keep mine" path).
- Writes go to a temp file in the same folder, then rename, keeping the original file's mode.

`GET /fs/files?root=<dir>` → `{ "files": string[] /* relative to root */, "truncated": boolean }` for ⌘P. Inside a git repo: `git ls-files --cached --others --exclude-standard`. Otherwise walk, skipping `.git`, `node_modules` and dot-folders. Max 20 000.

### Hooks (status backup)

Claude's status files are internal and may change. So blimpd also installs Claude Code hooks that record status itself.

- `blimpd install-hooks` merges into `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`, for each of `Notification`, `Stop`, `UserPromptSubmit`, `PostToolUse`: `{ "hooks": [{ "type": "command", "command": "'<absolute path of this blimpd>' hook", "timeout": 5 }] }`. It skips an event that already has a command containing `blimpd' hook` or `blimpd hook`. It keeps every other key and hook as they were, writes a one-time backup `settings.json.blimp-backup` before the first change, and writes atomically. Running it twice changes nothing. `install.sh` runs it.
- `blimpd hook` reads the hook JSON on stdin. If `ZMX_SESSION` is set (Claude runs inside zmx, which sets it), it writes `<socket dir>/status/<ZMX_SESSION>.json` (the socket dir comes from `BLIMPD_SOCKET`, which Claude inherits from the session): `{ "state": "waiting" | "working" | "done", "at": <ms>, "sessionId": <session_id>, "event": <hook_event_name> }`. Notification with `notification_type` `permission_prompt`, `elicitation_dialog` or `elicitation_url_dialog` → waiting (other notifications, like `idle_prompt` about 60 s after a finished turn, are ignored); UserPromptSubmit, PostToolUse → working; Stop → done. It always exits 0 quickly and prints nothing.

### Performance

`GET /sessions` and the 1 s event check run often. Cache transcript titles per file and parse only bytes appended since the last read (keep the byte offset and the custom/ai/prompt state). Don't re-read whole transcripts every second.

## The app

### Rust shell (`app/src-tauri`)

Commands for the UI (`invoke`):

- `connect({ host: string, user?: string, port?: number }) → { id: string, port: number, token: string, home: string }`. `id` is `user@host:port`. Reuses a live tunnel for the same id. Errors are plain sentences (for example "SSH to claude1 failed: Permission denied (publickey)").
- `disconnect({ id: string })`.
- Event `tunnel-closed` with `{ id }` when an ssh child exits. The UI reconnects with backoff (1, 2, 5, 10 s, then every 10 s).

All ssh children are killed when the app exits. Plugins: `notification`, `store` (server list in `servers.json`). macOS: default app menu, which gives ⌘C/⌘V/⌘A/⌘Q. Window 1400×900, min 900×600, title "blimp". Bundle id `dev.blimp.app`.

### UI (`app/src`)

React + TypeScript + Vite. Libraries: `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-web-links` + `@xterm/addon-webgl`, `monaco-editor` (bundled locally, workers via Vite, no CDN), `marked` + `dompurify`, `pdfjs-dist` (worker bundled locally), `@tauri-apps/api`, `@tauri-apps/plugin-notification`, `@tauri-apps/plugin-store`.

**Outside Tauri** (browser, for development and the e2e tests): `src/lib/connection.ts` reads `?blimpd=http://127.0.0.1:PORT&token=T` from the page URL instead of calling `connect`, keeps the server list in localStorage, and uses the web Notification API. Everything else is the same code.

**Layout**: one window, three panes.

1. **Sidebar (left, 280 px, resizable).**
   - One section per server (header hidden when there's only one). "Add server" (host, optional user and port) at the bottom.
   - "Waiting for you" group at the top: every session with state `waiting`, each with an accent dot.
   - Then one group per folder (`~/x` display), sessions newest first. The group header has a "+" that starts a session in that folder.
   - Row: title (one line, ellipsis), state (working / waiting / done), last activity ("2m ago", refreshed every 30 s), folder shown in the group header only.
   - Click a row: opens its terminal tab, or focuses it if open.
2. **Terminal (center).** Tabs of open sessions. ⌘1–9 picks a tab, ⌘W closes the tab (the session keeps running). Each tab is an xterm.js terminal on `/sessions/<name>/attach`, fitted to its container, resize sent on fit. Font: 13 px, `"SF Mono", Menlo, monospace`. Keys like the VS Code terminal on macOS: ⌘C copies the selection (if any), ⌘V pastes, ⌘K is not sent to the terminal (it's the jump palette), ⌘Backspace sends `\x15`, ⌥Backspace sends `\x17`, ⌘← sends `\x01`, ⌘→ sends `\x05`, ⌥← / ⌥→ send `\x1bb` / `\x1bf`. On close code 4000 the tab shows "Session ended". On other drops it reconnects.
3. **Files (right, collapsible with ⌘B, default open, 45 % of width, resizable).** Opens at the active tab's session folder.
   - A tree column (folders expandable, `.git` hidden) beside a viewer/editor area with its own tabs of open files.
   - ⌘P: fuzzy open by name over `/fs/files` of the session folder.
   - Text/code: Monaco, language from the extension, theme follows the app. ⌘S saves with `baseMtime`. On 409, or when an `fs` event says an open file changed and it has unsaved edits: a bar "Changed on the server: Reload / Keep mine". Keep mine saves without `baseMtime`. With no unsaved edits it reloads silently.
   - Markdown: rendered (marked + DOMPurify) with an Edit toggle that switches to Monaco.
   - Images (png, jpg, jpeg, gif, webp, svg, ico, bmp): shown fitted. SVG goes through an `<img>` from a blob URL, never inline.
   - PDF: pdf.js, all pages, scrollable.
   - Anything else binary (NUL byte in the first 8 KB): "Can't show this file", plus its size.
   - The tree and open files update from `fs` events.

**Shortcuts**: ⌘N new session in the active tab's folder. ⌘⇧N "New session in…" dialog: recent folders (`/folders/recent`), a browse view (`/fs/list`), or a typed path; after choosing a folder, "New conversation" or one of `/conversations?dir=` to resume. ⌘K jump palette: fuzzy over every session's title, folder and name across servers; Enter opens it. ⌘P quick open. ⌘B toggle files. ⌘1–9, ⌘W as above. Esc closes dialogs.

**Waiting**: when a session's state becomes `waiting` (not on first load), send a notification "<title> is waiting for you" (body: the folder), unless the window is focused and that session's tab is active. Dock badge = number of waiting sessions (`getCurrentWindow().setBadgeCount(n || undefined)`), only in Tauri.

**Look**: native-feeling Mac app, not a web page. Dark by default (follows system light/dark), compact type (13 px UI, system font), subtle 1 px dividers, no heavy shadows or gradients. Accent for "waiting" only. Colors as CSS variables in one file.

## Tests and checks per milestone

- Unit: `bun test` in the repo root (blimpd) and `bun test` in `app/` (UI logic: fuzzy match, grouping/sorting, key mapping, state transitions → notifications).
- E2E (`app/e2e`, Playwright, Chromium): starts a test blimpd on a temp socket, an `ssh -N -L` tunnel to localhost (the same thing the Rust shell does), the Vite dev server, and drives the UI. zmx sessions made by tests are named `blimpe2e-*` and killed after.
  - M2: open a session in blimp and attach a second zmx client from a PTY; text typed in either shows in both.
  - M3: a session goes to waiting (hook file or a real Claude asking a question) → the row shows waiting within 5 s and the notification function is called.
  - M4: edit and save a file in blimp → `git diff` shows it. Change an open, edited file on the server → the reload bar appears.
- Rust: `cargo clippy` and a Linux `tauri build` here; a macOS build on GitHub Actions (`macos-latest`), uploaded as an artifact.
- Things only a Mac can check (notification banner, Dock badge, keyboard feel) go in a checklist for Max.
