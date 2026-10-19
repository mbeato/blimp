# blimp on the phone, with voice

Date: 2026-10-19. Asked by Max: "get the mobile app out as well with voice mode". What matters most on the phone: latency and performance. Decided with Max in brainstorming:

- **Connection:** Tailscale, not SSH from the phone.
- **App:** native SwiftUI, not Tauri. The phone shows a chat like the Claude or ChatGPT apps, not a terminal.
- **Voice:** a talk button, and replies read aloud minus code. No hands-free mode.
- **Push alerts when the app is closed:** not in v1.
- **Also in v1:** start sessions, interrupt Claude, end sessions. Not in v1: viewing files, attaching photos.

## What's on claude1 today (facts the design rests on)

- A KVM server with a public address (159.195.235.8). SSH is open on 22. The Mac apps reach it over the internet with plain SSH.
- ufw is on: incoming traffic is blocked unless allowed.
- Tailscale isn't installed.
- blimpd listens only on `~/.blimp/blimpd.sock`, with no TCP port (SECURITY.md).
- Claude Code 2.1.300 and zmx 0.5.0.
- Transcripts (`~/.claude/projects/<folder>/<sessionId>.jsonl`) keep each assistant content block as its own entry: `text`, `tool_use`, `thinking`. Tool results come back as `user` entries with `tool_result` blocks. blimpd already finds a session's transcript from its `sessionId` (`src/sessions.ts`).

## 1. Connection

```
iPhone app ──HTTPS / WSS──▶ Tailscale (WireGuard, on the tailnet only)
                              ▼
                     claude1: tailscaled ──▶ ~/.blimp/blimpd.sock (blimpd, unchanged)
```

