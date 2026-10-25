# Phone: open a folder from the computer, and a clearer drawer

Date: 2026-10-25. Branch `phone-open-folder`.

## Why

- Hide (10/24) takes a project off the phone's strip. There is no way back, and no way to start in a folder
  Claude has never run in: the strip only lists folders with running sessions or Claude transcripts. The Mac
  has ⌘O (Open Folder, with Browse and New folder); the phone has nothing.
- Max finds the drawer's top unclear: "+" beside the project's name means New session, but reads like "add a
  project". He asked for the pieces to follow common practice.

## What other apps do (research, 10/25)

- Switching containers: workspace apps put it top left, as an icon column (Discord) or a tap on the
  workspace's name (Slack, Notion, Teams). No app found uses a sideways row.
- Adding a container: the last item of the container list (Discord's + under its icons, Slack's Add a
  Workspace).
- New item: one labelled, always-visible button.
- Settings: the drawer's bottom or behind the profile; never at the end of the switcher.
- Coding-agent apps (Happy, Claude Code, Codex, Cursor, GitHub) pick a known project or type a path; none
  browses the computer's folders or makes one from the phone. Happy's "known places, then one more action row"
  is the closest shape.

Thin or pre-2025 evidence: ChatGPT, Claude chat, Slack's compose button.

## Decisions

- The drawer goes back to an icon column down its left side (Max's pick over "tap the project's name" and
  "keep the row"). The column existed on 10/23 and became a row on 10/24 for no particular reason (Max, 10/25).
- The column's foot has + (open a folder) and Settings. New session leaves the header for a labelled button
  above Active.
- The folder browser is folders-first, starts at home, and has New Folder and Open.
- blimpd remembers opened folders, so one you opened stays in the column before Claude has run there, and the
  Mac's recent folders list it too.
- Opening a hidden folder shows it again: the inverse of Hide.

## The phone

### The drawer

```
┌────┬─────────────────────────┐
│[BL]│ blimp                   │
│ BM●│ ┌─────────────────────┐ │
│ AS │ │ +  New session      │ │
│ CQ │ └─────────────────────┘ │
│ AP │ ACTIVE                  │
│    │  ● fix push crash       │
│    │ BROWSER                 │
│    │  + New Tab              │
│    │ › Earlier  12           │
│┌╌╌┐│                         │
│╎+ ╎│                         │
│└╌╌┘│                         │
│ ⚙  │                         │
└────┴─────────────────────────┘
```

- The column, 60 pt wide: each project's two letters and mark (as today), the one shown lit; a tap shows its
  inbox behind the drawer, which stays open; press and hold has Hide. The order is held while the drawer is
  open (`Strip.held`), so an icon never moves under a finger. More than fit: the icons scroll up and down.
- The column's foot, outside the scroll so always in sight: a + tile the icons' size with a dashed outline
  (accessibility "Open a folder", id `drawerOpenFolder`), then the gear (`settingsButton`).
- The right side: the project's name (no + beside it any more), then a full-width New session button
  (`drawerNewSession`, as today: it closes the drawer and shows the inbox with its box ready to type), fixed
  above the list, then Active, Browser, Earlier as today.
- A sideways swipe anywhere in the drawer closes it, the column too (the row's exception and `StripFrame` go).
- No projects at all (a fresh blimpd): the right side says "Open a folder on the computer to start." with an
  Open a Folder button; New session isn't shown there; the empty state's one action is Open a Folder.

### The folder browser

```
┌──────────────────────────────┐
│             code      Cancel │
│              ~/code          │
├──────────────────────────────┤
│ ▢ api-server               › │
│ ▢ blimp                    › │
│ ▢ brain-memory             › │
│   notes.txt                  │  greyed, no tap
├──────────────────────────────┤
│ New Folder        Open code  │
└──────────────────────────────┘
```

- + opens it as a sheet over the drawer, at the server's home folder (`/health`'s `home`, kept in the Store
  beside `serverVersion`).
