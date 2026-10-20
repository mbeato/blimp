# blimp on the phone: notifications when the app is closed

Date: 2026-10-20. Asked by Max: "lets do 2" (push alerts, from the "Later" list of `2026-10-19-phone-app-design.md`). Decided with Max in brainstorming:

- **Only Max's phone.** blimpd sends straight to Apple with Max's own push key. No relay server. A relay for other people can be added later without changing the app's side.
- **Yes and No on the notification.** Yes needs the phone unlocked (Face ID). No works from the lock screen.
- **Quiet while Max is at the Mac:** if the Mac app was in use in the last 2 minutes, the phone waits. Still unanswered 2 minutes later, the phone gets it anyway.
- **When Claude asks, and when it finishes** a turn that ran 30 s or more.

## What's there today (facts the design rests on)

- blimpd's 1 s tick (`src/events.ts`) only runs while some `/events` socket is open. With the Mac and the phone both closed, nothing watches sessions. Push needs its own watcher that runs all the time.
- A session's `state` is `working`, `waiting`, `done` or `unknown`, with `stateSince` (ms) and, while waiting, a `prompt` (`src/prompt.ts`). A permission prompt's `options` come from Claude's screen; the first is Yes and the last is No.
- The phone answers through `/sessions/<name>/chat` with `{ type: "answer", id, at, pick, label }`. blimpd refuses it ("the question changed") if the wait or the option at `pick` changed. It types an id only once.
- The Mac app's `WaitWatcher` (`app/src/lib/waiting.ts`) already knows whether a blimp window is focused and which sessions it shows.
- The `/events` socket already takes one message from the client (`watch`).
- Bun 1.4.3 opens an HTTP/2 connection to `api.sandbox.push.apple.com` (checked 2026-10-20 on claude1).
- CI archives the app with `-allowProvisioningUpdates` and the App Store Connect API key, so a new entitlement can be added to the App ID by the build itself.

## 1. Setup (once, by Max)

1. In the Apple Developer site: Keys, +, "Apple Push Notifications service (APNs)", download the `.p8` file. Note its Key ID and the Team ID.
2. Copy it to claude1 and run `blimpd push-key <file.p8> --key-id <id> --team-id <id>`. blimpd copies the key to `~/.blimp/apns.p8` (mode 600) and writes `~/.blimp/apns.json` `{ keyId, teamId }` (mode 600). You can delete the original after.
3. `blimpd push-test` sends "blimp can reach this phone" to every registered phone and prints Apple's answer for each.

Without a key, blimpd sends nothing and says so once in its log. Everything else works as today.

## 2. The phone registers

