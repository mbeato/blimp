# Phone: widgets on the home screen and the lock screen

Date: 2026-10-25. Branch `phone-widgets`. Part 1 of 2: the widgets. Part 2, a live tracker on the lock screen and
in the Dynamic Island for a turn you start from the phone, with steps from Claude's to-do list, gets its own spec.

## Why

Max wants to see what's happening without opening the app: what needs him, what finished, what's working and for
how long. He usually has several sessions going across projects (10/25: 13 sessions in 4 projects, 3 working, 1
waiting), and some stay working for days, so the widgets summarise every session rather than follow one.

## What other apps do (research, 10/25)

- Coding-agent apps: Cursor and GitHub Mobile put a Live Activity on the lock screen per agent task (in progress,
  waiting for you, finished). ChatGPT/Codex has a Tasks widget: rows of a state icon, the title and the project.
  Claude's iOS app has neither.
- A Live Activity lasts 8 hours at most and is for one thing in progress; a widget is always there but iOS decides
  when it refreshes (a budget, typically 40-70 a day, not published). Hence the split: widgets for the overview
  (this spec), the live tracker for a turn you follow (part 2).
- iOS 26 lets a server ask WidgetKit to reload a widget with a push (`apns-push-type: widgets`, topic
  `<bundle id>.push-type.widgets`, body `{"aps":{"content-changed":true}}`). It carries no data; the widget fetches
  its own. It is budgeted and best effort (one July 2026 forum report of dropped pushes).

## Decisions

- Widgets show every project's sessions (hidden projects left out) by the inbox's rules and words, so their counts
  match the app.
- Home screen: small, medium and large. Lock screen: inline, circular and rectangular.
- blimpd pings the widgets when what they show changes: a new "needs you" at once, anything else at most once every
  2 minutes. The widgets also refresh about every 15 minutes, and the app reloads them when it opens or leaves.
- The widgets read the server with a second key that can only read their summary (the widget key), so the phone's
  key, which can run commands, stays as it is: in the keychain, readable only while the phone is unlocked.

## The widgets

