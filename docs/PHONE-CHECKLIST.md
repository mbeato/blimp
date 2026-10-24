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
- [ ] App switcher. Leave blimp for the Home Screen, then swipe up to the app switcher. blimp's card is blank, with no session names. (Swiping up from inside blimp shows the chat as it is: blimp is only paused then, and the lock only hides it after 5 minutes away or at launch.)
- [ ] Cancelling does not nag. Cancel the Face ID sheet. It stays on "Unlock" and does not ask again until you tap Unlock.
- [ ] Lock after 5 minutes. Go to the Home Screen, wait more than 5 minutes, come back. It is locked again. Within 5 minutes it is not. Signed out (nothing paired), it never locks.
- [ ] Unlocking keeps your place. Open a chat, scroll up a little, type a few words and don't send them. Lock (wait 5 minutes in the background). Unlock: the same chat, scrolled where you left it, the words still in the box. The chat does not reload.
- [ ] No blank screen for a glance. Pull down Control Center, or a notification, while a chat is open. The chat stays on screen (no lock cover). The same while the Face ID sheet or the first mic alert shows.
- [ ] One connect at launch. Quit the app and open it. The top bar says "Connecting…" (not "Reconnecting…") until it's up, and after Face ID it doesn't connect again: the Mac's blimpd log shows one /events connection for the launch.
- [ ] A cold launch reopens the chat. Open a chat, leave the app, quit it from the app switcher, open it again within the hour: that chat opens. After more than an hour, or after you went back to the inbox, it opens on the inbox.
- [ ] Drafts per chat. Type a few words in one chat without sending, open another chat, type there, go back: each has its own words. They come back after quitting the app too. The new-chat box keeps its own per project.

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
- [ ] Stop. While Claude works, Stop shows just above the box, even when you have scrolled up. Type something: Stop stays, with "Stop and send" beside it, and Send in the box. Tap Stop. Claude stops.
- [ ] Answered once. Tap a permission button. The phone gives a tap you can feel and says "Sent…", then "Answered" with a tick and a second, softer buzz. The buttons stay greyed until the prompt goes away. A second tap does nothing. (phone, for the buzz)
- [ ] Real options only. Make Claude ask a permission. For a moment the bar says "Loading choices…" with a spinner, then Claude's own options show (for example Yes, then "Yes, and don't ask again …" as a small link under the buttons, then No). Yes and No never show first and then change.
- [ ] No tool steps. The chat shows only your messages and Claude's replies. While Claude works, the working row says its latest step after "working…" (for example "Ran npm test").
- [ ] The inbox. Open the app: the inbox of the project you used last. On top: Needs you (this project's only), then "Finished, not read yet" (a blue dot, Haiku's few words, "finished 3m ago"), Working ("working 14m") and "+3 other" for the rest, folded. No paragraph above them. There is no Sessions list: the drawer has it. Tap a line: its chat opens. A Finished line goes once you've opened that session.
- [ ] A new chat. The box at the bottom of the inbox. Type and send: Claude starts there with your message, and the chat becomes that session. In a chat, the top right has the context gauge (from half full), then the speaker, and no Recap, Inbox button or ••• menu.
- [ ] Back to the inbox. In a chat, the top left says ‹ and the project's name, with an amber question mark when another session needs you. Tap it: the project's inbox. There is no ☰ in a chat; ☰ is on the inbox.
- [ ] New session in the drawer. In a chat, open the drawer: + beside the project's name. Tap it: the drawer closes, the project's inbox shows, and its box has the keyboard up, ready to type. Nothing starts until you send (the Mac lists no new session). The same from the inbox.
- [ ] The project strip. Open the drawer: under the project's name and above its sessions, an icon per project, two letters from its folder's name, newest activity first, in a row that scrolls sideways when they don't all fit (scrolling it doesn't close the drawer). One where a session asks you something has an amber question mark; one with a new reply, a blue dot. Tap one: the drawer stays open with that project's sessions, its icon lit, and the inbox behind it is that project's. While the drawer is open, the icons don't move, even when another project gets newer activity.
- [ ] The drawer. Swipe right anywhere, in a chat too, or tap ☰ on the inbox: the project's name with +, the running sessions under Active, the Browser tabs, the past ones under Earlier, folded until you tap it (it stays as you left it). The project row is under the name, above Active. The newest activity on top in each. A swipe left or a tap beside it closes it. Settings is the gear at the right end of the project row.
- [ ] Hide a project. Press and hold a project's icon in the drawer's row and pick Hide: it leaves the row at once, even with a session running there. On the Mac, ⌘O: it isn't under the recent folders either. Hide the project on screen: the next one's inbox shows. On the Mac, start a session in that folder (type its path in Open Folder): open the phone's drawer again and it's back.
- [ ] No scratch folders. A folder in /tmp where Claude ran (a helper agent's scratchpad) shows neither in the drawer's row nor in the Mac's recent folders.
- [ ] The keyboard goes. In a chat, tap the box so the keyboard is up, then swipe right: the keyboard slides away as the drawer comes out. The same on the inbox: tap its box, then ☰.
- [ ] The drawer follows your finger. Start a swipe right slowly and move your finger back and forth before letting go: the drawer's edge stays under your finger the whole way, from the first movement, and the chat behind dims as it comes out. Let go a little way out: it slides back closed. Let go past about a third, or flick right: it opens. The same closing it: drag it left and back, and it follows. Scroll the chat up and down: the drawer never moves. The top of the screen says what's open; on the inbox, with the project's name under it, and in a chat the project's name is in the ‹ at the top left.
- [ ] Marks. A session asking you something shows an amber question mark; one with a reply you haven't seen, a blue dot; one working, a spinner. The top-left button (☰ on the inbox, ‹ in a chat) shows the mark of anything but the chat on screen; while Needs you lists anything but that chat (a finished turn that ends in a question too), its amber question mark.
- [ ] Read on one, read on both. Open a session with a blue dot on the phone: the dot goes on the phone and on the Mac. Show one with a blue dot on the Mac (window in front): it goes on the phone too.
- [ ] A past conversation. Tap one in the drawer: it opens to read, and nothing starts (the Mac lists no new session). Send something: it resumes with that message.
- [ ] End a session. Press and hold its row in the drawer, End session, confirm. It leaves the drawer. The same from a swipe right on its row in the drawer, or a swipe left on its row in the inbox: End asks first.
- [ ] Links. A link to a web page opens in Safari when tapped. A link with another kind of address (for example `file:` or `tel:`) is not tappable.
- [ ] One-tap replies. In a chat with an empty box and nothing asked, "go", "continue", "yes go ahead" and "status?" sit above the box. Tap one: "Sending “go”… Undo" shows for 2 seconds (a light tap you can feel), then it's sent. Tap Undo before that: nothing is sent. Long-press one: its words go in the box, unsent. Type a letter, or let Claude ask something: the chips go. Tap one, then within 2 seconds type a letter and delete it: the chips come back and nothing is sent.
- [ ] Number picks. Ask Claude for three options as a numbered list. The chips become 1, 2, 3 and all. Tap 2: Claude gets "2".
- [ ] Scrolling. A long chat opens at the bottom. A new message follows only when you are already at the bottom. If you scrolled up, a "New" pill shows. Tapping it scrolls down.
- [ ] The prompt bar does not jump. When a permission appears, the bar slides in without flicker on its first frame.

## Needs you, prompts and rows

- [ ] Needs you in one project. Make two sessions in project A and one in project B ask something. Open A's inbox: A's two are under Needs you, the oldest first, each with "asked 6m ago". B's is not there. Open B's inbox: only B's. While you are in A, the top-left button still shows the amber question mark for B's, and B's icon in the strip has one too.
- [ ] Allow and Deny in the row. A permission under Needs you shows its command and Allow and Deny. Tap Allow without opening the chat: a buzz, "Sent…", then "Answered". Claude carries on, on the Mac too. Deny on another one: Claude is told no. (phone, for the buzz)
- [ ] A risky command asks once more. Make Claude ask to run `git push --force` (or `rm -rf` something). Its command is red in the row, and Allow asks "Allow this?" first. In the chat, a red line says it can push, deploy, delete or force.
- [ ] A question's choices in the row. A one-question, single-choice prompt shows its options as chips under Needs you; a tap answers it. Two or more questions show "Answer (2)", which opens the chat at the question.
- [ ] A plan. Make Claude plan something (plan mode) and ask to go ahead. The chat shows "Claude's plan" with the plan as text, then its real options. "No, tell Claude what to change…" opens a field: type what to change, Send. Claude stays in plan mode and gets your words. In the inbox the row says "Review plan", which opens the chat.
- [ ] No, and why. On a permission in the chat, tap "No, and tell Claude why…", type a reason, Send. Claude is told no, then reads your reason as a message. One step.
- [ ] A banner on any screen. On the inbox or with the drawer open, make a session in another project start waiting. A banner "… is waiting" slides in at the top with a double buzz; a tap opens it. A session that finishes working gives one light tick and no banner. (phone, for the buzz)
- [ ] Since you left. Leave the app in the background for more than 30 minutes, then come back. The inbox's top line reads "Since 11:40 PM: 4 finished, 1 asking, 2 working". Tap it: only what changed since shows, as many rows as the line counts ("Show all" goes back). Open a session: the line goes.
- [ ] A long job. A session working more than 30 minutes shows a clock instead of the spinner under Working.
- [ ] Swipe actions. Swipe left on an inbox row of a working session: Stop, End. On one with a new reply: Mark read (the blue dot goes, on the Mac too; on a past conversation too, at once). In the drawer, the same from a swipe right. A past conversation in the drawer: Resume starts it again with no message, and its chat opens. A swipe on a row doesn't open or close the drawer.
- [ ] The row's caption. A session on a git branch shows the branch under its title ("2m ago · feat-x"); with background jobs, "1 job · 14m", then "job done" for half an hour after one ends.
- [ ] Two sessions on one branch. Start two sessions on the same branch, and make both edit the same file. Neither row shows a warning. Press and hold a row: the menu's top says "On branch feat-x", and "On branch feat-x (worktree)" in a worktree.
- [ ] Continue in new session. Press and hold a Claude session's row, Continue in new session. Its caption says "Writing handoff"; when the new session starts, it opens. The new session's row has an arrow before its title ("Continued from …" to VoiceOver), and the old one says "Handed off". Against a blimpd too old for it: "This server's blimpd is too old to continue in a new session. Update it first."
- [ ] An ended session keeps its name. End a session on the Mac while its chat is open on the phone. The title at the top stays the session's name, not "Starting…".

## In a chat (blimpd 0.3)

- [ ] Stop and send. While Claude works, type a new instruction and tap "Stop and send". Claude stops, and your text arrives as a new message (on the Mac too). The box clears. Until it does, Send in the box shows a spinner, so the text can't go twice.
- [ ] The newest reply is never folded. Make Claude write a long reply. It shows in full, with no Show more. An older long reply above it is still folded.
- [ ] Since you left. Open a chat on the phone, leave it, let Claude reply (for example from the Mac without looking at it), then open it again on the phone. A blue "Since you left" line sits above the first new message, the chat opens there, and the New pill jumps to the end. If you read the reply on the Mac first, there is no line.
- [ ] Since you left, back from the background. With a chat open, go to the Home Screen for a minute. Let Claude reply (without opening that session on the Mac). Come back: the line sits above the reply, and the chat jumps there.
- [ ] Switching back is instant. Open chat A, then B, then A again. A's messages show at once, with no spinner, and new ones fill in a moment later.
- [ ] Next waiting. With two other sessions in this project asking something, answer the prompt in this chat. A chip says "Next: <title> is waiting (2 left)". Tap it: that session's chat opens, at its prompt. A session asking in another project does not count, and with only that one there is no chip.
- [ ] Run. Ask Claude for a command in a ```bash block. Under the block, Run shows (only in Claude's latest reply, and only for commands blimpd also sees). Tap Run: a sheet shows the whole command and the folder it runs in. Cancel does nothing. Run: the Mac lists a new Run session, the block says "Running…", then "Finished · exit 0" or "Failed · exit N" in red. You feel a tap when it starts.
- [ ] Send result to Claude. After a run ended, tap "Send result to Claude". Claude gets the exit code and the last lines of output, and the block says "Result sent to Claude", with a success tap. While Claude asks something, the red line under the box says why it wasn't sent.
- [ ] Sideways scrolling moves no drawer. In a reply with a code line too long for the screen, scroll the code sideways, both ways, slowly and with a flick: only the code moves, not the drawer. The same on the reply chips over the box when there are more than fit. A swipe that starts beside the code box still pulls the drawer.
- [ ] Context gauge. In a session whose context is half full or more, a ring with the percent shows in the top bar, red from 80%. Tap it: the menu says "Context 62% (620k of 1M tokens)" and has Continue in New Session. Tap that: the chat says "Writing handoff…", then a chip "Handed off. Open the new session" opens the new one.

## Ended sessions

- [ ] Session ended. End a session on the Mac while its chat is open on the phone. The chat shows "Session ended" (blimpd closes the chat with code 4000). If it has a conversation, a Resume button shows. Resume opens the new session on the same screen.
- [ ] Opening a chat on a session that is already gone (end it on the Mac, then tap its old row, or open it from a stale list) shows "Session ended". (blimpd answers 404.)
- [ ] An older blimpd. With the server on release blimpd 0.2.6, open a chat. It says "This server's blimpd can't show chats yet. Update it (see the README)." There is no Resume. Home still works.

## Connection

- [ ] Reconnect. Turn the Mac's wifi off and on. The chat shows "Reconnecting…", keeps the old messages, then fills in again.
- [ ] A quiet connection counts as connected. Open a session that is idle. The "Reconnecting…" bar goes away on its own after a moment.
- [ ] Coming back from the background. Go to the Home Screen for a minute, then return (unlock if asked). A link that still works is kept: the chat does not flash "Reconnecting…" or reload. After a longer time away, with the link dead, both Home and the open chat are back within about 3 seconds.
- [ ] A new network. With a chat open, turn Wi-Fi off (cellular takes over), then on again; or join a hotspot. The chat comes back within a few seconds each time, not after 20 to 40.
- [ ] A send on a dead link. Turn on Airplane Mode, then at once send a message. Within about 3 to 6 seconds "Not sent. Check the connection." shows, and your text stays in the box. (A link that was only slow gets the message once more on a new link, and Claude gets it once.) (phone)
- [ ] Tailscale off. With the phone paired over Tailscale, turn the Tailscale VPN off in its app. The top bar says "Tailscale looks off" with "Open Tailscale". Tap it: the Tailscale app opens (if its link doesn't work, the App Store's Tailscale page opens; note which). Turn the VPN on: the bar goes within a few seconds. Paired over another address (the simulator's 127.0.0.1), it says "Can't reach the server" instead. (phone)
- [ ] An older server says so. With a phone build newer than the server's blimpd (as after a release, before the server is updated), the top bar says "The server runs an older blimp (0.3.6). Update it from the Mac." with the server's version. Update the server from the Mac: the bar goes once the phone reconnects. With the same version, there's no bar. (phone)

## Voice

Items marked (phone) need a real iPhone: speech recognition may not run in the simulator.

- [ ] First use. Tap the mic for the first time. "Getting speech ready…" shows while the speech model loads. (phone)
- [ ] Permission denied. Deny the microphone or speech recognition when asked. The chat says where to turn them on: Settings > Apps > blimp. (phone)
- [ ] Hold to talk. Hold the mic, speak, let go. Your words show in the box as you talk. Letting go sends nothing: they stay in the box to read, edit or add to. Send sends them. (phone)
- [ ] Talk more onto it. With words in the box, the mic is still there beside Send. Hold it and speak: the new words go after the old ones, with one space. (phone)
- [ ] The new-chat box has the mic. In a project's inbox and in a past conversation, the mic is in the box. Words heard stay there until Send. (phone)
- [ ] No clipped first words. Open a chat, wait a second, hold the mic and start talking at once. The first word is in the box. Try it with the very first press after opening the app too. (phone)
- [ ] Nothing listens until you press. With a chat open and the mic not pressed, no orange dot shows in the status bar, and music from another app keeps playing. (phone)
- [ ] Tap to talk. Tap the mic, speak, tap it again. The words stay in the box, unsent; Send sends them. (phone)
- [ ] Dismiss a question. While Claude asks something, tap Dismiss on the question. It goes away, and Claude says you declined and carries on. (phone)
- [ ] A question while you talk. Start talking. Have Claude ask something before you finish. Nothing is sent. Your words stay in the box, and "Claude asked something. Nothing was sent." shows. (phone)
- [ ] Typing while Claude asks. While a prompt is up, type something and tap Send. "Answer Claude's question first." shows in red, and your text stays.
- [ ] Read aloud on and off. Tap the speaker button in the chat's top bar. Claude's replies are spoken. Tap it again. They are not.
- [ ] Code is skipped. A reply with a code block is read without the code.
- [ ] A question read aloud. With read-aloud on, make Claude ask for a permission. The question and its choices are read.
- [ ] Starting the mic stops speech. While a reply is read, tap the mic. The reading stops. (phone)
- [ ] A reply that arrives while the mic is on is not read. (phone)
- [ ] A permission answered by voice. Say "yes". The permission is answered. For a risky command (a push, a deploy, rm -rf), saying "yes" only marks Yes; tap it to answer. (phone)
- [ ] An unclear answer is highlighted, not sent. Say something that is not yes or no. It shows highlighted and waits for a tap. (phone)
- [ ] Another session. With a chat open, make another session start waiting, or finish. A banner slides in at the top, with a sound. Tapping it opens that session.
- [ ] A whole conversation by voice. With read-aloud on: ask by voice, hear the reply, answer a permission by voice. No typing. (phone)
- [ ] Read-aloud sounds good with a Premium voice. In the iPhone's Settings, Accessibility, Spoken Content, Voices, download a Premium voice. Claude's replies sound natural in blimp.
- [ ] Read-aloud stops on tap. While it speaks, tap the reply being read. It stops.

## Browser

The server's browser tabs, from the drawer's Browser section. Items marked (phone) need a real iPhone: how it feels can't be checked in the simulator.

- [ ] The tabs. Open a page on the Mac (or have Claude open one) in a project. The phone's drawer lists it under Browser in that project, with a dot if Claude opened it. New Tab opens one at Google, full screen.
- [ ] A phone page. Open a site with a phone layout (github.com, say). It shows its phone layout, not a shrunken desktop page. A site that picks its page by browser shows its phone page after a Reload.
- [ ] Scrolling. Swipe up and down a long page. It follows the finger, and a fast swipe keeps gliding after you let go. Try it on Wi-Fi, then on cellular; note how it feels on each. (phone)
- [ ] Pinch. Pinch to zoom a page that allows it. (phone)
- [ ] Typing. Tap a search box on a page. The keyboard comes up by itself; what you type shows in the box on the page, Delete deletes, Return submits. Tap the page outside the box: the keyboard goes. (phone)
- [ ] The address. Tap the address at the top, type a word, Go: a Google search. Type `localhost:3000` (with something running there on the server): that page.
- [ ] Back, Forward, Reload in ••• work.
- [ ] A page's alert. On a page that asks something (a confirm), the phone shows it as an alert, and your answer reaches the page.
- [ ] The Mac gets its size back. With the same tab open on the Mac, open it on the phone: the Mac's page turns narrow. Tap × on the phone: the Mac's page is desktop size again. Click the Mac's page while the phone has it open: the Mac's size comes back, and the phone's picture is scaled to fit until you touch it.
- [ ] Send to Session. From a session's chat, open a tab, then ••• > Send to Session. The chat comes back with `Browser tab "<title>" <address>` in the box.
- [ ] The lock. Open a tab, leave the app for over five minutes, come back. The lock covers everything, the page included; after unlocking, the chat shows.
- [ ] Close Tab. ••• > Close Tab, or swipe a tab's row right in the drawer: it goes, on the Mac too.
- [ ] Notifications. After pairing (or on the first launch with this build), blimp asks once whether it may send notifications: Allow. With the server's push key set, `blimpd push-test` prints `sent` for the phone, and the phone shows "blimp can reach this phone". Close blimp and let a session wait on you: a notification comes within a few seconds, titled with the session and "is waiting". Tap it: blimp opens (after Face ID) on that session's chat, and the notification is gone. A Claude turn of 30 s or more that ends sends "… finished" with the start of the reply. With blimp open, none shows (its own banner does). Settings > Notifications off: none come, on again: they do.
