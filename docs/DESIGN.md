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
                               │  ssh -T -L 127.0.0.1:<local port>:<home>/.blimp/blimpd.sock host 'cat >/dev/null'   (started by the Rust shell)
                               ▼
                        blimpd, listening on the unix socket ~/.blimp/blimpd.sock (mode 600, dir 700)
```

- The Rust shell runs the system `ssh` (`/usr/bin/ssh` on macOS, `ssh` on PATH elsewhere) with `-o BatchMode=yes`, so it uses the user's keys, agent and `~/.ssh/config` and never prompts.
- First it runs one command over SSH to learn the home folder and the token:
  `ssh -o BatchMode=yes [-p PORT] [USER@]HOST 'printf "%s\n" "$HOME"; cat "$HOME/.blimp/token"'`
- Both ssh calls also get `-o ConnectTimeout=10`, and `--` before the destination. A host or user that is empty, starts with `-`, or contains whitespace or control characters is refused before ssh runs.
- Then it starts the tunnel: `ssh -T -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ControlMaster=no -o ControlPath=none -L 127.0.0.1:<free port>:<home>/.blimp/blimpd.sock [-p PORT] [USER@]HOST 'cat >/dev/null'`, and waits (up to 10 s) until `GET /health` answers through it. No connection sharing: with `ControlMaster`/`ControlPersist` in `~/.ssh/config`, ssh would hand the forward to a shared master and exit, and the app could no longer close it.
- The tunnel's stdin is a pipe the app holds and never writes, and the remote command `cat >/dev/null` (instead of `-N`) runs until that pipe closes. However the app ends (quit, `kill`, force quit, crash), the OS closes the pipe, `cat` exits, and ssh ends once the webview's connections through it are gone. With `-N`, ssh outlived any exit that skipped the app's own cleanup.
- Both ssh commands get the app's PATH with `/opt/homebrew/bin` and `/usr/local/bin` added, so `ProxyCommand` and `Match exec` helpers from Homebrew are found when the app is opened from Finder.

### Token

The local port is reachable by anything on the Mac, including web pages, and WebSockets skip CORS. So every request carries a token.

- `blimpd serve` creates `<socket dir>/token` (32 random bytes, hex; mode 600) if it doesn't exist. The socket dir is `dirname(BLIMPD_SOCKET)`, default `~/.blimp`.
- HTTP: `Authorization: Bearer <token>`. WebSocket: `?token=<token>` (browsers can't set headers on a WebSocket).
- Wrong or missing token → 401. Compare in constant time.
- CORS: every authorized response and the `OPTIONS` preflight have `Access-Control-Allow-Origin: *`. A 401 has none, so a web page can't read it to learn the port is blimp. `OPTIONS` returns 204 with `Access-Control-Allow-Headers: Authorization, Content-Type` and `Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS`. (`*` is safe because the token is not a cookie.)

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
  kind: string;          // the kind it was started with (see Kinds); else claude if Claude's status file was found or cmd mentions claude, else shell
  label?: string;        // short label for kinds other than claude and shell: GLM, Codex, Codex sign-in, a custom kind's label
  sessionId?: string;    // Claude's conversation id
  title: string;         // /rename title, else AI title, else first prompt, else "(new session)"
  status: string;        // raw Claude status: busy | idle | waiting | shell | ""
  waitingFor?: string;   // raw Claude field
  updatedAt?: number;    // ms, last activity
  state: "working" | "waiting" | "done" | "unknown";
  stateSince?: number;   // ms
  prompt?: Prompt & { at: number };  // while waiting: what Claude asks, and when the wait started (see Chat)
};
```

`state` comes from whichever source is newer:
- Claude's status file (`statusUpdatedAt ?? updatedAt`): `waiting` or a non-empty `waitingFor` → waiting; `busy` or `shell` → working; `idle` → done.
- blimp's hook file `<socket dir>/status/<zmx name>.json` (`at`), so `~/.blimp/status/` by default and next to the temp socket for a test blimpd: see Hooks.
- Neither → `unknown`.

