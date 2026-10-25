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

What they count and list, across all projects, by the rules of `Inbox` (BlimpKit `Inbox.swift`; the Mac's
`app/src/lib/inbox.ts`):

1. Needs you: running sessions waiting on you, or done with a question in their note, and unread past conversations
   with a question. The oldest wait first.
2. New (the inbox's "Finished, not read yet"): done and unread, the note not "in progress", and unread past
   conversations without a question. The newest first.
3. Working: Claude working on it now, the longest-running first.

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
  a working row's time, the project's two letters (as the drawer's column has them). A tap on a running session's
  row opens its chat, as a tapped notification does; on a past conversation's, its project's inbox.
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
  `{ at, counts: { needs, new, working }, rows: [{ id, kind: "session" | "past", session?, sessionId?, dir, title,
  state: "needs" | "new" | "working", since }], lastFinished? }`. At most 9 rows (the large widget). `since`: ms,
  when it started waiting or working. Built from the session list, the past conversations and hidden.json, by the
  inbox's rules above; a new `src/widget.ts`, with the rules beside the inbox's.
- The widget key: HMAC-SHA256 of the phone's token with the text `blimp widget`, hex. blimpd works it out from the
  phone token it has (`readPhoneToken`); the phone from the one it was paired with. It is accepted only for
  `GET /widget`; anywhere else it is refused like a wrong token. Pairing again changes the phone token and so this
  key.
- Widget push tokens: `POST /push/widget { token, env }` and `DELETE /push/widget { token }` (phone token), kept in
  push.json beside the devices (mode 600).
- The pinger: in the push watcher (`src/push/watch.ts`), which already lists the sessions every second while a key
  and a phone are set. It works out the summary only when there is a widget token.

## The phone

- A widget extension, `BlimpWidgets` (bundle id `dev.blimp.phone.widgets`), in `ios/project.yml`, embedded in the
  app, iOS 26. It has the six widget views, one timeline provider and the push handler.
- An App Group, `group.dev.blimp.phone`, shared by the app and the extension: a file `widget.json` with the server's
  URL, the widget key, the last summary and its time, and the widget push token for the app to send.
- The app writes the URL and widget key there when it pairs or starts, reloads the widgets when it opens or goes to
  the background, and sends a new widget push token (`POST /push/widget`) when it finds one there.
- The push handler (iOS 26's `WidgetPushHandler`, set with `.pushHandler(...)`; the names checked against the iOS
  26.5 SDK when planning) writes the token to `widget.json`. So after adding a widget, it reaches blimpd the next
  time the app is open.
- Taps: the widgets link to `blimp://open?session=<name>` or `blimp://open?dir=<dir>`. The app registers the
  `blimp` scheme and opens them as it opens a tapped notification's session. Pair links (`blimp://pair?...`) stay
  as they are: pasted into the pair screen.
- BlimpKit, with tests: the summary's model, the counts line, the row text, "All quiet", and the link's URL both ways.

## Apple

- The extension's bundle id, the App Group and push for the extension. CI signs with the App Store Connect key
  (Admin) and `-allowProvisioningUpdates`, which should register them. If the first TestFlight upload fails on
  them, Max registers them once on developer.apple.com; ios/README.md gets the steps.

## Tests

- Server (`bun test`):
  - widget.test.ts: needs you, new and working by the inbox's rules (a waiting session; a done one with a question
    note; one with an "in progress" note left out; unread past conversations with and without a question; a past
    one a running session has open left out); hidden projects left out; the order across projects; at most 9 rows;
    lastFinished.
  - server.test.ts: `GET /widget` with the widget key, and the phone's and Mac's tokens; the widget key refused on
    another route; a different phone token gives a different key; `POST`/`DELETE /push/widget`, 400 on a bad token,
    push.json mode 600.
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
- SECURITY.md: the widget key (reads titles and counts only) and titles on the lock screen.
- ios/README.md: the widgets, and the Apple step if it's needed.

## Not in this change

- The live tracker and Claude's to-do steps (part 2).
- Buttons in widgets (Allow and Deny): notifications have them.
- Picking a project for a widget.
- Widgets on the Mac.