- **Max installs Tailscale** on claude1 (`curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`) and the Tailscale iOS app on the phone, both on his tailnet. blimp can't bundle Tailscale.
- **Direct, not relayed.** Run `sudo ufw allow 41641/udp` so a phone behind a cellular carrier's NAT can reach claude1 directly instead of through Tailscale's relay (DERP). Before building on it, measure `tailscale ping claude1` from the phone on wifi and on cellular, and report the numbers to Max. "via DERP" on cellular after the ufw rule is a finding to raise, not to work around silently.
- **Route A (preferred): `tailscale serve` to the unix socket.** `sudo tailscale serve --bg --https=443 unix:<home>/.blimp/blimpd.sock`, if the installed Tailscale supports `unix:` targets. blimpd opens no port at all. The phone talks to `https://claude1.<tailnet>.ts.net` with a real certificate, so iOS needs no security exceptions. WebSockets pass through.
- **Route B (fallback, only if A isn't supported):** blimpd also listens on claude1's Tailscale IPv4 address (100.x.y.z, from `tailscale ip -4`), port 7425, plain HTTP inside WireGuard. It never listens on 0.0.0.0 or the public address. It's off unless `~/.blimp/config.json` has `"tailscale": true`. If the address isn't up yet it retries every 10 s. The app allows plain HTTP for `*.ts.net` only (an ATS exception domain).
- The first plan step checks which route works and records it here ("As built").
- **Same token rules as the Mac** (DESIGN.md, Token): `Authorization: Bearer`, `?token=` on WebSockets, constant-time compare, 401 with no CORS header.

### Pairing

- `blimpd pair` creates `~/.blimp/phone-token` (32 random bytes, hex, mode 600) if it doesn't exist. It prints a QR code in the terminal and the same thing as text: `blimp://pair?url=<https://claude1.….ts.net>&token=<phone token>`. The URL comes from `tailscale status --json` (the machine's DNS name), or from `--url` if given.
- blimpd accepts either token: `~/.blimp/token` (Mac) or `~/.blimp/phone-token`. It reads the phone token file on each request, so revoking takes effect at once without a restart.
- `blimpd pair --revoke` deletes the phone token. The Mac keeps working.
- The phone scans the QR code (VisionKit's scanner) or takes a pasted `blimp://` link, checks `GET /health`, and stores URL and token in the iOS Keychain (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, never synced to iCloud).

## 2. blimpd: chat features (new routes; existing ones unchanged)

### Messages

`GET /sessions/<name>/chat?token=…` upgrades to a WebSocket. Server → client text frames:

- `{ "type": "history", "messages": ChatMessage[] }` on connect: the last 200 messages of the session's current transcript.
- `{ "type": "append", "messages": ChatMessage[] }` when the transcript grows. blimpd reads only bytes added since the last read, as titles do. It checks on the existing 1 s tick and when the session's hook file changes.
- `{ "type": "reset" }` then a new `history`, when the session's `sessionId` changes (`/clear`, compaction into a new file, resume).
- `{ "type": "unreadable" }` if the transcript can't be found or parsed. The app shows "Can't show this conversation, open it on the Mac".
- Close code 4000 when the session ends, as with attach.

```ts
type ChatMessage =
  | { id: string; at: number; role: "user"; text: string }
  | { id: string; at: number; role: "assistant"; text: string }        // Markdown
  | { id: string; at: number; role: "tool"; name: string; summary: string;
      input: string; output?: string; error?: boolean };              // input/output capped at 20 KB each
```

- `id` = the entry's `uuid`, plus `#<block index>` when one entry has several blocks.
- `user`: typed prompts only. Skipped: `tool_result` entries, `isMeta` entries, command wrappers (`<command-name>`, `<local-command-stdout>`), and system reminders.
- `assistant`: `text` blocks. `thinking` is skipped.
- `tool`: one per `tool_use`, with `output` and `error` filled in when its `tool_result` arrives (the update is sent again as an `append` with the same `id`; the app replaces by `id`). `summary` is one line: Bash → "Ran `<command, first line, 80 chars>`", Edit/Write → "Edited <path relative to the session's folder>" / "Wrote …", Read → "Read <path>", Grep/Glob → "Searched for <pattern>", Task/Agent → "Agent: <description>", anything else → the tool's name.
- Only for sessions of kind `claude` or `claude-glm`. Others get `unreadable`.

### Waiting prompts

`Session` gets an optional `prompt`, sent with `sessions` events as now:

```ts
prompt?:
  | { kind: "permission"; tool: string; summary: string; options: string[]; answerable: true }  // e.g. ["Yes", "Yes, and don't ask again …", "No"]
  | { kind: "question"; questions: { question: string; header?: string; multiSelect: boolean;
                                     options: { label: string; description?: string }[] }[];
      answerable: boolean }                                                    // true only for one single-choice question
  | { kind: "other"; answerable: false };                                     // Elicitation, anything unknown: "Open on Mac"
```

- `blimpd hook` writes it into the status file it already writes, from the hook's input: `PermissionRequest` (`tool_name`, `tool_input`) → `permission`; `PreToolUse` for `AskUserQuestion` (`tool_input.questions`) → `question`; `Elicitation` → `other`. The `Notification` that follows a permission prompt (seconds later) keeps the prompt already in the file for the same `sessionId`. Any state other than `waiting` clears it.
- Permission `options` vary by command (the probe saw four: "Yes", "Yes, and don't ask again for …", "Yes, and switch to auto mode", "No"), and the hook input doesn't carry them. So blimpd reads them from the screen: `zmx history <name>`, the last 40 lines, the numbered lines (`❯ 1. Yes`, `  2. …`) after "Do you want to proceed?". It reads once per wait (keyed by the hook's `at`). If it finds none, the options are `["Yes", "No"]`, meaning the first and the last option.
- A question the phone can't answer safely becomes `answerable: false` (see Input). The phone shows it read-only with "Open on Mac to answer".

### Input (on the chat socket)

