# Phone: a live panel on the lock screen and in the Dynamic Island

Date: 2026-10-26. Branch `phone-live-activity`. Part 2 of the widgets work
(`2026-10-25-phone-widgets-design.md`): Max found the lock screen widgets too small to tell what's going on and
chose a Live Activity that does both: the overview of every session, and step-by-step progress for a turn he
starts from the phone.

## Why

iOS allows only small widgets on the lock screen (inline, circular, a two-line rectangle). A Live Activity is the
one thing that can be large there (the full-width panel ride and delivery apps use), and it also shows in the
Dynamic Island. blimpd already sends Apple pushes with Max's key, so it can start and update one with the app closed.

## What it shows

One Live Activity, "blimp":

```
┌────────────────────────────────────┐
│ ● Server update          BL  12:03 │  a turn started from the phone
│   ▓▓▓▓▓▓░░░░  Step 4 of 7          │
│   Running the tests                │
│ ? Linking Linear cards          CQ │  then the overview: needs you,
│ ? Choosing a card               BL │  new, working (the widgets' rules)
│ ● Fixing Slack bot         2d   CQ │
│ blimp             ? 2   ✓ 1   ● 3  │
└────────────────────────────────────┘
```

- The followed turn: a session Max sent a prompt to from the phone, until that turn ends. On top: its title, its
  project's two letters, a running timer, and, when Claude keeps a task list, "Step n of m", a bar, and the step in
  progress. Without a task list, just the timer.
- The overview below: the widgets' summary (`src/widget.ts`: needs you, new, working, hidden projects left out),
  as many rows as fit (3 under a followed turn, 4 without), then the counts.
- Dynamic Island: compact `?2` leading, `●3` trailing (the working count with a followed turn's timer when there is
  one); minimal `?` when something needs you, else `●`; expanded: the followed turn and the first rows.
- A tap opens the followed turn's chat, else the oldest that needs you, else the app (`WidgetLink`).
- Symbols and words as the widgets: ? needs you, ✓ new, ● working; one-colour-safe.

## When it shows

- It runs while something needs you or is working (or a followed turn runs), and ends after 10 minutes with
  nothing of either (dismissed at once).
- blimpd starts it with the app closed (push-to-start, which Apple makes show a banner: a quiet one, no sound,
  "blimp: 2 need you, 3 working"). With the app open, the app starts it itself (no banner).
- iOS ends an activity after 8 hours. At 7 h 45 min, if still busy, blimpd ends it and starts a new one (another
  quiet banner).
- Updates: when the content changes (the counts, the rows and their states, the followed turn's step); a timer
  ticking isn't a change. Priority 5, except a new needs-you (priority 10, no alert: notifications already ring).
- A switch in Settings, "Live panel on the lock screen" (on by default). Off: the app tells blimpd to forget its
  tokens and ends any activity.

## How

- **Tokens:** the app sends blimpd its push-to-start token (`Activity<…>.pushToStartTokenUpdates`, iOS 17.2+), and
  each activity's update token (`pushTokenUpdates`) when it gets one, including for an activity blimpd started
  (iOS wakes the app to hand it over). blimpd keeps them in push.json beside the devices and widget tokens. Not
  broadcast channels: those need another Apple capability and API, and tokens follow the pattern notifications and
  widgets already use.
- **Pushes:** `apns-push-type: liveactivity`, topic `dev.blimp.phone.push-type.liveactivity`, through the same
  connection and key. `event` start / update / end with a `content-state` that matches the Swift `ContentState`
  exactly (default JSON coding: times as numbers), under 4 KB (rows' titles cut to fit).
- **The followed turn:** blimpd marks a session followed when a prompt reaches it with the phone's token, and drops
  the mark when that turn ends: the session is done, or gone. Waiting on Max keeps the mark (the turn goes on).
- **Steps:** read from the session's transcript like `activity.ts` reads jobs: Claude Code's task list tools
  (`TaskCreate` for each step, `TaskUpdate` for status changes; `TodoWrite`'s whole list for older versions), giving
  done, total and the in-progress step's words. Checked against captured real lines in tests, as activity.ts is.
- **The runner:** a third tick beside the push watcher and the widgets' pinger (`src/push/`), only while there's a
  key and a push-to-start token: works out the content each second, decides start / update / end / restart, sends.
- **The app:** an `ActivityAttributes` type and its views in the widget extension (Live Activities live there),
  the token plumbing and the Settings switch in the app. BlimpKit holds the content model and its words, tested.

## Privacy

Titles show on the locked phone, as the widgets' and notifications' do; SECURITY.md says so. The switch turns it off.

## Tests

- Server: the content (followed turn on top, row limits, the 4 KB cap), the step reader on captured lines, the
  runner's decisions (start when busy, update on change only, end after 10 quiet minutes, restart at 7 h 45 min, no
  token no work, gone tokens removed), the token routes.
- BlimpKit: decoding the content state from blimpd's JSON, the words.
- The panel itself: CI compiles it; the phone checklist covers seeing it.

## Not in this change

- Buttons in the panel (Allow and Deny): notifications have them.
- Broadcast channels; the Mac.