`POST /sessions` body `{ "dir": string, "name"?: string, "resume"?: string, "kind"?: string, "shell"?: boolean }` → 201 `{ "name": string }`.
`kind` is a kind's id (default `claude`; 400 for an unknown one or one that isn't available), or `codex-login` (Settings' Codex sign-in: `codex login --device-auth`, not listed in `/kinds`). `shell: true` means `kind: "shell"` (what older apps send). `resume` is a Claude conversation id (must match `/^[0-9a-f-]{36}$/`); the session runs `claude --resume <id>`; only `claude` and `claude-glm` take it. `dir` must be inside the home folder (see Files). The kind is remembered in `<socket dir>/session-kinds.json` (zmx name → kind; entries for sessions no longer listed are dropped at the next start) and reported as `Session.kind`.

### Kinds

`GET /kinds` → `[{ "id": string, "label": string, "available": boolean, "note"?: string }]`, in this order:

| id | label | available when | runs (`$SHELL -l -i -c <script> …`, arguments as `"$@"`) |
|---|---|---|---|
| `claude` | Claude Code | `claude` is found | `exec claude "$@"` |
| `claude-glm` | Claude Code on GLM | `~/.config/zai/key` isn't empty (and `claude` is found) | `export ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic ANTHROPIC_MODEL=… ANTHROPIC_DEFAULT_OPUS_MODEL=… ANTHROPIC_DEFAULT_SONNET_MODEL=… CLAUDE_CODE_SUBAGENT_MODEL=…` (GLM-5.3) `ANTHROPIC_DEFAULT_HAIKU_MODEL=…` (GLM-5.3-Flash) `API_TIMEOUT_MS=3000000; export ANTHROPIC_AUTH_TOKEN="$BLIMP_ZAI_TOKEN"; unset BLIMP_ZAI_TOKEN ANTHROPIC_API_KEY; exec claude "$@"` (models from `glm.model` / `glm.fast` in kinds.json if set, quoted). These are set in the script, after the login profile has run, so a profile's own Anthropic settings can't send the key elsewhere. The key is read from the file at start and comes in the environment as `BLIMP_ZAI_TOKEN`, never on a command line. |
| `codex` | Codex | `codex` is found | `exec codex "$@"` |
| custom | its label | its `command`'s first word is found | `exec "$@"` with its `command`, and its `env` added |
| `shell` | Shell | always | `$SHELL -l -i` |

"Found" means `command -v` finds it in the login shell, run as sessions run it (`$SHELL -l -i -c`, one shell for all names, cached 30 s), since nvm and `~/.local/bin` often join PATH only there (and Debian's `.bashrc` stops early in a shell that isn't interactive). A lookup that finds nothing (a profile that hung or failed) isn't cached, and `claude` is then started anyway, as before kinds. `note` says why one can't start ("Add a Z.ai key in Settings", "codex isn't installed") or, for Codex, "signed in" / "not signed in" (whether `${CODEX_HOME:-~/.codex}/auth.json` exists).

Custom kinds: `<socket dir>/kinds.json` = `{ "kinds": [{ "id", "label", "command": string[], "env"?: { [name]: string } }], "glm"?: { "model"?, "fast"? } }`. An id is `[A-Za-z0-9_-]{1,40}` and can't be a built-in one (`claude`, `claude-glm`, `codex`, `shell`, `codex-login`). A file that's there but wrong is ignored as a whole, and `/kinds` lists `{ "id": "kinds.json", "label": "Your kinds", "available": false, "note": "~/.blimp/kinds.json is ignored: <why>" }` where its kinds would be.

### Keys

`PUT /keys/zai` body `{ "key": string }` → 204. The key is 10–500 printable ASCII characters, no whitespace (else 400). It's written to `~/.config/zai/key` (folder 700, file 600) through a temp file and a rename. `DELETE /keys/zai` → 204, removes it. `GET /keys` → `{ "zai": boolean }`. No route returns a key.

`DELETE /sessions/<name>` → 204: `zmx kill <name>`, then waits (up to 3 s) until zmx no longer lists it. 404 if there's no such session. Attached clients see close code 4000. Claude's conversation stays on disk, so it can be resumed.

`GET /folders/recent` → `[{ "dir": string, "lastUsed": number /* ms */ }]`, newest first, max 30, only folders that still exist. Source: each `<claude dir>/projects/*/` folder, its newest `*.jsonl`, the first `"cwd"` found in its first 50 lines.

`GET /conversations?dir=<dir>` → `[{ "sessionId": string, "title": string, "updatedAt": number /* ms, file mtime */ }]`, newest first, max 50. The same list `/resume` shows in that folder: transcripts in `<claude dir>/projects/<dir with every non-alphanumeric char replaced by "-">/*.jsonl`.

### Terminal

`GET /sessions/<name>/attach?token=…&cols=<n>&rows=<n>` upgrades to a WebSocket.

- 404 before upgrading if no zmx session has that name (`zmx attach` would otherwise create one).
- blimpd runs `zmx attach <name>` in a PTY (`Bun.spawn` with the `terminal` option) of `cols`×`rows`, env = blimpd's env minus `ZMX_SESSION`, plus `TERM=xterm-256color`, `COLORTERM=truecolor`.
- Server → client: binary frames, raw PTY output.
- Client → server: binary frames = keyboard input bytes; text frames = JSON control messages. Only one for now: `{ "type": "resize", "cols": n, "rows": n }`.
- When the socket closes, blimpd kills that zmx client (SIGTERM). The session keeps running.
- When the zmx client exits, blimpd checks whether the session still exists: if not, it closes with code 4000, reason `"ended"`; if it does (the user detached with ctrl+\), code 4001, reason `"detached"`.
- Backpressure: if the socket's buffered amount passes 8 MB (a stalled client), blimpd closes it with 1013 and kills that zmx client. The app reconnects and zmx redraws the current screen, so nothing is lost but scrollback the client never read.
- Several sockets on one session are fine: each gets its own zmx client. zmx keeps them in sync.

### Events

`GET /events?token=…` upgrades to a WebSocket. Server → client text frames:

- `{ "type": "sessions", "sessions": Session[] }`: sent on connect, then whenever the list changes. blimpd checks every 1 s. (A session that starts waiting must show in the app within 5 s.)
- `{ "type": "ports", "ports": Port[] }`: sent on connect, then when it changes (checked every 2 s). `Port` = `{ port, host: "127.0.0.1" | "::1", session, pid, command }`: a TCP port on loopback or any address that a program inside a blimp session listens on (Linux `/proc`: the listening sockets, the process holding each, and whether it descends from a session's zmx daemon). `GET /ports` returns the same list.
- `{ "type": "fs", "paths": string[] }`: watched paths that changed (debounced 150 ms).

Client → server: `{ "type": "watch", "paths": string[] }` replaces this socket's watch set. Each path is watched non-recursively (a folder: its direct entries; a file: its content). The app sends the expanded folders of the tree plus the open files. Paths outside home are ignored.

### Chat

For the phone: a Claude session as chat messages, and a way to type into it. Only for sessions where Claude Code runs (`sessionId` is known).

`GET /sessions/<name>/chat?token=…` upgrades to a WebSocket (404 for an unknown session). Server → client: `{ "type": "history", "messages": ChatMessage[] }` on connect (the last 200), `{ "type": "append", "messages" }` as the transcript grows (checked every 250 ms; a tool message comes again with its output under the same `id`), `{ "type": "reset" }` then a new `history` when the conversation changes, `{ "type": "unreadable" }` when blimpd doesn't know the session's Claude `sessionId` (Codex, a shell) or the transcript can't be read. A new session has no transcript until its first message: it gets an empty `history`, then `append` once the file appears. Close 4000 when the session ends.

`ChatMessage` (`src/chat.ts`): `user` (typed prompts only: no tool results, meta entries, command wrappers or system reminders), `assistant` (text blocks; thinking is skipped), `tool` (`name`, a one-line `summary`, `input`, later `output` and `error`; input and output at most 20 000 characters).

Client → server: `{ "type": "input", "id", "text" }` (pasted as a bracketed paste, then Enter; ESC is removed; at most 100 000 characters), `{ "type": "answer", "id", "at", "pick" }` (`at` = the prompt's `at`, when that wait started; presses the option's key, or replies "the question changed"), `{ "type": "interrupt", "id" }` (Esc). Replies: `{ "type": "ack", "id" }` or `{ "type": "error", "id", "error" }`. All three are de-duplicated by `id` (the last 100 per session): a repeat is acknowledged and not typed again. An `id` is remembered only after its write succeeded. Writes from one socket go one at a time, in order.

While a socket has sent input, it keeps one zmx client attached for it, at the size the session was last shown at through blimpd (120×36 if never), and resized with it: a client of another size would resize the session for everyone. The client starts on the first write, after checking the session still exists (`zmx attach` would create a missing one; the reply is then "the session ended"). zmx 0.5 drops an ESC that is a new client's first input, so if the first write starts with ESC, blimpd first sends an empty bracketed paste, which zmx passes and Claude ignores.

`Prompt` (`src/prompt.ts`), from the hook's input: `permission` (`tool`, `summary`, `options`, `keys`), `question` (AskUserQuestion's `questions`), `other` (Elicitation). `Session.prompt` is present while both the derived state and blimp's hook file say waiting. Claude Code 2.1.300 in default permission mode also sends a PermissionRequest for AskUserQuestion; blimpd treats it as the question, not a Yes/No. Permission options vary by command and only the screen shows them, so blimpd reads them from `zmx history` once per wait; without them they are Yes (`1`) and No (Esc). `answerable` is true for permissions and for one single-choice question, where a digit picks and submits; several questions or multi-select aren't answerable from the phone yet.

### Files

Every path must resolve, after following symlinks, to the home folder or something inside it. For a path that doesn't exist yet, its parent folder must. Otherwise 403.

`GET /fs/list?path=<dir>` → `{ "path": string, "entries": [{ "name": string, "kind": "file" | "dir", "size": number, "mtime": number /* ms */ }] }`, folders first, then by name. Symlinks are reported as what they point to; broken links are skipped.

`GET /fs/file?path=<file>` → the raw bytes. Headers: `Content-Type` from the extension (`application/octet-stream` if unknown), `X-Blimp-Mtime: <ms>`, plus CORS `Access-Control-Expose-Headers: X-Blimp-Mtime`. Over 50 MB → 413.

`PUT /fs/file?path=<file>&baseMtime=<ms>` body = raw bytes → `{ "mtime": number }`.
- If `baseMtime` is given and the file's mtime differs → 409 `{ "error": "changed on the server", "mtime": number }`. Without `baseMtime` it overwrites (the app's "keep mine" path).
- Writes go to a temp file in the same folder, then rename, keeping the original file's mode.

