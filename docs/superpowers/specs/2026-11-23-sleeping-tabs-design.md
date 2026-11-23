# Sleeping tabs: a browser tab nobody uses stops using memory

Date: 2026-11-23. Status: approved, not built (branch sleep-tabs). Size: M.

## Problem

Nothing closes a server browser tab. Tabs stay until Max closes them, and a restart of blimpd
reopens every one. Measured on Max's server on 2026-11-23: 25 tabs, Chrome at about 14 GB
(resident), on a server with 32 GB whose 16 GB of swap was full. 21 of the 25 tabs came from one
session, opened about a week before. That session's browser MCP held 1.8 GB more.

## Decisions

- **A tab nobody has used for 1 hour goes to sleep.** Its page in Chrome is closed, so it uses no
  memory. One number in the code (`SLEEP_AFTER`), no setting.
- **A sleeping tab stays in the list.** The Mac's tab strip and the phone's drawer show it dimmed.
  It keeps its folder, address, title and who opened it.
- **Opening a sleeping tab wakes it.** The page loads again at the same address. Logins stay (one
  profile). What was typed into the page and how far it was scrolled are lost, as after a restart
  of Chrome today.
- **A woken tab is a new tab to Chrome, with a new id.** blimpd answers the wake with the new id,
  and the apps put it where the old one was.
- **A tab keeps its place in the list** asleep, woken, and over a restart: the list is in the
  order the tabs were first made. Without that, each sleep and each wake would move the tab to
  the end of the Mac's strip.
- **To a session, a sleeping tab is a closed tab.** The MCP sees the page go. Claude opens the
  address again if it needs it. Sessions can't see or wake sleeping tabs.
- **Sleeping tabs are never removed.** Max closes them.
- **After a restart, only tabs used in the last hour load.** The others come back asleep. A
  restart loses the pages' state anyway, so nothing more is lost.

## What "used" means

A tab's `usedAt` is the last time one of these happened:

- **It was made** (a session's `Target.createTarget`, `POST /browser/tabs`, a page a page opened,
  or a wake).
- **A session's tool call named it.** Measured with `chrome-devtools-mcp@1.11.0` (2026-11-23):
  every tool call that acts on a page sends one `Target.getDevToolsTarget { targetId }` for that
  page before anything else: `take_snapshot`, `take_screenshot`, `evaluate_script`, `click`,
  `hover`, `press_key`, `wait_for`, `navigate_page`, and also `list_console_messages` and
  `list_network_requests`, which send nothing else. `list_pages` and `select_page` send it for the
  session's selected page. So the gate counts `Target.getDevToolsTarget` from a client as use of
  that tab, and nothing else from a session.
- **A view of it opened or closed** (`GET /browser/tabs/<id>/view`). While a view is open, the tab
  doesn't sleep at all: the Mac holds a view only for the tab on screen in a window that isn't
  hidden, and the phone only while the app is in front.

What does not count, and why:

- Any other command from a session. An untouched page that keeps loading frames makes the MCP
  send `Storage.getStorageKey` and `Debugger.setBlackboxExecutionContexts` about once a second
  (measured: 51 and 38 in 40 s on a page with one frame that reloads every 2 s). A new session's
  MCP sends some 35 setup commands to a tab it attaches to. Counting those, busy pages would never
  sleep, and every session start would wake a folder's whole clock.
- What the page does by itself (requests, navigation, a new title).

`chrome-devtools-mcp` is pinned (`MCP_PACKAGE`). A test with the real MCP checks that a tool call
moves `usedAt`, so a later version that stops sending `Target.getDevToolsTarget` fails the test
and doesn't put tabs to sleep under a session.

## How it works

**Gate** (`src/browser/gate.ts`): each target has `usedAt` and `madeAt` (ms). `usedAt` is set
when the gate claims the target for a folder, on a client's `Target.getDevToolsTarget` for a tab
the client can see, and by `touch(id)` (the service, for views). `madeAt` is when the tab was
first made, and never changes. `createTab` takes both, so a restored or woken tab keeps its own;
`times(id)` reads them. Neither is sent to the apps.

**Service** (`src/browser/service.ts`):

- `asleep`: the sleeping tabs, `{ id, folder, url, title, openedBy?, asleep: true }` and their
  `madeAt`. A sleeping tab keeps the id it had awake, so the apps' saved order still fits, and no
  live tab can get that id.
