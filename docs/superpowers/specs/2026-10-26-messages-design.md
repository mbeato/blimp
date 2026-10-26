# Texting the assistant: Messages as its front door

Date: 2026-10-26. Branch `messages` (worktree /Users/mbeato/blimp-messages). Status: design approved, not built.

## What Max asked for

Having the assistant inside the blimp app "kinda feels off". He'd rather it lived in Messages: text it like a
person. He asked whether a spare AT&T number or an email address would be easier.

## Decisions

- **An email-address Apple ID, not the spare AT&T number.** A number only works on iMessage while an iPhone
  holding that SIM stays on. An email Apple ID is free and needs no extra hardware. It shows on Max's phone
  as its own contact, "Assistant".
- **The assistant gets its own Apple ID, not Max's.** On Max's own account the relay would sit next to every
  text he gets.
- **The relay runs on Max's work MacBook Pro**, on his tailnet: an M4 with 16 GB that
  never sleeps and stays signed in. It also runs the three iOS CI runners (mbp-a/b/c). The relay is light
  enough to share the machine.
- **In its own macOS user, "Assistant"** (picked over moving that Mac's Messages to the assistant, and over
  texting himself). Max keeps his own texts on that Mac. The risk is that Messages may not work for a user in
  the background, so build step 1 tests that first. The fallback is to sign Max's Apple ID out of Messages in
  his own user and sign the assistant's in.
- **blimp runs the conversation (approach A).**
  - The Mac relay only moves texts. blimpd on claude1 types them into the assistant, texts its answers back
    and turns yes/no replies into answers.
  - Picked over a Claude Code channel (approach B). That's a research preview, a home-made one loads only
    with `--dangerously-load-development-channels`, and it texts back only when the model calls its reply
    tool.
  - Also picked over moving the assistant onto the Mac with the official iMessage plugin (approach C). The
    assistant would leave the server's browser, logins and sessions.
- **Approvals by text:** Max replies yes or no in Messages. blimp can still answer them too.
- **blimp keeps the assistant's icon and jobs bar.** It's one conversation seen in two places. Messages is
  the main door, and blimp is the full view.
- **Every finished answer is texted,** including answers to what Max typed in blimp. The Messages thread is
  the whole record. Max was told this means a second buzz when he chats in blimp, and he kept it.
- **Server and relay only.** No phone or Mac app changes, so no TestFlight build.

## 1. The Mac side

- **A standard (non-admin) macOS user "Assistant"** on the work MacBook Pro. It stays signed in in the
  background (fast user switching) while Max is signed in as `mbeato`.
- **Messages in that user** signs in with the new Apple ID.
- **The relay** is one compiled binary, `blimp-relay`, built from `relay/` in this repo:
  - It's built with `bun build --compile --target=bun-darwin-arm64` on claude1, so the Mac needs no Bun.
  - It lives in `~/Library/Application Support/blimp-relay/` in the Assistant user's home.
  - A LaunchAgent (`~/Library/LaunchAgents/dev.blimp.relay.plist`, `RunAtLoad` and `KeepAlive`) starts it
    when the Assistant user signs in and restarts it if it stops.
  - It logs to `~/Library/Logs/blimp-relay.log`.
- **Reading texts:**
  - Every 2 s it opens `~/Library/Messages/chat.db` read-only and selects messages with
    `ROWID > last` (the same query shape as the official plugin).
  - A message passes only if all of these hold:
    - It isn't from the assistant itself (`is_from_me = 0`).
    - Its chat is one-to-one (`chat.style = 45`; group chats are dropped).
    - It isn't a reaction (`associated_message_type = 0`).
    - Its sender's handle is in the relay's allowlist: Max's phone number in `+1…` form and his Apple ID
      emails, in its config file.
  - Everything else is skipped and never leaves the Mac.
  - When `text` is NULL, the text is decoded from `attributedBody`. The decoder is adapted from the official
    iMessage plugin (anthropics/claude-plugins-official, Apache-2.0), with a credit comment.
  - A message with attachments is passed with `picture: true`.
- **Where it remembers its place:** the last ROWID read is kept in a state file next to the binary. The first
  run starts at `MAX(ROWID)`, so old history is never sent.
- **Sending:** `osascript` with `tell application "Messages" to send (item 1 of argv) to chat id (item 2 of
  argv)`. The text is passed as an argument, never pasted into the script.
  - The chat is the one the latest allowed text came from.
  - Before any text has come in, it uses the chat for the first allowlisted handle.