The probe (below) found that opening and closing a zmx client for each keystroke batch confuses Claude's screen. So input goes through the chat socket: while a phone has `/sessions/<name>/chat` open, blimpd keeps one zmx client attached for it. That client's output is thrown away. It is attached at the session's last known size: blimpd records cols×rows from every attach and resize it proxies, and uses 120×36 if it has seen none. When a proxied terminal resizes, the chat clients of that session resize with it. Without this, a second client of another size resizes the session (the probe saw the shell report 20×50 while a 50×20 client was attached).

Client → server text frames on `/chat`:

- `{ "type": "input", "id": string, "text": string }`: typed as a bracketed paste (`\x1b[200~…\x1b[201~`), then `\r`, as a paste plus Enter on the Mac. Text is at most 100 000 characters. `id` is a client-made UUID. blimpd remembers the last 100 ids per session, and a repeat is acknowledged but types nothing, so a retry after a reconnect can't send a message twice.
- `{ "type": "answer", "id": string, "at": number, "pick": number }`: `at` is the prompt's wait start (from `Session.stateSince`), `pick` an option index. If the session isn't waiting on that prompt any more, the reply is `error` "the question changed". It works for permission prompts and for a single, single-choice question. blimpd presses the option's digit (`1`–`9`), which the probe confirmed picks and submits at once. Several questions or multi-select: not answerable in v1 (`answerable: false`).
- `{ "type": "interrupt", "id": string }`: sends `\x1b` (Esc).
- Server → client: `{ "type": "ack", "id" }` once written, or `{ "type": "error", "id", "error": string }`.
- Only for sessions of kind `claude` or `claude-glm`. Others get `unreadable` and accept no input.

### What the probe found (Claude Code 2.1.300, zmx 0.5.0, 2026-10-19)

- Bracketed paste then `\r` sends a multi-line message intact.
- A permission prompt: `1` picks "Yes" and runs the command at once.
- A single-choice AskUserQuestion: `2` picks the second option and submits at once.
- Multi-question and multi-select AskUserQuestion: digits toggle and arrows move between tabs, but separate attach/detach clients sending them got the wrong boxes ticked, and Esc didn't cancel. Not in v1.
- A new folder shows a "Do you trust this folder?" screen, and no hook fires for it. A session started from the phone in a folder Claude hasn't seen would be stuck there. v1 starts sessions only in recent folders (already trusted). Anything else shows as `unknown` and "Open on Mac".
- Starting `zmx attach` for a name right after `zmx kill` of the same name can attach to the dying session. Tests use fresh names.
- Claude started from inside another Claude session inherits `CLAUDE_CODE_*` variables and turns off transcript saving. blimpd runs outside Claude, so this only matters for tests run from a Claude session: they strip `CLAUDE*` from the environment.

## 3. The iPhone app (`ios/`)

- SwiftUI, iOS 26 minimum (for SpeechAnalyzer). The project is generated from `ios/project.yml` with XcodeGen, so no `.xcodeproj` is hand-edited. Bundle id `dev.blimp.phone`, name "blimp". The version comes from `scripts/version.sh`, which now sets five places.
- No server code is shared with the Mac app. The API client is small: `URLSession` for HTTP and `URLSessionWebSocketTask` for `/events` and `/sessions/<name>/chat`.
- **Lock:** Face ID (LocalAuthentication) when the app opens and when it returns after 5 minutes away.

### Screens

1. **Pair** (first launch, or after a 401): scan the QR code, or paste a link.
2. **Home**, from `/events`:
   - **Waiting** first: every waiting session across all projects, oldest wait first.
   - Then **one group per project folder**, most recent activity first. The header shows the folder name, the session count, and an amber dot if any session is waiting. Under it, its sessions newest first, each with title, state mark, kind label (if any) and "2m ago".
   - Swipe a row to end its session (asks first; `DELETE /sessions/<name>`).