- `browserTabs()` is the live tabs and the sleeping ones, oldest `madeAt` first (a live tab whose
  id is in `asleep` is left out, for the moment between the two). It lists sleeping tabs when
  Chrome isn't running too.
- `sleepIdleTabs(now, after = SLEEP_AFTER)`: every live tab with no open view and
  `now - usedAt > after` is added to `asleep`, then closed in Chrome. A timer calls it once a
  minute while Chrome runs. Tests call it with their own `after`.
- `wakeTab(id)` → the new id: takes the tab out of `asleep`, starts Chrome if it isn't running,
  and opens the address in the tab's folder with its `openedBy` and its `madeAt`, so the list
  never shows both and the new tab is where the old one was. If that fails, the tab goes back
  to `asleep` and the error goes to the caller. Two wakes of one tab at once get the same answer.
  404 for an id that isn't asleep.
- `closeTab(id)` on a sleeping tab removes it.
- `viewTab` counts the open views of each tab and touches the tab as a view opens and closes.
- `tabs.json` rows become `{ folder, url, openedBy?, usedAt?, madeAt?, id?, title?, asleep? }`,
  in the list's order. Rows from before this change have no `madeAt`: they keep the file's order,
  before any new tab. Sleeping
  rows have `id`, `title` and `asleep: true`. It's written as now (half a second after a change),
  and by the minute timer when a `usedAt` changed. With Chrome not running, a write keeps the
  file's awake rows.
- Start (blimpd, or Chrome after it died): rows with `asleep`, and awake rows whose `usedAt` is
  over an hour old or missing, go to `asleep` (a row with no `id` gets a made-up one). The rest
  are opened. A file from before this change has no `usedAt`, so the first start after the update
  brings every tab back asleep. Chrome starts with blimpd only if a row is left to open.

**HTTP** (`src/server.ts`): `POST /browser/tabs/<id>/wake` → 200 `{ id }` (the new one), 404 for a
tab that isn't asleep, 503 without Chrome. `BrowserTab` gets `asleep?: true`, in `GET
/browser/tabs` and the events socket's `browser` message. The view route still answers 404 for a
sleeping tab.

**Mac app**: `BrowserTab.asleep`. A sleeping tab in the strip is dimmed, and its tooltip says it's
asleep. When a sleeping tab is the one on screen (clicked, or already in front when the window
shows again), the app wakes it: "Waking…" in the pane, then the new tab takes the old one's place
in front and in the dragged order (`pageOrder`). A wake that fails shows the error with Try Again.

**Phone app**: `BrowserTab.asleep`. A sleeping tab's row in the drawer is dimmed. A tap wakes it,
then opens the new tab. A phone app from before this change lists sleeping tabs but can't open
them (the view answers 404 and closes).

## Not now

- A setting for the hour.
- Removing sleeping tabs after some days.
- Sleeping by memory pressure, not time.
- Stopping Chrome when every tab is asleep. A Chrome that stops takes the sessions' MCP
  connections with it, and the MCP doesn't reconnect.
- Letting a session see or wake sleeping tabs.
- The memory of the sessions and their MCPs. When its pages close, an MCP drops what it kept of
  them; whether the process gives the memory back is Node's business.

## Tests

Server, with a real Chrome (they skip without one), in `test/browser-gate.test.ts` and
`test/browser-service.test.ts`:

- `Target.getDevToolsTarget` from a client moves the tab's `usedAt`; `Storage.getStorageKey` on
  its session doesn't.
- A tab past the limit sleeps: its Chrome target is gone, a client is told it's destroyed,
  `browserTabs()` has it with the same id and `asleep`, and so does `tabs.json`.
- A tab with an open view doesn't sleep. A tab used inside the limit doesn't.
- `wakeTab` gives a new id, in the same folder at the same address with the same `openedBy`, at
  the same place in the list (between two other tabs), and the old id is gone. A second wake of the old id is 404. Two at once give one tab.
- Closing a sleeping tab removes it from the list and the file.
- Over a restart: a sleeping tab stays asleep and isn't loaded; a tab used a moment ago loads; a
  row with no `usedAt` comes back asleep.
- With the real MCP (skips without npx): a tool call on a page moves that tab's `usedAt`.
- `test/server.test.ts`: the wake route's 200, 404 and the `asleep` field in the list.

App: a unit test for putting the new id where the old one was in the order. iOS: `BrowserTests`
decodes `asleep`. Both checklists get an item.

On Max's server after the update: Chrome's memory before and after, reported as measured.