`POST /fs/mkdir` body `{ "path": string }` → 201 `{ "path": string }`: one new folder (not recursive). `POST /fs/create` body `{ "path": string }` → 201 `{ "path": string, "mtime": number }`: one new empty file. Both: 409 if the name exists, 403 if the parent isn't inside home or doesn't exist.

`GET /fs/download?path=<file or folder>` → a file's bytes, streamed, any size (`Content-Disposition: attachment; filename*=UTF-8''<name>`); a folder as `<name>.tar.gz`, made on the fly by `tar -czf - -C <parent> -- <name>` (symlinks are stored as links, never followed). A cancelled request stops tar.

`PUT /fs/upload?path=<file>&mode=new|replace` body = raw bytes, streamed → 201 `{ "size", "mtime" }`. Written to a hidden temp file beside the target, then put in place: `new` with a hard link, which fails (409) if the name was taken meanwhile; `replace` with a rename over a file of that name. Never over a folder (409). At most 2 GB (413); 507 if `Content-Length` is more than the free disk space.

`GET /fs/files?root=<dir>` → `{ "files": string[] /* relative to root */, "truncated": boolean }` for ⌘P. Inside a git repo: `git ls-files --cached --others --exclude-standard`. Otherwise walk, skipping `.git`, `node_modules` and dot-folders. Max 20 000.