- `ios/project.yml` gets the `aps-environment` entitlement (development for Debug, production for Release, so TestFlight builds use Apple's production service).
- After pairing and on every launch, the app asks for permission to notify (once; iOS remembers), calls `registerForRemoteNotifications`, and sends `POST /push/device { token, env: "development" | "production" }`. Sending it again is harmless.
- blimpd keeps devices in `~/.blimp/push.json` (mode 600): `{ devices: [{ token, env, at }] }`, at most 5, newest kept.
- Apple's answer `410` or `BadDeviceToken` / `Unregistered` removes that device.
- `blimpd pair --revoke` also empties `push.json`. Settings in the app has a "Notifications" switch: off sends `DELETE /push/device { token }`.

## 3. When blimpd sends

A push watcher in blimpd checks sessions every 1 s (the same `zmx list` and status files as `/events`), always, whether or not any app is connected. It notifies on two changes:

- **Asks:** a session becomes `waiting` with a new `prompt.at` (or `stateSince` when there's no prompt).
- **Finishes:** a Claude session goes from `working` to `done`, and it was `working` for 30 s or more.

Then:

- **Mac in use:** the Mac app sends `{ type: "active" }` on its `/events` socket while a blimp window is focused, at most once every 30 s. blimpd keeps the time of the last one. If it is less than 2 minutes old, blimpd holds the notification until 2 minutes after that time. When the time comes, it sends only if the session is still in the same wait (same `prompt.at`) or still `done` from the same turn.
- **Once each:** a wait is notified once (keyed by session and `at`), a finish once (keyed by session and `stateSince`). When blimpd starts, the states it finds count as already notified, so a restart doesn't repeat them.
- **The phone open on that chat:** blimpd still sends. The app hides it (section 4). blimpd can't know what's on the phone's screen.
- **Codex and shell sessions:** asks only, from Codex's hooks, same as the Mac. Finishes only for Claude.

## 4. What the notification says and does

| Change | Title | Body | Buttons |
|---|---|---|---|
| Permission prompt | *title* is waiting | the prompt's summary, e.g. "Run `bun test`" | **Yes**, **No** |
| Question | *title* is waiting | the first question | none |
| Other wait | *title* is waiting | the folder name | none |
| Finish | *title* finished | the first 150 characters of Claude's last reply, Markdown marks removed | none |

- Sent with `apns-collapse-id` = session name, so a newer notification for a session replaces the older one. `thread-id` = session name, so iOS groups them.
- Custom data: `session` (name), `kind` (`ask` / `finish`), and for a permission `at`, `yes: { pick, label }`, `no: { pick, label }`.
- **Tap the notification:** the app opens (with its own Face ID lock as today) on that session's chat.
- **Yes:** a notification action with `.authenticationRequired`, so iOS asks for Face ID first. **No:** no unlock needed. Both run the app in the background: it opens that session's chat socket, sends `answer` with the notification's `at`, `pick` and `label`, waits for the ack (10 s), and closes. blimpd's existing checks apply.
  - Refused ("the question changed"): the app shows a local notification "Not answered: the question changed. Open it to check."
  - No connection: "Not answered: can't reach claude1."
  - Ack: nothing more is shown.
- **While the app is open:** a notification for the session on screen isn't shown. One for another session shows as a banner, as the in-app banners do today.
- Opening a session's chat removes its delivered notifications.

## 5. Sending to Apple (`src/push.ts`)

- One HTTP/2 connection to `api.push.apple.com` (or `api.sandbox.push.apple.com` for `development` devices), opened when needed and kept while it works.
- `authorization: bearer <JWT>`: ES256, signed with the `.p8` key, `iss` = Team ID, `kid` = Key ID, made again every 40 minutes (Apple wants 20–60).
- `apns-topic: dev.blimp.phone`, `apns-push-type: alert`, `apns-priority: 10`.
- A failed send is logged with Apple's reason and not retried, except after a dropped connection: one retry on a fresh one.
- Nothing listens: this is outbound HTTPS only.

## Security (SECURITY.md gets these rows)

| Attacker | What they try | What stops them |
|---|---|---|
| Someone with Max's locked phone | Approve a command from the lock screen | Yes needs Face ID (`.authenticationRequired`). No can be pressed, and only stops Claude. |
| Someone who sees the locked phone | Read commands or replies | The text shows on the lock screen. iOS Settings > Notifications > Show Previews > When Unlocked hides it. The docs say so. |
| Anyone else | Send fake notifications | Only the holder of the `.p8` key can, and it stays on claude1, mode 600. |
| A stale notification | Answer a question that changed | The same `at` and label check as the chat. |

Under Accepted: blimpd now makes outbound HTTPS connections to Apple. Notification text goes through Apple's servers.

## Tests

- **Server** (`bun test`):
  - The decision rule as a pure function: asks, finishes (29 s quiet, 30 s notifies), once per wait, restart counts current states as seen, the Mac's 2-minute hold (sent if still waiting, not if answered or changed), Codex asks only.
  - The payload for each row of the table, and the Yes/No picks and labels from a permission prompt.
  - The JWT: header, claims, ES256 signature checks with the public key, remade after 40 minutes.
  - Sending against a fake Apple: a local HTTP/2 server if Bun can serve one in tests, else an injected sender. 410 removes the device. A dropped connection retries once.
  - Routes: `POST`/`DELETE /push/device`, at most 5 devices, `pair --revoke` empties them. `push-key` writes 600 files.
  - `{ type: "active" }` on `/events` is recorded; other messages still ignored.
- **Mac** (`bun test` in `app/`): `active` is sent while focused, at most every 30 s.
- **App** (BlimpKit tests in CI): payload decoding, notification action → `answer` command, the refused/no-connection texts.
- **App e2e** (simulator): `xcrun simctl push` delivers a payload; tapping it opens that session's chat.
- **Max's checklist** (`docs/PHONE-CHECKLIST.md`): a real ask and a real finish arrive with the app closed; Yes asks for Face ID and runs the command; No from the lock screen; a notification answered first on the Mac says "the question changed"; at the Mac, nothing for 2 minutes, then it comes if unanswered; a newer notification replaces the older one.

## Order of work (each step usable on its own)

1. **Server:** decision rule, push watcher, payloads, JWT, sender, `push.json`, routes, `push-key`, `push-test`, the `active` message. Check: `blimpd push-test` reaches Max's phone once the app registers (step 2).
2. **App:** entitlement, permission, registration, Settings switch, tap opens the chat, in-app hiding. Check: a TestFlight build gets `push-test` and a real ask with the app closed.
3. **Answers from the notification:** Yes/No actions and the background answer. Check: the checklist's Yes/No items.
4. **Mac:** the `active` message. Check: the checklist's at-the-Mac item.

## Later (not now)

- A relay so other people's servers can notify their phones.
- Buttons for single-choice questions.
- Removing a notification from the lock screen when the question is answered elsewhere (needs a silent push, which iOS limits).
