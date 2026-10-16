# blimp: spec v1

An open-source Mac app for running Claude Code on a remote server. One place to see and use every live session, and the files they're working on, from any of your devices. Later also from your phone.

## Goal

Open blimp and see every live session on your server: what it's doing, and which ones are waiting for you. Click one and you're in its terminal, as if you'd SSHed in. Browse, view and edit the files next to it without opening VS Code.

**v1 is done when:**
- Max uses it instead of `claude1 ls` / `claude1 -a` / `code1` for a full working week without falling back.
- A stranger can go from a fresh Linux server to a working blimp by following the README.

## What v1 does

**One window, three panes**

1. **Sessions sidebar** (left)
   - Every running session, grouped by project folder.
   - Each row: title (Claude's title or your `/rename`), status (working / done / waiting for you), last activity ("2m ago"), and the folder it runs in.
   - Sessions waiting for you go to the top and get a dot.
   - **New session here** (⌘N, or "+" on a folder group): starts a session in the same folder as the current one, in one click.
   - **New session in…** (⌘⇧N): pick a folder from recent project folders, browse the server, or type a path. It can also resume an earlier conversation from that folder, with the same list `/resume` shows there.

**Folders are preserved exactly.** A session's folder decides what Claude reads (the project's CLAUDE.md, settings, memory) and which history `/resume` shows. blimp always starts sessions in the real folder on the server, the same as typing `claude` there, and never in a copy or a temp folder. The files pane opens at the session's folder.
2. **Terminal** (center)
   - The live session. Sessions keep running on the server when the app closes, and several devices can watch the same one.
   - Copy, paste, ⌘Delete and scrolling behave like the VS Code terminal (same terminal component, xterm.js).
   - Tabs, so you can keep a few sessions open and switch with ⌘1–9.
3. **Files** (right, can be collapsed)
   - Folder tree for the session's project, with ⌘P to open a file by name.
   - **Editing:** text and code open in Monaco, the editor inside VS Code, so you get the same keys, search/replace, syntax highlighting and multi-cursor. Save with ⌘S. If Claude changes a file you have open, you get a "reload / keep mine" prompt.
   - **Viewers:** Markdown (rendered, with a toggle to edit), images, and PDF (pdf.js, the viewer Firefox uses).
   - Refreshes live when a session edits files.

**Mac niceties:** Dock badge showing how many sessions are waiting, a Mac notification when a session starts waiting for you, and ⌘K to jump to any session by typing part of its title.

## How it works

```
blimp Mac app (Tauri + xterm.js + Monaco)
      │  SSH (your existing key; nothing else exposed)
      ▼
your server: blimpd (small TypeScript service, listens only on localhost)
      ├─ sessions: list, status, titles; start new ones
      ├─ terminal: attaches to a session in a PTY, streams it over a WebSocket
      └─ files: list / read / write / watch under your home folder
```

- **Connection is plain SSH.** The app connects with your normal SSH key and forwards to blimpd, which only listens on the server itself. Strangers don't have to set up Tailscale, open ports, or deal with logins and certificates. If you already have SSH access, blimp works.
  - This changes the earlier draft, which used Tailscale. Tailscale still works (just SSH to the Tailscale address), and it's the likely route for the phone.
- **Sessions live in zmx** on the server, the same as `claude1` today. blimp is another way to attach, so the terminal, `claude1` and blimp all work side by side, and nothing is lost if the app crashes.
- **Status:** v1 reads Claude Code's per-session status files. These are undocumented and may change, so blimpd also installs Claude Code hooks (Notification / Stop) that write blimp's own status as a backup.
- **Server setup:** one command, `curl … | sh`. It:
  - installs blimpd and zmx as a user service, with no root needed;
  - checks that Claude Code is installed;
  - prints what to enter in the app (host, user).
- **Nothing hardcoded:** you can add more than one server in the app, and nothing assumes `claude1`, Max's paths, or recense.

## Later (the "basically VS Code" path)

- **Office files:** PPTX / DOCX / XLSX preview. The server converts them to PDF with LibreOffice when it's installed, and the PDF viewer shows the result. This is the first post-v1 milestone.
- **Git pane:** changed files, diffs, and the branch and PR for each session.
- **Phone app:** Tauri builds iOS from the same code, but the terminal on a phone needs its own design.
- **Extensions:** Monaco can't run VS Code extensions. If we later want the real extension ecosystem, the option is to embed openvscode-server as the editor pane. That's heavier and less integrated. Decide after v1, once we know which viewers are actually missing.

## Milestones (each one usable on its own)

1. **blimpd + install script.**
   - Check: run the install script on a fresh Debian container; `blimpd sessions` over SSH matches `claude1 ls` on claude1.
2. **Mac app with sessions sidebar and terminal.**
   - Check: attach to a running session from blimp and from `claude1` at the same time; typing in either shows in both.
3. **Status, notifications, ⌘K, tabs.**
   - Check: a session that asks a question shows as waiting within 5 seconds, and a Mac notification fires.
4. **Files: tree, Monaco editing, Markdown / image / PDF viewers.**
   - Check: edit and save a notes file in blimp, and `git diff` on the server shows the change. Claude edits an open file, and the reload prompt appears.
5. **Open-source release:** README, license, signed Mac build, GitHub releases.
   - Check: someone other than Max follows the README from zero to a working app.

## Risks

- **Claude Code internals:** status files and transcript titles are not a public API. The hooks fallback covers status. If titles break, blimp falls back to the first prompt.
- **Typing lag** is the same as SSH (about 40 ms to claude1). The app can't fix network distance. Local echo is a possible later experiment.
- **zmx is young** (v0.5). Check its license fits blimp's, and keep the "attach to a session" layer small so it can be swapped for tmux or something else if needed.
- **A signed and notarized Mac build** needs an Apple Developer account ($99/yr) so other people can open it without warnings.

## Decided

- **Name:** blimp. The server part is `blimpd`.
- **License:** MIT.
- **Repo:** GitHub `mbeato/blimp`, private until the milestone 5 release. The code lives on the claude1 server, and the Mac app is built on the Pro or the Air.
- **Connection:** plain SSH. Tailscale is optional.
- **Editing in v1:** Monaco. Embedding the full VS Code is decided after v1.