### Hooks (status backup)

Claude's status files are internal and may change. So blimpd also installs Claude Code hooks that record status itself.

- `blimpd install-hooks` merges into `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`, for each of `Notification`, `Stop`, `UserPromptSubmit`, `PostToolUse`, `PermissionRequest`, `PreToolUse` (with `"matcher": "AskUserQuestion"`) and `Elicitation`: `{ "hooks": [{ "type": "command", "command": "'<absolute path of this blimpd>' hook", "timeout": 5 }] }`. It skips an event that already has a command containing `blimpd' hook` or `blimpd hook`. It keeps every other key and hook as they were, writes a one-time backup `settings.json.blimp-backup` before the first change, and writes atomically. Running it twice changes nothing. `install.sh` runs it.
- Codex: if `${CODEX_HOME:-~/.codex}` exists, the same install merges into its `hooks.json` (Codex reads hooks in Claude's format and sends the same JSON with `hook_event_name`), for `UserPromptSubmit`, `PreToolUse` (no matcher), `PostToolUse`, `PermissionRequest` and `Stop`: `'<blimpd>' hook codex`, same backup (`hooks.json.blimp-backup`) and rules. New entries go after the user's own in each event's list, because Codex keys each hook's trust by its place (`[hooks.state."<file>:<event>:<i>:<j>"]` in config.toml); Codex runs them only after the user trusts them in `/hooks`. `blimpd hook codex`: UserPromptSubmit, PreToolUse, PostToolUse → working; PermissionRequest → waiting; Stop → done. `notify` in config.toml is left alone. `blimpd uninstall-hooks` takes blimp's out of both files.
- `blimpd hook` reads the hook JSON on stdin. If `ZMX_SESSION` is set (Claude runs inside zmx, which sets it), it writes `<socket dir>/status/<ZMX_SESSION>.json` (the socket dir comes from `BLIMPD_SOCKET`, which Claude inherits from the session): `{ "state": "waiting" | "working" | "done", "at": <ms>, "sessionId": <session_id>, "event": <hook_event_name> }`. Notification with `notification_type` `permission_prompt`, `elicitation_dialog` or `elicitation_url_dialog` → waiting (other notifications, like `idle_prompt` about 60 s after a finished turn, are ignored); PermissionRequest, PreToolUse for AskUserQuestion, and Elicitation → waiting (these fire the moment the prompt appears; Notification can lag by seconds); UserPromptSubmit, PostToolUse → working; Stop → done. Measured with a real Claude asking a question: the hook file said waiting 0 ms after the question appeared, and `GET /sessions` 12 ms after. It always exits 0 quickly and prints nothing.

### zmx's socket folder

zmx keeps session sockets in `ZMX_DIR`, else `$XDG_RUNTIME_DIR/zmx`, else `${TMPDIR:-/tmp}/zmx-<uid>`. The last one is a predictable name in a shared folder, so blimpd creates it itself (mode 700) if it's missing, and refuses to start or run zmx if it isn't owned by the user or others can write it.

### Performance

`GET /sessions` and the 1 s event check run often. Cache transcript titles per file and parse only bytes appended since the last read (keep the byte offset and the custom/ai/prompt state). Don't re-read whole transcripts every second.

### Starting sessions

`POST /sessions` creates the zmx session from inside a PTY of 120×36 (not with stdin at /dev/null), waits until the session is listed with that client attached (`clients>0`; on zmx 0.5 killing it earlier loses the size), then kills that zmx client. Starts run one at a time, so two starts in the same second get different names. The session gets `TERM=xterm-256color` and `COLORTERM=truecolor`. The session then has a real size from the start: Claude renders its first screen properly, and output written before anyone attaches is shown to the first viewer.

## The app

### Rust shell (`app/src-tauri`)

Commands for the UI (`invoke`):

- `connect({ host: string, user?: string, port?: number }) → { id: string, port: number, token: string, home: string }`. `id` is `user@host:port`. Reuses a live tunnel for the same id. Errors are plain sentences (for example "SSH to claude1 failed: Permission denied (publickey)").
- `disconnect({ id: string })`.
- Event `tunnel-closed` with `{ id }` when an ssh child exits. The UI reconnects with backoff (1, 2, 5, 10 s, then every 10 s). Every window's links share the one tunnel per server.
- Updates: the `updater` plugin checks `https://github.com/mbeato/blimp/releases/latest/download/latest.json` (made by the release workflow, `scripts/latest-json.ts`) at launch and every 6 h, and on blimp > Check for Updates… (the menu sends the focused window `check-updates`); it takes only bundles signed with the key whose public half is `plugins.updater.pubkey`, then `process` relaunches. `update_server({ server }) → lastLines` runs `curl -fsSL https://github.com/mbeato/blimp/releases/latest/download/install.sh | sh` on the server over ssh (refused in a debug build pointed at a test blimpd); the UI offers it when blimpd's `/health` version is older than the app's.
- Port forwards (`src/tunnel.rs`): `forward_port({ server, host, port }) → localPort`: one more ssh (`-L 127.0.0.1:<free>:<host>:<port>`, host 127.0.0.1 or ::1 only), reused while it runs, closed by `unforward_port({ server, port })`, with its tunnel, or when the app exits.
- Browser tabs (`src/browser.rs`): a native web view per tab (Tauri's multiwebview, cargo feature `unstable`), a child of the window that opened it, labelled `b-<n>`. `browser_open({ url, rect }) → label`, `browser_bounds({ label, rect })` (`rect` = `{ x, y, w, h }`, logical pixels in the page), `browser_show({ label, shown })`, `browser_go({ label, url })`, `browser_nav({ label, action: "back" | "forward" | "reload" })`, `browser_close({ label })`, `browser_read({ label }) → { url, title, text, selection }` (the selection, else the text of the page's `article`/`main`/body, at most 200 000 characters; `url` is the view's own, not what the page says). A window can only reach its own views. Addresses must be http or https with a host, never `*.localhost` other than `localhost` itself. Events to the owning window: `browser` `{ label, url?, title?, loading? }` (page load started/finished, title changed). A view may load only http/https (not `*.localhost`), blob, data, `about:blank` and `about:srcdoc` (`on_navigation`), so it can never reach the app's own `tauri://localhost`, where it would count as the app; a link that opens a new window opens in the same view. Data store: its own (macOS 14+: `data_store_identifier`; older macOS: the default store, whose sites are kept apart from the app's `tauri://` origin anyway; Linux: `<app data>/browser`), so logins persist. Since a window with a child view is no longer a "webview window" to Tauri, the shell finds windows with `get_window`/`windows()` and its commands take a `Window`. On Linux, tauri-runtime-wry packs every web view of a window into its box and ignores bounds; the app ships for macOS, where views sit where they're told.
- Transfers (`src/transfer.rs`): `download({ server, path, id }) → savedPath` streams `/fs/download` to `~/Downloads` under a free name (`name 2.ext`…). `upload({ server, local, remoteDir, name, mode, id }) → files` streams a file, or a folder's files and folders, with `/fs/upload` and `/fs/mkdir`; it reads only paths dropped on a window (Tauri's drag-drop event) or picked in `pick_upload()` (the system file picker), and what's inside them. The page names the server by tunnel id; port and token come from the live tunnel. Progress: `transfer` events `{ id, done, total }`; `cancel_transfer({ id })`.
- Windows (`src/windows.rs`): `open_window({ init })` opens a new window `w-<n>` that starts from `init` (a query string: a place, `server`, `dir`, `session`, or a whole `layout`), handed to the page as `window.__blimpInit` (JSON-encoded, never pasted into script). `focus_project({ project, init }) → bool` brings forward another window with `project` (`"<server key>\n<folder>"`) in a tab and sends it `select-session`. `set_window_projects({ projects })`: every tab's folder. `drop_session({ init, x, y }) → bool`: a session let go outside this window, at a point on screen; the window under it gets `drop-session`, else a new window opens there. `drag_hover({ init, label, x, y }) → bool`: while such a drag is outside its window, the window under the point gets `drag-hover` `{ init, label, x, y }` (the point in its page) and the one it left gets `drag-hover` null; `init` null ends it (so does `drop_session`). `set_shown({ sessions }) → map`: every split in every tab, broadcast as `shown`, so other windows mark those sessions; `focus_session({ session, init }) → bool`; `take_session({ session })` sends `release-session` to windows that show it. A closing window makes the most recently focused one left save its tabs (`remember-layout`). `set_viewing({ sessions })`: the sessions on screen while that window has focus. `claim_notice({ session, key }) → bool`: false if a focused window shows `session` or another window already claimed `key` (`<server>/<session>/<wait start>`), so one wait gives one notification across windows. Clicking the Dock icon with no window open opens one.

All ssh children are killed when the app exits normally; on any other exit they end by themselves (see Connection). Plugins: `notification`, `store` (server list in `servers.json`, recent projects per server and the last server in `recent.json`), `opener` (links, http and https only). macOS: a custom menu (see macOS menu). Window 1400×900, min 900×600, title "blimp". Bundle id `dev.blimp.app`.

### UI (`app/src`)

React + TypeScript + Vite. Libraries: `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-web-links` + `@xterm/addon-webgl`, `monaco-editor` (bundled locally, workers via Vite, no CDN), `marked` + `dompurify`, `pdfjs-dist` (worker bundled locally), `@tauri-apps/api`, `@tauri-apps/plugin-notification`, `@tauri-apps/plugin-store`.

**Outside Tauri** (browser, for development and the e2e tests): `src/lib/connection.ts` reads `?blimpd=http://127.0.0.1:PORT&token=T` from the page URL instead of calling `connect`, keeps the server list in localStorage, and uses the web Notification API. Everything else is the same code.

**Layout**: like VS Code. A window has project tabs: Home (the server's home folder) first, then one tab per open folder (a server and a folder). Every open tab's workbench stays mounted, hidden while another is in front, so its open files and terminals survive switching. The window's layout (`src/lib/tabs.ts`: the tabs, each with its terminal splits, the tab in front, and the three show/hide states) is kept in the page URL (`layout=`), so a reload stays put, and in the store, so the next launch reopens it (with several windows, the one changed last). A new window starts from a place (`server`, `dir`, `session`).

1. **Top bar.** The project tabs (Home's is a house icon; a project tab shows the folder's name, the server's too when there are several, an amber dot while a session there waits, and × on hover; a middle-click closes it), a + for Open Folder…, the connection state when not connected, and three show/hide buttons at the right, as in VS Code: files (⌘B), terminal (⌘J), session list (⌘⌥B). They're the window's, not per tab.
2. **Files (left, full height, 240 px, resizable, ⌘B).** The folder's tree (`.git` hidden). Buttons: New file, New folder (both in the folder last clicked, or the clicked file's folder; inline name field; 409 shows "already exists"), Collapse folders.
3. **Editor (top right).** One tab per opened file, then the browser tabs. With no file open it's hidden and the terminal fills the right side (with the terminal hidden, it says how to open a file); on Home it shows Welcome instead (recent projects, Open Folder, New Window, the server picker, Add server, the offline error with Try again / Remove server, keys).
   - ⌘P: fuzzy open by name over `/fs/files` of the folder.
   - Text/code: Monaco, language from the extension, theme follows the app. **Autosave**: 1 s after the last edit, and at once when the editor loses focus, the tab changes, the window blurs or the project changes; ⌘S saves at once. Saves send `baseMtime`. On 409, or when an `fs` event says an open file changed while an edit is unsaved: a bar "Changed on the server: Reload / Keep mine", and autosave leaves the file alone until one is picked. Keep mine saves without `baseMtime`. With nothing unsaved it reloads silently (keeping the cursor). Closing a tab saves first; only a failed save asks ("isn't saved: Try again / Close without saving / Cancel").
   - Markdown: rendered (marked in a Web Worker, 5 s and 1,000,000-character limits, then DOMPurify) with an Edit toggle that switches to Monaco. A file that breaks marked shows "Can't show this Markdown" instead of freezing the app. A click on a relative link opens that file in a tab; an http or https link opens in the system browser, the same way as terminal links (on a plain click); any other link (`javascript:`, `file:`, `data:`, an anchor) does nothing. Nothing navigates the app's window.
   - **Browser tabs** (`components/PageView.tsx`, `lib/browser.ts`): + after the tabs, the globe at the top right, or ⌘T opens one with the address field focused; a server port opens one at its forward (`forward_port`). Bar: Back, Forward, Reload, the address (a port tab's forward shows as the server's `localhost:<port>`; `example.com` → https, `localhost:3000` or `host:port` → http; anything else isn't an address), Open in Browser, Send to session. The title is the page's. In the Mac app the page is a native view kept over the area under the bar (bounds sent on resize, window resize and after each render) and shown only while its tab is in front, its project tab is in front, the editor is showing, and nothing of the page's is open over it: dialogs, menus, context menus and a session drag count (`lib/overlay.ts`). In a browser the page is a sandboxed iframe (scripts, forms, modals; not top navigation or popups), which can show only `http://127.0.0.1:*` (CSP) and can't read the page, so there Back and Forward are off. **Send to session**: a menu of the folder's sessions, the focused split's first; reads the page (`browser_read`; in a browser only the address), uploads `page-<host>.md` (title, address, "Text" or "Selected text") to `~/.blimp/uploads` as a dropped file is, shows the session if it isn't on screen, and pastes `Page <url>: <path> ` (one line, so a shell doesn't run it).
   - Images (png, jpg, jpeg, gif, webp, svg, ico, bmp): shown fitted. SVG goes through an `<img>` from a blob URL, never inline.
   - PDF: pdf.js, all pages, scrollable.
   - Anything else binary (NUL byte in the first 8 KB): "Can't show this file", plus its size.
   - The tree and open files update from `fs` events.
4. **Terminal pane (bottom right, ⌘J, resizable).** Splits side by side, each a session's xterm.js terminal on `/sessions/<name>/attach`, fitted, resize sent on fit; one split has the keyboard. Dragging a running session from the list (pointer events, not HTML drag and drop) lifts its row: the row is drawn under the pointer where it was grabbed, and its place in the list is an empty dashed slot. Onto the left or right half of a split puts it there, or moves it if it's already shown (`src/lib/panes.ts`); with several splits each has a header with the session's name and × (closes the split, not the session), and the lines between them resize. A click in the list focuses the split showing that session, else shows it in the focused split. A split's header drags like its row. Outside the window, the window under the pointer draws the lifted row (`drag_hover`) and, if that session's folder is its front tab, the half of the split it would land in, else an outline round the whole window; over no window nothing can be drawn. Let go outside the window (the pointer is captured, so the page still sees where), the session moves: Rust's `drop_session` hit-tests the other windows (most recently focused first) and sends the one under the point `drop-session` with the place and the point in its page, which puts it in that folder's tab at that point; over no window, a new window opens there. Right-click a row or a split header: Open in New Window (that session), Open All Splits in New Window (the splits, as a layout for the new window). A session moved out isn't picked again to fill this pane's terminal. Sessions shown once stay mounted, in one parent and placed by their split, so moving or hiding one never drops its scrollback. Font: 13 px, `ui-monospace, "SF Mono", Menlo, monospace` (the same stack for Monaco and code in Markdown; UI text uses the system font). Keys like the VS Code terminal on macOS: ⌘C copies the selection (if any), ⌘V pastes, ⌘ combos go to the app, ⌘Backspace sends `\x15`, ⌥Backspace sends `\x17`, ⌘← sends `\x01`, ⌘→ sends `\x05`, ⌥← / ⌥→ send `\x1bb` / `\x1bf`. On close code 4001 "Detached" with a Reattach button; on 4000 the session leaves the list and the pane shows another. On other drops it reconnects. Before connecting (and reconnecting), the terminal is cleared; never after data has arrived, since zmx sends the current screen first. Web links open in the system browser (Tauri opener plugin; `window.open` outside Tauri), http and https only, on ⌘-click (Ctrl-click off the Mac). File paths (`src/a.ts`, `./x`, `~/x`, `/abs`, with optional `:line[:col]`) are links when the file exists (checked with `/fs/list` of its folder, cached 5 s); ⌘-click opens the file in a tab at that line. A plain click does nothing, so text next to a link can still be selected.
5. **Session list (right of the terminal, 230 px, resizable).** The sessions whose folder is exactly the window's folder, newest first (by start, so rows don't move as states change; a split group, on screen or kept, sits where its newest session would be): a mark (working: spinning ring; waiting: amber dot; idle: empty ring; a shell, or a kind with no hooks, with no state: `>_`), the title (for anything but Claude Code, the zmx name), the kind's `label` if it has one (also in split headers), last activity. A session another window of the app shows (Rust `set_shown`) is left out, unless it's in a split here too, and never picked to fill a terminal here. Hover shows a trash button: an idle Claude session ends at once (`DELETE /sessions/<name>`), anything else asks first. "+" starts Claude Code (⌘N). The chevron beside it fetches `GET /kinds` when it opens and lists every kind (unavailable ones greyed, with their note), then "Models and keys…" (Settings at Models). "Earlier": `/conversations?dir=` minus conversations a running session has open; a click resumes one in a new session. A split whose session ended closes; with no split left, the pane shows the session waiting longest, else the newest.

**Settings > Models** (per connected server): Z.ai key, Set / Not set from `GET /keys`; a password field and Save send it with `PUT /keys/zai` and clear the field (the app never stores it); Remove → `DELETE /keys/zai`. Codex, Signed in / Not signed in / Not installed from `/kinds`; Sign in closes Settings and starts a `codex-login` session in the front tab's folder (that server's Home tab if the front tab is on another server). A line says custom kinds live in `~/.blimp/kinds.json` on the server.

**Shortcuts**: ⌘K jump palette: fuzzy over every session's title, folder and name across servers; Enter shows it in its folder's tab here if there is one, else brings forward another window with that folder in a tab (`focus_project`), else opens the folder in a new tab here. Ranking: a contiguous match beats a scattered one, a match at a word start beats one mid-word, and a title match beats a folder or name match. When focus is inside Monaco, ⌘K goes to Monaco (its ⌘K chords, as in VS Code). ⌘N new Claude session here. ⌘⇧N new window. ⌘O Open Folder: recent folders (`/folders/recent`), browse (`/fs/list`, with New folder), or a typed path. ⌘P quick open. ⌘S save now. ⌘W close the active file tab (from anywhere in the window; nothing when no file is open). ⌘T new browser tab. ⌘B files. ⌘J terminal. ⌘⌥B session list. Esc closes dialogs (and cancels a session drag).

**Waiting**: when a session's state becomes `waiting` (not on first load), send a notification "<title> is waiting for you" (body: the folder), unless this window is focused and shows that session in a split of the tab in front. In the Mac app every window watches, and `claim_notice` lets exactly one notify (none if any focused window shows it). Dock badge = number of waiting sessions on connected servers (`getCurrentWindow().setBadgeCount(n || undefined)`), only in Tauri; it's app-wide, so every window sets the same number.

**Look**: native-feeling Mac app, not a web page. Dark by default (follows system light/dark), compact type (13 px UI, system font), subtle 1 px dividers, no heavy shadows or gradients. Accent for "waiting" only. Colors as CSS variables in one file.

### Content security policy

The UI renders files from servers (Markdown, SVG, PDF), so script injection must be impossible and, if it ever happened, contained. The same policy is set in `app/src-tauri/tauri.conf.json` (`app.security.csp`) and as a `<meta http-equiv="Content-Security-Policy">` in `app/index.html`, so the e2e tests run under it too:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:* ws://127.0.0.1:*; object-src 'none'; frame-src http://127.0.0.1:*; base-uri 'none'; form-action 'none'
```

(Vite's dev server needs `ws://localhost:*` for hot reload; add it only in dev.) pdf.js (pdfjs-dist 6, which never uses eval) runs with scripting off. Tauri capabilities (for the web views `main` and `w-*`, by web view label, so a browser tab's view in the same window gets none) grant only what the UI uses: the app's own commands (`build.rs` lists them: tunnels and port forwards, windows, transfers, browser tabs), event listen, set-badge-count, set-title, notification, store, opener limited to `http:`/`https:` URLs and reveal-in-Finder. The dialog plugin is used from Rust only. No shell, fs or http plugin. `frame-src` allows only `http://127.0.0.1:*`: a browser tab in the browser build, shown in a sandboxed iframe (scripts, forms and modals allowed, top navigation and popups not); it's another origin, so it can't reach blimp's page or its token. In the Mac app a browser tab is a native view, outside the page and its CSP (see Browser tabs).

### macOS menu

A custom menu, so the web page gets ⌘W, ⌘N, ⌘⇧N, ⌘O, ⌘P and ⌘K: app menu (About, Hide, Hide Others, Show All, Quit ⌘Q), Edit (Undo, Redo, Cut, Copy, Paste, Select All with their usual keys), Window (Minimize ⌘M, Zoom). No Close Window ⌘W, no Print ⌘P.

## Tests and checks per milestone

- Unit: `bun test` in the repo root (blimpd) and `bun test` in `app/` (UI logic: fuzzy match, grouping/sorting, key mapping, state transitions → notifications).
- E2E (`app/e2e`, Playwright, Chromium): starts a test blimpd on a temp socket, an `ssh -N -L` tunnel to localhost (the same forward the Rust shell sets up), the Vite dev server, and drives the UI. zmx sessions made by tests are named `blimpe2e-*` and killed after.
  - M2: open a session in blimp and attach a second zmx client from a PTY; text typed in either shows in both.
  - M3: a session goes to waiting (hook file or a real Claude asking a question) → the row shows waiting within 5 s and the notification function is called.
  - M4: edit and save a file in blimp → `git diff` shows it. Change an open, edited file on the server → the reload bar appears.
- Rust: `cargo clippy` and a Linux `tauri build` here; a macOS build on GitHub Actions (`macos-latest`), uploaded as an artifact.
- Things only a Mac can check (notification banner, Dock badge, keyboard feel) go in a checklist for Max.