What they count and list: every project's running sessions, by the rules `Inbox` (BlimpKit `Inbox.swift`; the
Mac's `app/src/lib/inbox.ts`) gives each session. Past conversations with no session running stay in their
project's inbox, as the drawer's project marks leave them out too (and reading every project's history each second
would cost more than it's worth):

1. Needs you: running sessions waiting on you, or done with a question in their note. The oldest wait first.
2. New (the inbox's "Finished, not read yet"): done and unread, the note not "in progress". The newest first.
3. Working: working on it now, the longest-running first.

Each state has its own symbol (? needs you, ✓ new, ● working), so a widget reads right when iOS tints it one colour
(the iOS 26 accented and glass looks). A working row's time counts up by itself (`Text(timerInterval:)`), with no
refresh.

### Home screen

```
small                  medium (4 rows; large about 9)
┌──────────────┐       ┌────────────────────────────────────┐
│ ? 1 needs you│       │ blimp             ? 1   ✓ 2   ● 3  │
│ ✓ 2 new      │       │ ? Linking Linear cards          CQ │
│ ● 3 working  │       │ ✓ Folder browser                BL │
└──────────────┘       │ ● PR Overnight Fixes      12m   BL │
                       │ ● Fixing Slack bot         2d   CQ │
                       └────────────────────────────────────┘
```

- Small: the three counts. A tap opens the oldest that needs you, or the app if nothing does.
- Medium and large: the counts, then rows in the order above, as many as fit. A row: the state's symbol, the title,
  a working row's time, the project's two letters (as the drawer's column has them). A tap on a row opens its chat,
  as a tapped notification does.
- Nothing needs you, is new or works: "All quiet" and when the last session finished.

### Lock screen

- Inline, above the clock: `? 1 · ✓ 2 · ● 3`.
- Circular: the needs-you count with ?; with none, the working count with ●; with neither, ✓.
- Rectangular: the counts, then the top two titles. Titles show on the locked phone, as notifications' text does
  today; SECURITY.md says so.

### When the server can't be reached

The widget shows the last summary it had, greyed, with "as of 10:42". An older blimpd (no `GET /widget`): "Update
blimpd for widgets".

## How they stay up to date

```
blimpd, every second (the push watcher's session list)
  └─ the widgets' summary changed? ──> widget push (content-changed) ──> iOS reloads the widget
                                                                         └─ GET /widget (widget key)
the app, opened or sent to the background ──> WidgetCenter reload ─────────┘
the widget's timeline ──> reload after 15 minutes ─────────────────────────┘
```

- What counts as a change: the counts, or the rows' ids and states in order. A working row's time is not a change.
- When: a needs-you row that wasn't there is pinged at once. Any other change is pinged 2 minutes after the last
  ping at the earliest (one ping then covers everything since). No widget token: nothing is sent.
- The ping: the same push key and HTTP/2 connection as notifications (`src/push/apns.ts`), with
  `apns-push-type: widgets`, topic `dev.blimp.phone.push-type.widgets`, priority 5, body
  `{"aps":{"content-changed":true}}`. A token Apple says is gone is removed, as a device's is.
- Expect minutes, not seconds: iOS decides when the widget reloads.

## The server

- `GET /widget` (widget key, or the Mac's or phone's token):
  `{ at, counts: { needs, new, working }, rows: [{ session, dir, title, state: "needs" | "new" | "working",
  since }], lastFinished? }`. At most 9 rows (the large widget). `since`: ms, when it started waiting or working.
  Built from the session list and hidden.json by the rules above; a new `src/widget.ts`.
- The widget key: HMAC-SHA256 of the phone's token with the text `blimp widget`, hex, worked out by blimpd from the
  phone token it has (`readPhoneToken`). The app gets it with `GET /widget/key` (phone token) → `{ key }`, so the
  crypto and its tests stay on the server. It is accepted only for `GET /widget`; anywhere else it is refused like a
  wrong token. To change it: `blimpd pair --revoke`, then `blimpd pair` (a new phone token, and so a new key) and
  pair the phone again.
- Widget push tokens: `POST /push/widget { token, env }` and `DELETE /push/widget { token }` (phone token), kept in
  push.json beside the devices (mode 600).
- The pinger (`src/push/widgets.ts`): its own one-second tick beside the push watcher's, sharing its connection to
  Apple, and only while there's a push key and a widget token.

## The phone

- A widget extension, `BlimpWidgets` (bundle id `dev.blimp.phone.widgets`), in `ios/project.yml`, embedded in the
  app, iOS 26. It has the six widget views, one timeline provider and the push handler.
- An App Group, `group.dev.blimp.phone`, shared by the app and the extension, with two files so neither overwrites
  the other's: `server.json`, which only the app writes (the server's URL and the widget key, or none when blimpd is
  too old to have one), and `kept.json`, which only the widgets write (their last summary and their push token).
- Each time it's online, the app writes `server.json` (asking blimpd for the widget key), sends the widgets' push
  token (`POST /push/widget`, each time, as it sends the phone's own), and reloads the widgets; it reloads them too
  when it goes to the background. Signing out deletes `server.json`.
- The push handler (iOS 26's `WidgetPushHandler`, set with `.pushHandler(...)`; the names checked against the iOS
  26.5 SDK when planning) writes the token to `kept.json`. So after adding a widget, it reaches blimpd the next
  time the app is open.
- Taps: a row, and the small widget when something needs you, link to `blimp://open?session=<name>`; otherwise
  `blimp://open`, which just opens the app. The app registers the `blimp` scheme and opens the session as it opens
  a tapped notification's. Pair links (`blimp://pair?...`) stay
  as they are: pasted into the pair screen.
- BlimpKit, with tests: the summary's model, the counts line, the row text, "All quiet", and the link's URL both ways.

## Apple

- The extension's bundle id, the App Group and push for the extension. CI signs with the App Store Connect key
  (Admin) and `-allowProvisioningUpdates`, which should register them. If the first TestFlight upload fails on
  them, Max registers them once on developer.apple.com; ios/README.md gets the steps.

## Tests

- Server (`bun test`):
  - widget.test.ts: needs you, new and working by the inbox's rules (a waiting session; a done one with a question
    note; one with an "in progress" note left out; a read one left out); hidden projects left out; the order across
    projects; at most 9 rows; lastFinished; the widget key against a fixed value.
  - server.test.ts: `GET /widget` with the widget key, and the phone's and Mac's tokens; the widget key refused on
    another route; `GET /widget/key`, and a new phone token giving a new key; `POST`/`DELETE /push/widget`, 400 on
    a bad token, push.json mode 600.
  - The pinger: a new needs-you pinged at once; other changes no sooner than 2 minutes after the last ping; a
    working row's time alone pings nothing; no token, nothing sent; the headers, topic and body; a gone token
    removed.
- BlimpKit (`swift test`): decoding the summary, the counts line, row text, "All quiet", the link's URL.
- iPhone UI test: `testWidgetLinkOpensTheChat` opens `blimp://open?session=<name>` with the app running and lands
  in that chat. Widgets themselves can't be driven by UI tests; CI builds the extension.
- PHONE-CHECKLIST.md: add each widget; counts match the inbox; a new question shows within a few minutes with the app
  closed; a row's tap opens its chat; with blimpd stopped, "as of" and grey.

## Docs

- DESIGN.md: `GET /widget`, the widget key, widget push tokens and the pinger.
- SECURITY.md: the widget key (reads the widgets' summary only) and titles on the lock screen.
- ios/README.md: the widgets, and the Apple step if it's needed.

## Not in this change

- The live tracker and Claude's to-do steps (part 2).
- Buttons in widgets (Allow and Deny): notifications have them.
- Picking a project for a widget.
- Widgets on the Mac.