3. **Project** (tap a group header): its sessions, then "Earlier" (`/conversations?dir=`, minus ones a running session has open). + starts a Claude session there (`POST /sessions { dir }`). Tapping an earlier conversation resumes it (`resume`).
4. **Session** (full screen chat):
   - Bubbles for `user` and `assistant`. Assistant Markdown is rendered with a Markdown package (picked in the plan, Swift Package Manager only).
   - `tool` messages are one grey line each, and a tap expands input and output in a monospace block.
   - A "working…" line while the state is `working`, with a Stop button (`interrupt`).
   - A waiting `prompt` with `answerable: true` shows its options as buttons above the input. Otherwise the question and its options show read-only, with "Open on Mac to answer this".
   - Input box, Send, and the mic button (section 4). Return adds a new line; Send sends.
   - Not a Claude session, or `unreadable`: "Open on Mac to use this".
   - Session ended: "Session ended" and Resume (when there's a `sessionId`).
- **Where you are:** the same session can be open on the Mac and the phone at once. Messages typed in either show in both.
- Look: follows system light/dark, system font, the amber accent only for "waiting", as on the Mac.

## 4. Voice

- **Speech to text:** Apple's SpeechAnalyzer, on the device, no audio leaves the phone. Custom vocabulary from the session's project folder names, session titles, and a fixed list (blimp, blimpd, zmx, Claude, Codex).
- **Mic button:** hold to talk, or tap to start and tap to stop. Words show in the input box as they're recognized. Release (or the second tap) sends. Swipe up while holding keeps the text in the box unsent, to edit.
- **Read aloud:** a speaker toggle per session (remembered per session on the phone). When it's on, each new `assistant` message is spoken with AVSpeechSynthesizer, using the voice picked in the app's Settings (it lists installed voices and says how to download a Premium one in iOS Settings).
- **What's spoken:** the reply's text with code blocks, tables and inline code longer than 40 characters replaced by "code skipped". Paths longer than three parts are cut to the file name. Links are read as their text, and Markdown marks are removed. This is a pure function with tests.
- **Questions read aloud** when a `prompt` appears in the open session with read-aloud on: "Claude wants to run bun test. Yes, yes and don't ask again, or no?", and for questions each question and its options.
- **Answering by voice:** while a prompt is showing, the mic's words are matched to the options: "yes" / "no", "option two" / "the second one" / "two", or most of an option's label. One clear match: picked and sent. Unclear: the best guess is highlighted and nothing is sent until a tap. Never a guess on its own. This is a pure function with tests.
- **Stopping speech:** tap the bubble being read, or press the mic.
- Only the session on screen speaks. Other sessions that start waiting or finish give a banner at the top and a short sound while the app is open.
- With the app in the background or the phone locked, nothing is spoken (no push in v1).

## Errors

- **Connection lost:** a "Reconnecting…" bar, and retries with backoff (1, 2, 5, 10 s, then every 10 s), as the Mac. On return to the app it reconnects at once.
- **Tailscale off** (the host doesn't resolve or isn't reachable): "Tailscale isn't connected", with a button that opens the Tailscale app.
- **Send while offline:** the text stays in the box, not sent, not queued. A send that timed out is retried with the same `id`.
- **401:** back to Pair.
- **"the question changed"** on answer: the buttons refresh from the latest `prompt`.

## Security (SECURITY.md gets these rows)

| Attacker | What they try | What stops them |
|---|---|---|
| Another device on Max's tailnet | Call blimpd through Tailscale | It needs a token. A tailnet access rule (in the docs) limits `claude1:443` (or 7425) to Max's own devices. Nothing listens on the public address. |
| Someone with Max's phone | Use blimp | Face ID on open. The token is in the Keychain, this device only, not synced. `blimpd pair --revoke` cuts it off without touching the Mac. |
| Someone on the network | Read or change traffic | Tailscale (WireGuard) end to end, plus HTTPS on route A. |
| A hostile transcript or tool output | Script in the app | Markdown is rendered natively, with no web view and no HTML. Links open only on tap, http/https only, in Safari. |

And under Accepted: **"No TCP port"** becomes "no TCP port on the public network". On route A, tailscaled is the listener. On route B, blimpd listens on the Tailscale address. **The phone token** can do everything the Mac's can.

## Speed targets (measured, written in DESIGN.md's latency section)

- `input` on wifi: the text shows in an attached Mac terminal within 150 ms (median).
- A prompt shows on the phone within 2 s of Claude showing it.
- Speech starts within 0.5 s of an `append` with a new assistant message.
- `tailscale ping` from the phone: direct on wifi and cellular, numbers recorded.

## Tests

- **Server** (`bun test`):
  - Transcript → `ChatMessage` with fixture transcripts: skipped entries, tool summaries, tool results filling in later, appends parsed from added bytes only, reset on a new `sessionId`, unreadable.
  - `/chat` WebSocket against a fake session: `input` (bracketed paste + Enter reaches the session; a repeated `id` types nothing), `answer` (the digit; a stale `at` is refused), `interrupt` (Esc), and an attached viewer's size unchanged by the chat client.
  - Phone token: accepted, revoked takes effect at once, `pair` makes a 600 file and prints the link.
  - Hook `prompt` from fixture hook inputs.
  - Real Claude (new, opt-in with `BLIMP_REAL_CLAUDE=1`, since it uses the account): a permission prompt answered through `answer` runs the command; a single-choice AskUserQuestion answered through `answer` gets that option; a message sent with `input` shows in the transcript and comes back as a `user` ChatMessage.
- **App** (`xcodebuild test` on the iPhone simulator, in CI on `macos-latest`): spoken-text cleaning, voice answer matching, home grouping and sorting, `ChatMessage` decoding and replace-by-id.
- **Max's checklist** (`docs/PHONE-CHECKLIST.md`): pairing by QR, Face ID, a full conversation by voice, answering a permission by voice, interrupt, start and resume a session, network switch mid-session, read-aloud quality.

## Distribution

- CI builds the app on `macos-latest`, signs it and uploads to TestFlight with an App Store Connect API key stored as repository secrets (Max makes it and adds them; the plan has the steps). Only release tags upload. App Store review is not planned.
- Released with the rest as plain vX.Y.Z (`scripts/version.sh`, commit, tag, push).

## Order of work (each step usable on its own)

Max asked to build the app first and do Tailscale later. Nothing before step 4 needs Tailscale: during development the app reaches blimpd at `http://127.0.0.1:<port>`, an SSH forward from the Mac to the socket (`ssh -N -L 7425:<home>/.blimp/blimpd.sock claude1`), which the iPhone simulator on that Mac shares. A dev link `blimp://pair?url=http://127.0.0.1:7425&token=<Mac token>` is pasted on the Pair screen. Debug builds allow plain HTTP to `127.0.0.1` only.

1. **Server chat features:** `/chat` (messages, `input`, `answer`, `interrupt`) and `prompt`, with tests including real Claude. DESIGN.md gets the routes. Check: a conversation driven only through `/chat` with `websocat`, while the Mac shows it live.
2. **iPhone app:** Pair (pasted link), Home, Project, Session, Face ID, built and tested in CI on the simulator. Check: Max holds a full conversation from the simulator on his Mac while the Mac app shows the same session.
3. **Voice:** mic, read aloud, voice answers. Check: in the simulator (Mac mic and speakers) and the checklist's voice items.
4. **Connection and the real phone:** Max installs Tailscale (commands above). Measure direct vs relayed. Pick route A or B. `blimpd pair` with QR scanning, phone token, SECURITY.md. TestFlight upload. Check: `curl https://claude1.<tailnet>.ts.net/health` with the phone token from another tailnet device works, and without it gets 401; then the checklist on Max's phone.

## Later (not v1)

- Push alerts when the app is closed (blimpd sends straight to Apple's push service with Max's push key).
- Hands-free voice conversation.
- Viewing files and diffs, attaching photos.
- A terminal view for non-Claude sessions.
- A pairing QR code shown in the Mac app.