- A navigation stack, one level per folder: a tap on a folder goes in, the back button or a swipe back goes up.
  The top level is home (blimpd's `/fs/*` only reach inside home). Title: the folder's name; under it the path
  with `~` for home. Cancel is at the top right on every level, since the back button takes the left.
- Each level lists its folders, A to Z as blimpd sends them, then its files greyed and not tappable, so you can
  tell where you are. Names starting with "." are left out, folders and files: on a phone they would fill the
  first screen of home.
- "No folders here." when there are none. A listing that fails shows why in the list (Store.words).
- The bottom bar: New Folder and Open \<this folder's name\> (prominent).
- New Folder asks for a name in an alert with a text field. Empty: nothing happens. Containing "/" or being "."
  or "..": "A name can't contain / or be . or .." (the Mac's words). Taken (409): "\<name\> already exists."
  Both show in a "Couldn't do that" alert. Made: the browser goes into it.
- Open: `POST /folders/opened`, then the sheet closes and that project shows as if its icon was tapped: its
  inbox behind the still-open drawer, its icon first in the column (the held order puts a newly opened project
  first, not last), and it leaves the hidden list on the phone at once. If blimpd refuses (an older blimpd's
  404, offline), "Couldn't do that" with why, and the sheet stays.

### Code

- BlimpKit, with tests:
  - `DirEntry` and `DirListing` models for `GET /fs/list`.
  - `Folders.shown(_:)`: the folders and the files to show (no dot names).
  - `Folders.nameProblem(_:)`: the New Folder message, or nil.
  - `Folders.label(path:home:)`: `~/code`.
  - `Strip.held` gains the shown project: one not in the held order goes first.
- `API`: `list(path:)`, `makeFolder(path:)`, `openFolder(dir:) -> [RecentFolder]`.
- `Store`: `serverHome` from `/health`.
- `FolderBrowserView` (new view file).
- `DrawerView`: the column, the foot, the header and New session button, the empty state; `StripFrame` goes.
- `HomeView`: the sheet, and `openFolder(dir)`. It sets `folders` from the reply, takes dir out of `hidden`,
  sets `store.dir` and `opened = .inbox`, and closes the sheet.

## The server

- `src/opened.ts`, beside `hidden.ts`: `<socket dir>/opened.json`, `{ "dirs": [{ "dir": string, "at": number }] }`,
  mode 600, written through a temp file as hidden.json is. At most 30 kept, newest first. Opening one already
  there moves it to the front with the new time.
- `POST /folders/opened` `{ "dir": string }`:
  - 400 unless `dir` is a full path to an existing folder inside home (guardList and a folder check).
  - Otherwise it shows the folder again (`setHidden(dir, false)`), records it, and replies with
    `GET /folders/recent`'s list.
- `recentFolders` takes the opened list too. An opened folder counts with `lastUsed` = the later of its open
  time and its newest transcript, unless it is hidden or gone. It isn't left out for being under a temporary
  folder, since you picked it. The cut to 30 comes after.
- The dir is kept as the phone sent it (the path `/fs/list` answered with), as hidden.json keeps its dirs.

## Tests

- Server (`bun test`, runs anywhere):
  - folders.test.ts: an opened folder is in the recent folders with its open time. A transcript newer than
    the open wins. Hidden or deleted, it's left out. One under /tmp still shows. The cut to 30 comes after
    the merge.
  - server.test.ts:
    - `POST /folders/opened`'s 400s: no dir, a relative dir, a missing folder, a file, outside home.
    - It shows a hidden folder again and lists the folder in its reply.
    - opened.json is mode 600.
- BlimpKit (`swift test`, on the Mac CI): the `Folders` rules and `Strip.held` with a shown project not in
  the order.
- iPhone UI test `testOpenFolder` (Mac CI):
  1. Open the drawer and tap +. The sheet lists home's folders.
  2. Go into `e2e-work` (setup.ts's work folder, inside home) and use New Folder with a unique name. The
     browser is in it and says "No folders here."
  3. Tap Open. The sheet goes, `drawerProject` is the name, and `strip-<name>` is in the column.
  4. Hide it, then open it again through the browser. It's back.
- Existing UI tests keep their ids (`drawerStrip`, `drawerNewSession`, `settingsButton`, `strip-<name>`). The
  ones that tap the header's + or rely on the row get checked on the first CI run.
- iOS CI: don't start a manual run while main's push run is going (they share the MacBook's runners and ports).

## Docs

- DESIGN.md: `POST /folders/opened`, opened.json, and what `GET /folders/recent` now merges.
- ios/README.md: the drawer and the folder browser.
- PHONE-CHECKLIST.md: open a folder, make one, open a hidden one.

## Not in this change

- The Mac's Open Folder dialog calling `POST /folders/opened`, so a folder opened on the Mac stays in its
  recent folders too.
- Starting the browser next to the current project instead of at home.
- A list of hidden projects to show again without browsing.
