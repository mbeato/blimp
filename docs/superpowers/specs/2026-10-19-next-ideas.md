# Next ideas (after rc.5)

Date: 2026-10-19. Status: 1, 3 and 4 are built (rc.6), with these differences: a folder downloads as `.tar.gz` rather than `.zip` (`tar` is on every server; a Mac opens it with a double-click), and a browser tab has Reload and Open in Browser but no Back and Forward (the page is another origin, so blimp can't read or steer its history). 2 is built too (v0.2.0): updates from `latest.json` on the latest plain release, signed with the updater key; prereleases don't reach installed apps (no beta channel yet). 5 is still a proposal. Max asked for these after trying rc.5. Each one
says what it does, how it would work, what's open, and a rough size (S: an afternoon, M: a day or
two, L: a week or more).

Suggested order: 1, 2, 3 and 4 make the app you use better now. 5 is a separate product.

1. Split groups you can see (S)
2. Check for updates in the app (M)
3. Files: download and upload, by right-click and by drag (M)
4. Browser tabs for the server's web pages (M)
5. Hosted blimp: one main server, a worker per person (L)

---

## 1. Split groups you can see (S)

**Problem.** With splits it isn't clear which sessions are on screen together. Today the session
list only shades shown rows a little, and nothing says that a session was moved to another window.

**Proposal.**
- **The session list shows the group,** as VS Code's terminal list does: the sessions on screen
  come first, in left-to-right order, joined by a line on their left (┌ ├ └), with a small split
  icon. The focused split's row is the strongest. Sessions that aren't on screen follow, as now.
- **Numbers.** Each split's header and its row show its place (1, 2, 3) so the two are easy to
  match.
- **One accent per group.** The headers of the splits on screen get a thin top line in one
  color; a row in the group shows the same color.
- **Open in another window.** A session that a different blimp window shows gets a small window
  mark and "In another window" on hover. Clicking it brings that window forward instead of
  showing the session here twice.
- **Project tabs** show how many splits they have when there's more than one (for example "api ·2").

**How.** 1 to 4 are UI only (TerminalPane, the tab bar, CSS). 5 needs each window to tell Rust
which sessions it shows (like `set_viewing`, but kept while the window is in the background),
and a Rust event when that changes, so other windows can mark the rows.

**Open.** Should a click on a session that is in another window move it here instead? Proposal:
bring the other window forward; dragging still moves it.

---

## 2. Check for updates in the app (M)

**Problem.** Every release means downloading the `.dmg` again and dragging the app to
Applications.

**Proposal.** "Check for Updates…" in the blimp menu, and a quiet check at launch (then once a
day). When there's a newer release: a bar at the top, "blimp 0.2.1 is ready. Restart to update".
The app downloads it, checks its signature, replaces itself and restarts.

**How.** Tauri's updater plugin (`tauri-plugin-updater`):
- The release workflow also builds the update bundle (`createUpdaterArtifacts`) and a small
  `latest.json` (version, notes, download URL, signature), and uploads both to the GitHub release.
- Updates are signed with an **updater key** (a key pair made once; the private half becomes a
  repo secret, the public half goes in `tauri.conf.json`). This is separate from Apple's signing:
  it proves the update came from this repo's release workflow. It works for unsigned builds too.
- The app reads `latest.json` from a fixed URL (for example
  `https://github.com/mbeato/blimp/releases/latest/download/latest.json`).
- **Channels.** GitHub's "latest" skips prereleases. Release candidates would need their own
  `latest.json` (for example kept in a `beta` release that each rc updates), and a "Get beta
  updates" choice in the app.

**Also: blimpd on the server.** The app already knows blimpd's version (`/health`). When it's
older than the app's, a bar could offer "Update blimpd on <server>". That runs the install script
over the existing SSH connection, then reconnects. Sessions survive it (zmx keeps them).

**Open.**
- **The repo is private.** The app can't read `latest.json` from a private repo's releases
  without a token. So either the repo goes public first (already planned), or the files go
  somewhere public (an S3 bucket, GitHub Pages).
- **Unsigned builds.** The updater doesn't mark what it downloads as "from the internet", so
  macOS shouldn't block the new version. This needs checking on a Mac. With Apple signing set up,
  it's a non-issue.

---

## 3. Files: download and upload (M)

**Problem.** Getting a file off the server, or onto it, means `scp` in a terminal.

**Proposal.**
- **Download.** Right-click a file or folder in the tree: **Download**. It saves to `~/Downloads`,
  as a browser does, and shows "Downloaded name.zip — Show in Finder". A folder comes down as a
  `.zip`. The open file's tab gets Download in its right-click menu too.
- **Upload by drag.** Drag files or folders from Finder onto the window. Over the tree, the folder
  under the pointer lights up and they go there. Anywhere else, they go to the folder last
  clicked in the tree (as New file does).
- **Upload by menu.** Right-click a folder: **Upload…** opens the Mac's file picker.
- **A name that's already there** asks: Replace, Keep both ("name 2.png"), or Skip. Nothing is
  overwritten without asking.