- **Echo mode:** with no server in its config, the relay texts back `got: <text>`. Build step 1 tests the
  relay in this mode.
- **Mac permissions, granted once by hand:**
  - Full Disk Access for `blimp-relay` (it can't read chat.db without it).
  - Automation, so it can control Messages. The first send asks for this.
- **After a restart** of the Mac, someone signs the Assistant user back in. macOS auto-signs-in one user
  only. The offline alert (section 3) is how Max finds out.

## 2. The server side (blimpd, `src/messages.ts`)

- **On and off:**
  - `blimpd messages on|off|status|revoke`, stored as `"messages": {"on": true}` in `config.json`.
  - `on` also makes the relay key if it's missing. `revoke` deletes the key.
  - `status` prints:
    - whether it's on;
    - when the relay last checked in;
    - how many texts are waiting to go out.
  - No setting in the apps for now.
- **Texts in** (`POST /messages/in`, below):
  - If blimpd has already seen the text's `id`, it's ignored (it keeps the last 500 ids).
  - If the assistant is off, blimpd texts back "The assistant is off. Turn it on in blimp's Settings."
  - If the assistant is waiting on a question blimp has texted, the text answers it (Approvals, below).
  - Otherwise blimpd types the text into the `assistant` session with Enter, through blimp's typing queue
    (`typeInto`). Claude queues it if a turn is running.
  - If the assistant is waiting on a question blimp hasn't texted yet, or one texted as "Open blimp to
    answer", the text is held. It's typed once the wait ends. It's never typed into a dialog.
  - A text with `picture: true` gets " (Max also sent a picture, which you can't see yet)" appended. If it
    has no words at all, blimpd texts back "I can only read text for now."
- **Answers out:**
  - Every second blimpd looks at the assistant session.
  - When a turn finishes (state goes to `done`, keyed by `stateSince` so a turn is never sent twice), it
    reads the turn's final reply with the reader push alerts already use (`follow`/`newSummary` from
    names.ts).
  - It turns the reply into plain text: the same marks `plainText` (push/payload.ts) removes, but line
    breaks kept. Then it adds it to the outbox.
  - An empty reply (a turn of only tool calls) sends nothing. In-between text in a turn is never sent.
- **Approvals:** when the assistant has been waiting at least 3 s (`ASK_SETTLE`), blimpd texts the wait once,
  keyed by `prompt.at`.
  - **Permission:** "<summary>. OK? Reply yes or no." The summary is `prompt.summary`.
    - "yes", "y", "ok" or "okay" (any case, trimmed) picks "Yes".
    - "no" or "n" picks "No".
    - Anything else is a deny with Max's words, which blimp's existing `deny` answer types after the Esc.
  - **One single-choice question:** the question, its options numbered 1…n, then "Reply with a number or
    your own words." A number in range picks that option. Anything else answers in Max's words.
  - **Multi-part or multi-select questions, folder trust, and anything blimp can't answer:** "It's asking
    something only blimp can show. Open blimp to answer."
  - Answers go through `answer()` (answer.ts) with the wait's `at`. If the wait is gone or changed (answered
    in blimp, say), blimpd texts "That was already answered." and types nothing.
- **Alerts:** while Messages is on and the relay has checked in within 5 minutes, the push rule doesn't push
  the assistant's own questions or finished turns, because the text is the alert. Jobs' "needs you" pushes
  are unchanged.
- **blimp.md** gets a "## Messages" section:

  > Max mostly reads you in Messages on his phone, and everything you finish saying is texted to him.
  > Keep answers short and plain: no tables, headings or code blocks unless he asks. Links are fine.

## 3. The link (relay ↔ blimpd)

- **Over Tailscale** to blimpd's existing HTTPS address, with a Bearer key.
- **The relay key** is `<socket dir>/relay-key`: 32 random bytes as hex, mode 600.
  - Following the widget key's pattern, it opens only the `/messages/` routes.
  - It gets 401 everywhere else, and the Mac and phone tokens get 401 on `/messages/`.
  - It's compared in constant time with the others in `authorized()`.
- **Routes:**
  - `POST /messages/in` `{id, from, text, picture?}`. The `id` is the message's chat.db `guid`.
  - `GET /messages/out?wait=25` returns `{texts: [{id, text}]}`. It holds the request up to 25 s until
    there's something to send.
  - `POST /messages/out/<id>/sent` removes that text from the outbox.
  - When messages is off, every route answers 403 `"messages is off"`. The relay logs it and skips texts.
