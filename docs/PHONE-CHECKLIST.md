# iPhone app: Max's checklist

Tick each box when it works. Each line says what to do, then what should happen.

Set up first: follow `ios/README.md` (tunnel, token, Run in the simulator). The Mac app should be open too, so you can see both sides.

## Pairing and lock

- [ ] Pairing by link. Paste the `blimp://pair?...` link on the Pair screen. You land on Home.
- [ ] Pairing by QR code (a real iPhone; the simulator has no camera, so it shows no Scan button). Run `blimpd pair` on the server, tap Scan QR code, allow the camera, point it at the terminal. You land on Home. Try it from a dark terminal and a light one.
- [ ] A wrong token. Pair with a made-up token. The app says the server did not accept it and stays on Pair. (This checks that a refused token, HTTP 401, is recognised.)
- [ ] Plain http to 127.0.0.1. The pairing above worked over `http://127.0.0.1:7425`. Now paste a link with a non-local address, for example `blimp://pair?url=http%3A%2F%2F192.168.1.5%3A7425&token=x`. The app says "That isn't a blimp link".
- [ ] Keychain in a normal Xcode run. Press Run, pair, stop the app, press Run again. It opens on Home without asking to pair. Sign out in Settings. The next run asks to pair.
- [ ] Face ID. First, in the Simulator menu choose Features, Face ID, Enrolled. Then quit and reopen the app. It shows a blank screen with "Unlock", no session names. Features, Face ID, Matching Face unlocks it. (The very first launch, before pairing, doesn't ask.)
- [ ] Face ID fails, passcode works. Choose Non-matching Face. Then use the passcode when asked. It unlocks. (Needs a device with a passcode set: a real phone.)
- [ ] App switcher. Swipe up to the app switcher. blimp's card is blank, with no session names.
- [ ] Cancelling does not nag. Cancel the Face ID sheet. It stays on "Unlock" and does not ask again until you tap Unlock.
- [ ] Lock after 5 minutes. Go to the Home Screen, wait more than 5 minutes, come back. It is locked again. Within 5 minutes it is not. Signed out (nothing paired), it never locks.

## Home

- [ ] Grouping. Sessions are grouped by project. Each project shows how many sessions it has.
- [ ] The waiting section. When a session waits for you (a permission or a question), it shows at the top under "Waiting", with an amber dot on its project.
- [ ] Start. Open a project, start a new session. It appears and opens. Until Claude is ready, the chat shows a spinner, not "Open on Mac".
- [ ] Recent folders. Folders you used lately that have nothing running show under "Start somewhere else", even while other sessions run.
- [ ] Resume. End a session that has a conversation, then resume it from the project. The old conversation is there.
- [ ] End. Swipe a session and end it. It asks first. Then it leaves the list.
- [ ] Empty chats are not "ended". Stop and restart blimpd on the server while a chat is open. The chat shows "Reconnecting…" and comes back. It does not say "Session ended".

## Conversation

- [ ] Typed from the phone shows on the Mac at once. Type a message. It appears in the Mac app's terminal for that session.
- [ ] Return adds a new line. The box grows up to 6 lines.
- [ ] The box clears only after blimpd accepts the message. Stop the tunnel and send. The red line "Not sent. Check the connection." shows and your text stays.
- [ ] A permission answered with a button. Ask Claude to do something that needs permission. Yes and No show as buttons. Tap Yes. Claude carries on, on the Mac too.
- [ ] A single-choice question answered with a button. Make Claude ask a question with options. Tap one. It is answered.
- [ ] Several questions at once. Make Claude ask two or three questions in one go, one of them with several choices. The bar shows "1 of 3", the header and question, the options. Tapping a single-choice option moves on; multi-choice options tick, then Next. Back goes to the question before. The review lists every answer; tapping one goes back to it. Submit: Claude's chat shows the answers.
- [ ] A typed answer. In a question, tap "Type an answer", type, tap Use (or Next for a multi-choice question). Claude gets your words.
- [ ] A tall question scrolls inside the bar.
- [ ] Stop. While Claude works, Stop shows. Type something: Stop stays, with Send beside it. Tap Stop. Claude stops.
- [ ] Answered once. Tap a permission button. The buttons stay greyed until the prompt goes away. A second tap does nothing.
- [ ] Changed options. A permission can first show Yes and No, then a moment later all of Claude's options. If you tap just as they change, nothing is pressed and "The question changed. Check it and answer again." shows.
- [ ] Tap a tool line. It opens and closes. Long output scrolls sideways.
- [ ] Links. A link to a web page opens in Safari when tapped. A link with another kind of address (for example `file:` or `tel:`) is not tappable.
- [ ] Scrolling. A long chat opens at the bottom. A new message follows only when you are already at the bottom. If you scrolled up, a "New" pill shows. Tapping it scrolls down.
- [ ] The prompt bar does not jump. When a permission appears, the bar slides in without flicker on its first frame.

## Ended sessions

- [ ] Session ended. End a session on the Mac while its chat is open on the phone. The chat shows "Session ended" (blimpd closes the chat with code 4000). If it has a conversation, a Resume button shows. Resume opens the new session on the same screen.
- [ ] Opening a chat on a session that is already gone (end it on the Mac, then tap its old row, or open it from a stale list) shows "Session ended". (blimpd answers 404.)
- [ ] An older blimpd. With the server on release blimpd 0.2.6, open a chat. It says "This server's blimpd can't show chats yet. Update it (see the README)." There is no Resume. Home still works.

## Connection

- [ ] Reconnect. Turn the Mac's wifi off and on. The chat shows "Reconnecting…", keeps the old messages, then fills in again.
- [ ] A quiet connection counts as connected. Open a session that is idle. The "Reconnecting…" bar goes away on its own after a moment.
- [ ] Coming back from the background. Go to the Home Screen for a minute, then return (unlock if asked). Both Home and the open chat reconnect at once.

## Voice

Items marked (phone) need a real iPhone: speech recognition may not run in the simulator.

- [ ] First use. Tap the mic for the first time. "Getting speech ready…" shows while the speech model loads. (phone)
- [ ] Permission denied. Deny the microphone or speech recognition when asked. The chat says where to turn them on: Settings > Apps > blimp. (phone)
- [ ] Hold to talk. Hold the mic, speak, let go. Your words show in the box as you talk, and letting go sends them to Claude. (phone)
- [ ] Tap to talk. Tap the mic, speak, tap it again. The words are sent to Claude. (phone)
- [ ] Swipe up to keep. Hold the mic, speak, swipe up, let go. The words stay in the box, unsent, for you to edit. (phone)
- [ ] A question while you talk. Start talking. Have Claude ask something before you finish. Nothing is sent. Your words stay in the box, and "Claude asked something. Nothing was sent." shows. (phone)
- [ ] Typing while Claude asks. While a prompt is up, type something and tap Send. "Answer Claude's question first." shows in red, and your text stays.
- [ ] Read aloud on and off. Tap the speaker button in the chat's top bar. Claude's replies are spoken. Tap it again. They are not.
- [ ] Code is skipped. A reply with a code block is read without the code.
- [ ] A question read aloud. With read-aloud on, make Claude ask for a permission. The question and its choices are read.
- [ ] Starting the mic stops speech. While a reply is read, tap the mic. The reading stops. (phone)
- [ ] A reply that arrives while the mic is on is not read. (phone)
- [ ] A permission answered by voice. Say "yes". The permission is answered. (phone)
- [ ] An unclear answer is highlighted, not sent. Say something that is not yes or no. It shows highlighted and waits for a tap. (phone)
- [ ] Another session. With a chat open, make another session start waiting, or finish. A banner slides in at the top, with a sound. Tapping it opens that session.
- [ ] A whole conversation by voice. With read-aloud on: ask by voice, hear the reply, answer a permission by voice. No typing. (phone)
- [ ] Read-aloud sounds good with a Premium voice. In the iPhone's Settings, Accessibility, Spoken Content, Voices, download a Premium voice. Claude's replies sound natural in blimp.
- [ ] Read-aloud stops on tap. While it speaks, tap the reply being read. It stops.
