# Workbench layout (VS Code style)

Date: 2026-10-19. Approved by Max in chat ("yes build it", plus a plain shell option in New).

## What changes

The app stops being "a sidebar of every session + terminal tabs + a files pane on the side" and becomes one project per window, laid out like VS Code:

```
┌ top bar: [home] server · ~/blimp                    status ┐
├ Files ───────┬ App.tsx × │ README.md × ──────────────────────┤
│ ~/blimp  +f +d│                                              │
│ ▸ app        │   editor / viewer (autosaves)                │
│ ▸ src        │                                              │
│   README.md  ├──────────────────────────────┬───────────────┤
│              │  terminal (Claude or a shell) │ Sessions   +  │
│              │                               │ ● fix-ui      │
│              │                               │ ◐ docs        │
│              │                               │ ○ tests    🗑  │
│              │                               │ Earlier       │
│              │                               │  add markdown │
└──────────────┴───────────────────────────────┴───────────────┘
```

- **Left:** file tree of the project folder, full height. Buttons: new file, new folder. ⌘B hides it.
- **Top right:** one tab per opened file. With no files open (in a project), the terminal fills the right side.
- **Bottom right:** the selected session's terminal. ⌘J hides the bottom pane (only while files are open).
- **Session list (right edge of the terminal pane):** sessions whose folder is exactly the project folder, as `claude --resume` scopes to the folder.
  - Running first, newest first, with a state mark: working, waiting, idle. Shells get a `>_` mark.
  - Hover shows a trash button: ends the session (`zmx kill`). The conversation stays resumable.
  - "Earlier": the folder's past conversations that aren't running; a click resumes one in a new session.
  - "+" menu: New Claude session, New shell. ⌘N starts a Claude session here.
- **Home:** the window opens on the server's home folder with the same layout. With no files open, the editor area shows Welcome: recent projects for this server, Open Folder…, a server picker when there are several, Add server, and the offline/retry state.
- **Open Folder… (⌘O):** the existing folder picker (recent folders, browse, type a path) plus a New folder button while browsing. Opens in the current window, like VS Code; the project goes to the top of the recent list (stored on the Mac, per server).
- **Several windows:** ⌘⇧N opens another window (on Home). ⌘K lists every session on every server; picking one in another folder opens (or focuses) that folder's window with the session selected.

## Behaviour

- **Autosave:** 1 s after the last edit, and at once when the editor loses focus, the file tab changes, or the window blurs. Saves send the mtime the editor started from, so a file Claude changed meanwhile is not overwritten: the "Changed on the server — Reload / Keep mine" bar shows instead. A file with no unsaved edits reloads by itself when it changes on the server (already so). Closing a tab saves first; the "unsaved changes" prompt only appears if that save fails.
- **⌘-click a path in the terminal** (Ctrl-click off the Mac) opens it in a file tab, at `:line[:col]` if given. Paths are absolute, `~/…`, or relative to the session's folder; a link only appears for a file that exists (checked through `/fs/list` of its folder, cached briefly). URLs are left to the web-links addon.
- **Notifications across windows:** each window still runs the waiting watcher, but in the Mac app it asks the Rust side before notifying: one notification per (server, session, wait start), and none if any focused window is showing that session. The Dock badge is app-wide; every window sets the same count.
- The old sidebar, session tabs and NewSessionDialog conversation step go away; ⌘K and the per-folder lists replace them.

## Server (blimpd) additions

- `POST /sessions` takes `shell: true`: starts the login shell (`$SHELL -l -i`) in a zmx session instead of Claude. Names as before.
- `DELETE /sessions/<name>`: `zmx kill <name>`; 404 if no such session.
- `Session.kind`: `"claude"` when Claude's status file is found or the zmx command mentions claude, else `"shell"`.
- `POST /fs/mkdir {path}` and `POST /fs/create {path}` (empty file): the parent must exist inside home; 409 if the name exists. Same `guard()` as the other file routes.
- All behind the token, like everything else. SECURITY.md and DESIGN.md get the new routes.