- **Progress.** Big transfers show a small progress row at the bottom of the tree, with Cancel.
- **Drop onto the terminal (an idea).** Dropping a file, like a screenshot, onto a Claude
  session uploads it into the project (or `~/.blimp/uploads/`) and types its path into the
  prompt. Claude reads images by path, so this is how you'd hand it a screenshot.

**How.**
- **blimpd.** Today `GET /fs/file` reads at most 50 MB into memory, and `PUT /fs/file` takes the
  whole body and overwrites. New routes:
  - `GET /fs/download?path=`: streams a file of any size, or a folder as a zip, built on the fly.
  - `PUT /fs/upload?path=&mode=new|replace`: streams the body to a temp file, then renames it into
    place. `new` gives 409 if the name exists. There's a size cap (for example 2 GB) and a check
    for free disk space.
  - Both use the same `guard()` as the other file routes: inside home only, with symlinks
    resolved.
- **The Mac app.** Rust does the transfer, not the page, so large files never sit in the page's
  memory. It streams over the tunnel to or from disk, and sends progress events to the page.
  Drops from Finder come from Tauri's own drag-drop event, which gives the paths and the
  position, so the page can tell which tree folder was under the pointer. That event doesn't
  interfere with the session drags, which use pointer events.
- **Security.** Upload names come from the Mac's files and are checked (no `/`, `..` or empty
  names). The zip is made on the server from real paths under home, and never follows a symlink
  out of home. SECURITY.md gets the new routes.

**Open.**
- Dragging a file out of the app into Finder is possible, but needs a native drag plugin. Later.
- Should a big download go through the browser build too? Proposal: the Mac app only.

---

## 4. Browser tabs for the server's web pages (M)

**Problem.** When Claude starts a dev server on the box (`localhost:3000`), there's no way to see
it from the Mac without a manual `ssh -L`.

**Proposal.**
- **Ports.** blimpd notices programs on the server that start listening on a local port (it
  reads `/proc/net/tcp`). The app then says "Port 3000 is open. Open it?", as VS Code Remote does.
  A **Ports** list (in the bottom pane, or the + menu) shows them all.
- **Browser tabs.** Opening one adds a browser tab next to the file tabs. It shows the page as if
  it ran on the Mac: address bar, back, forward, reload. You can open it in Safari or Chrome
  instead, at `http://localhost:<a local port>`.
- The page draws on the Mac, so it's as fast as a local site.

**How.**
- The app already holds one SSH connection per server. Each port opened gets its own local
  forward (`ssh -L`) on that connection, or one more ssh child per port, closed when the tab
  closes.
- The tab is a **separate webview**, not an iframe in blimp's page. So the site can't reach
  blimp's page or its blimpd token, and blimp's strict content rules don't break the site.
- **Later, only if wanted: a real browser on the server.** A headless Chromium on the box,
  streamed to the tab. It's only worth it to watch the same browser Claude drives (Playwright)
  or to keep logins on the server. It's slower and a lot more work.

**Open.**
- One forward per port, or one SOCKS proxy for everything? Proposal: per port. It's simpler, and
  the URL shows exactly what's open.
- The ports list has to filter out the server's own services (sshd, databases, blimpd itself).
  The proposal is to show only ports opened by programs running inside blimp sessions.

---

## 5. Hosted blimp: one main server, a worker per person (L)

**Idea.** Others use blimp without running their own server. A main hosted server handles
accounts. Each person gets a worker (an E2B sandbox or an EC2 machine) that runs blimpd and their
Claude sessions, and pauses or stops when nobody uses it.

**What stays the same.** blimpd already is "the program on the box". A worker is a box with
blimpd, zmx and Claude Code on it. The app, the sessions, files and splits all work as now.

**What's new.**
- **Main server.** Sign-in, a person's workers ("workspaces"), and starting, pausing and stopping
  them. The app connects to it over HTTPS and WebSockets instead of SSH, and it passes the
  connection through to the person's worker.
- **Pausing.**
  - E2B can pause a sandbox with its memory and resume it later, so running sessions survive.
  - A stopped EC2 machine keeps its disk but not its running programs. Claude's conversations
    are on disk, so they'd show under Earlier and resume. That may be enough.
  - Pause only when every session is idle and nobody is connected. A session waiting for you
    keeps its worker up, or its notification would never come. blimpd already knows the states.
- **Repo and notes.**
  - The code comes from git: the first start clones the repo (with the person's GitHub sign-in).
  - Things outside git (a notes folder, Claude's own files and settings, shell history) need a
    disk that lasts, or a sync to S3 when the worker pauses or stops and back when it starts.
    The sandbox is the working computer; S3 is the saved copy.
- **Claude sign-in.** Each person signs in to Claude Code with their own account on their own
  worker. The sign-in is stored for them, never shared.
- **Security.** Today one token means a full shell on the box. That's fine for your own server.
  Hosted, each person needs a real account, a worker no one else can reach, and the main server
  must never be able to read their token.
- **Cost.** Idle workers stop, and blimpd's states are the signal.

**Before that: teams without hosting.** A teammate can run the install script on their own EC2
machine and add it in blimp today. A short "Set up blimp on EC2" guide in the README covers
that, with no new code.

**Open.** Who it's for (your team, or anyone), what a worker costs per person, E2B or EC2, and
how much of `~` to save between runs.
