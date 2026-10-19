# iPhone app: Max's checklist

Tick each box when it works. Each line says what to do, then what should happen.

Set up first: follow `ios/README.md` (tunnel, token, Run in the simulator). The Mac app should be open too, so you can see both sides.

## Pairing and lock

- [ ] Pairing by link. Paste the `blimp://pair?...` link on the Pair screen. You land on Home. (Scanning a QR code comes with Tailscale.)
- [ ] A wrong token. Pair with a made-up token. The app says the server did not accept it and stays on Pair. (This checks that a refused token, HTTP 401, is recognised.)
- [ ] Plain http to 127.0.0.1. The pairing above worked over `http://127.0.0.1:7425`. Any other `http://` address is refused.
- [ ] Keychain in a normal Xcode run. Press Run, pair, stop the app, press Run again. It opens on Home without asking to pair. Sign out in Settings. The next run asks to pair.
- [ ] Face ID. Quit and reopen the app. It shows a blank screen with "Unlock", no session names. Features, Face ID, Matching Face unlocks it.
- [ ] Face ID fails, passcode works. Choose Non-matching Face. Then use the passcode when asked. It unlocks.
- [ ] Lock after 5 minutes. Go to the Home Screen, wait more than 5 minutes, come back. It is locked again. Within 5 minutes it is not.

## Home

- [ ] Grouping. Sessions are grouped by project. Each project shows how many sessions it has.
- [ ] The waiting section. When a session waits for you (a permission or a question), it shows at the top under "Waiting", with an amber dot on its project.
- [ ] Start. Open a project, start a new session. It appears and opens.
- [ ] Resume. End a session that has a conversation, then resume it from the project. The old conversation is there.
- [ ] End. Swipe a session and end it. It asks first. Then it leaves the list.
- [ ] Empty chats are not "ended". Stop and restart blimpd on the server while a chat is open. The chat shows "Reconnecting…" and comes back. It does not say "Session ended".

## Conversation

- [ ] Typed from the phone shows on the Mac at once. Type a message. It appears in the Mac app's terminal for that session.
- [ ] Return adds a new line. The box grows up to 6 lines.
- [ ] The box clears only after blimpd accepts the message. Stop the tunnel and send. The red line "Not sent. Check the connection." shows and your text stays.
- [ ] A permission answered with a button. Ask Claude to do something that needs permission. Yes and No show as buttons. Tap Yes. Claude carries on, on the Mac too.
- [ ] A single-choice question answered with a button. Make Claude ask a question with options. Tap one. It is answered.
- [ ] A question with several parts or several choices shows "Open on Mac to answer this", read-only.
- [ ] A tall question scrolls inside the bar.
- [ ] Stop. While Claude works and the box is empty, Stop shows. Tap it. Claude stops.
- [ ] Tap a tool line. It opens and closes. Long output scrolls sideways.
- [ ] Links. A link to a web page opens in Safari when tapped. A link with another kind of address (for example `file:` or `tel:`) is not tappable.
- [ ] Scrolling. A long chat opens at the bottom. A new message follows only when you are already at the bottom. If you scrolled up, a "New" pill shows. Tapping it scrolls down.
- [ ] The prompt bar does not jump. When a permission appears, the bar slides in without flicker on its first frame.

## Ended sessions

- [ ] Session ended. End a session on the Mac while its chat is open on the phone. The chat shows "Session ended" (blimpd closes the chat with code 4000). If it has a conversation, a Resume button shows. Resume opens the new session on the same screen.
- [ ] Opening a chat on a session that is already gone (end it on the Mac, then tap its old row, or open it from a stale list) shows "Session ended". (blimpd answers 404.)

## Connection

- [ ] Reconnect. Turn the Mac's wifi off and on. The chat shows "Reconnecting…", keeps the old messages, then fills in again.
- [ ] A quiet connection counts as connected. Open a session that is idle. The "Reconnecting…" bar goes away on its own after a moment.
- [ ] Coming back from the background. Go to the Home Screen for a minute, then return (unlock if asked). Both Home and the open chat reconnect at once.

## Voice (when the voice task is done)

- [ ] Hold to talk. Hold the mic, speak, let go. Your words are typed in the box.
- [ ] Swipe up to keep. Hold the mic, swipe up. The recording is kept for you to edit.
- [ ] Read aloud on and off. In Settings, turn it on. Claude's replies are spoken. Turn it off. They are not.
- [ ] Code is skipped. A reply with a code block is read without the code.
- [ ] A permission answered by voice. Say "yes". The permission is answered.
- [ ] An unclear answer is highlighted, not sent. Say something that is not yes or no. It shows highlighted and waits for a tap.
- [ ] Read-aloud stops on tap. While it speaks, tap. It stops.