## Mac shell (Rust)

- `open_window(query)`: focuses a window already showing that project (it gets a `select-session` event) or creates `w-<n>` loading `index.html?<query>`.
- `set_window_project(project)`: the window tells Rust what it shows (for the focus-or-create above).
- `claim_notice(key) -> bool` and `set_viewing(key | null)`: the notification dedupe above.
- Capabilities cover `main` and `w-*`.

## Build order (each step tested before the next)

1. blimpd: kind, shell sessions, DELETE session, mkdir/create. Unit + server tests.
2. App libs: recent projects store, path-link matching (pure, unit tested), window helpers.
3. Workbench: refactor FilesPane's Workspace into tree (left) + editor (top right) with a terminal slot; autosave.
4. TerminalPane: session list, new menu, trash, Earlier, path links.
5. App shell: home/project state in the URL, top bar, Welcome, Open Folder (+ new folder), ⌘K across windows, shortcuts.
6. Rust: windows + notification dedupe; menu items (New Window, Open Folder).
7. e2e: rewrite specs for the new layout; add autosave, Claude-edit reload, ⌘-click path, trash → gone from `zmx list`, new folder, shell session. Native run on WebKitGTK. Screenshots, README, then rc.4.

## Addendum, 2026-10-19: project tabs, show/hide buttons, terminal splits

Asked by Max after trying rc.4 ("tabs for the different projects", "the buttons to show/hide the left/bottom panes", "drag sessions from the right pane into the terminal to split screen them"), with his picks: side-by-side splits only, a third button for the session list, and tabs that reopen on the next launch.

- **Project tabs** replace the top bar's path: Home first (house icon, can't close), then one tab per folder, with × and middle-click to close and a waiting dot. Open Folder and Home's recent list open a folder in a new tab or bring its tab forward. Every open tab's workbench stays mounted (hidden), so files and terminals survive switching; only the tab in front takes ⌘P/⌘S/⌘W. Several tabs on one server share its events socket; blimpd watches the union of their watch sets.
- **⌘K** shows a session in its folder's tab here; if another window has the folder in a tab, Rust's `focus_project` brings that window forward instead; else the folder opens in a new tab here. Rust keeps every tab's folder per window (`set_window_projects`), and `set_viewing` takes the list of sessions on screen.
- **Show/hide buttons** at the top right: files (⌘B), terminal (⌘J, now also with no file open: the editor area then says how to open one), session list (⌘⌥B). The window's, not per tab.
- **Splits**: drag a running session from the list onto the left or right half of a split. Pointer events, not HTML drag and drop (WebKit and Tauri's file drop handling make that unreliable). A session already shown moves. Splits have a name header with × (closes the split only), resizable dividers, and a focused split for the keyboard; a list click focuses the split showing the session, else replaces the focused split's session.
- **Saved**: the layout (tabs with their splits, the tab in front, the three show/hide states) is in the URL as `layout=` and in the store as `layout`; a new start (no URL, no place from Rust) reopens it.
- Logic in `src/lib/tabs.ts` and `src/lib/panes.ts` (unit tested); `e2e/tabs.spec.ts` covers tabs, buttons and drag-to-split; the native run checks the buttons, a drag under WebKitGTK, `focus_project`, and tabs reopening after a restart.
- **Later the same day:** the session list is resizable (a splitter on its left edge), like the files and the splits. Right-click a session row or a split header: Open in New Window, and on a split, Open All Splits in New Window (both move the sessions; a session moved out isn't auto-picked here again). A drag let go outside the window moves the session: `drop_session` hit-tests the other windows (most recently focused first, from `Focused` window events) and hands the one under the point the place plus the point in its page (`drop-session`), else opens a new window there. New windows can start from a whole layout (`layout=` in their init), not just a place.