- **The outbox** is `<socket dir>/messages.json` (mode 600), holding the outbox, the seen ids and the last
  sent turn. It survives a blimpd restart.
  - A text is removed only after the relay says it was sent. The worst case after a crash is one text sent
    twice, never one lost.
  - A send that fails is retried, with the gap growing up to 1 minute.
- **If the server can't be reached,** the relay keeps unsent incoming texts in its state file and posts them
  when it's back.
- **Offline alert:** blimpd notes when the relay last called.
  - If Messages is on and the relay hasn't called for 5 minutes, it sends one push: "Messages relay is
    offline. Sign the Assistant user back in on the work Mac."
  - The alert goes out once per outage. The first check is 5 minutes after blimpd starts.
  - It's sent through the same APNs client the test push (`blimpd push test`) uses.

## 4. Setup

**Max** (at the work Mac or over Screen Sharing from the MacBook Air):
1. Make an Apple ID from an email address. His own number works for its verification.
2. On the work Mac, add the standard user "Assistant". Sign in to it, open Messages and sign in with the new
   Apple ID.
3. Still as Assistant, run `bash /Users/Shared/blimp-relay/install.sh`, then grant the two permissions when
   asked.
4. Switch back to his own user, leaving Assistant signed in.
5. Save the address as "Assistant" on his phone and text it.
6. Tell Claude the phone number and Apple ID emails he texts from, for the allowlist.

**Claude:**
- Build, test, and copy the bundle to `/Users/Shared/blimp-relay/` over SSH as `mbeato`: the binary,
  `install.sh`, and `relay.json` holding the server URL, key and allowlist.
- `install.sh`:
  - copies the binary into the Assistant user's home;
  - moves `relay.json` there with mode 600 and deletes the shared copy;
  - writes and loads the LaunchAgent;
  - reveals the binary in Finder and opens the Full Disk Access pane;
  - runs `blimp-relay --check` (one read and one send to Max), which raises the Automation prompt.
- The key never appears in chat.
- Then `blimpd messages on` on claude1, and watch the first texts go through.

## Build steps (each usable on its own)

1. **The relay in echo mode** (`relay/`, `install.sh`), installed by Max's setup. Max switches to his own
   user and texts "ping". "got: ping" coming back proves that reading and sending work for a background user.
   If it fails, use the fallback in Decisions before building more.
2. **blimpd: texts in and answers out.**
   - The routes and the relay key.
   - The outbox.
   - Typing texts in.
   - Texting finished turns.
   - `blimpd messages`.
3. **blimpd: approvals by text, the push change, the offline alert, and blimp.md's Messages section.**
4. **Connect:** point the relay at the server, turn it on, and run the live check below.

## Tests

- **relay/ (bun test):**
  - The allowlist and the drop rules (group, reaction, `is_from_me`).
  - Decoding `attributedBody`.
  - The ROWID watermark, including the first run.
  - Each of these runs against a small sample chat.db made in the test with the same tables.
  - The osascript call is a fake that records the arguments it got.
- **src/ (bun test):**
  - Texts in:
    - a repeated id;
    - the assistant off;
    - a picture with and without words;
    - held while an untexted wait is on.
  - Answers out:
    - one text per turn;
    - an empty reply;
    - Markdown made plain with line breaks kept.
  - Approvals:
    - the yes/no words;
    - a number in range;
    - other words as a deny or as text;
    - "That was already answered.";
    - a multi-part question.
  - The outbox kept across a restart and removed only on `sent`.
  - The relay key refused outside `/messages/`, and the other tokens refused on it.
  - The push rule with Messages live and not live.
  - The offline alert sent once.
- **e2e:** blimpd with a fake relay (HTTP calls) and a fake Claude session, in the existing e2e style:
  - a text in is typed;
  - a turn's reply comes out;
  - a permission wait is texted, and "yes" answers it.
- **By hand on the Mac:** step 1's echo test, then the live check.

## Done when (on claude1 and Max's phone)

- Max texts "Assistant" from his phone and gets the assistant's answer back as a text.
- When the assistant needs an OK, he replies "yes" and it goes ahead.
- A job's report arrives as a text.
- A text from another number never reaches the assistant.
- Stopping the relay for 5 minutes sends one "offline" alert.

## Not doing (now)

- Pictures and files, in either direction.
- Group chats.
- The spare AT&T number and SMS.
- A Messages switch in the apps' Settings.
- Signing the Assistant user in automatically after a restart.
- Telegram or other chat apps.
