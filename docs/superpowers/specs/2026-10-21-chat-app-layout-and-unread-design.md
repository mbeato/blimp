# Phone as a chat app, and unread shared between Mac and phone

Date: 2026-10-21. Status: design, waiting for Max's OK.

## What Max asked for

- The phone app looks like ChatGPT or Claude: open it and you get a blank chat. Typing there starts a new session.
- A project picker at the top. A drawer from the left lists that project's sessions, the most recently active first.
- A past conversation opens so you can read it. Claude starts again only when you send something.
- A session asking a question shows an amber question mark, not a dot.
- A session with something new you haven't read (Claude finished, or replied) shows a blue dot.
- Read and unread are the same on the Mac and the phone. Reading it on one clears it on the other.

## The marks (both apps)

| Session is…                                  | Mark                  |
|----------------------------------------------|-----------------------|
| Asking you something (permission, question)  | amber question mark   |
| Has a reply you haven't seen                 | blue dot              |
| Working                                      | spinner (as now)      |
| Nothing new                                  | no mark               |

A question beats unread: a session that asks and has a new reply shows the question mark.

## Unread: what it means

- **Unread** = Claude wrote a reply after the last time you had that session on screen, on either app.
  A reply is Claude's text, not its tool steps. A finished turn always ends with one, so "it finished"
  shows as unread too.
- **Read** = the session was on screen: its chat is open on the phone with the app in front, or its
  terminal is the visible tab in a Mac window. While it stays on screen, new replies are read as they come.
- Your own messages never make a session unread.

## Server (blimpd)

1. **Seen times.** blimpd keeps, per Claude conversation (its `sessionId`, so it survives Resume and an
   ended session), the time of the newest reply you have seen. File: `~/.blimp/seen.json`. On first run
   every existing conversation counts as read, so nothing old gets a blue dot.
2. **Last reply time.** blimpd already reads each transcript for its title, a little at a time. The same
   pass notes the time of Claude's newest text reply.
3. **In the session list**, each session gets `unread: true/false`. The list of past conversations gets it too.
   Changes go out on /events at once, so both apps update together.
4. **Marking read.** A client sends "seen" for a session while it's on screen: a message on the phone's chat
   socket, and a small POST from the Mac app. blimpd stores the newest reply time it has.
5. **Start with a first message.** Starting a session can carry the first message. blimpd passes it to
   Claude as its first prompt. It goes in as an argument, never pasted into a command line.
6. **Read a past conversation.** A way to get a past conversation's messages without starting Claude,
   in the same shape the chat uses.
7. **Resume with a message.** Resuming can carry the message you typed, so it's sent once Claude is back.

## Mac app

- The session list shows the amber question mark and the blue dot instead of today's waiting dot.
- The visible session in a window (that window not hidden or minimised) is marked read, and stays read
  while you watch it.

## Phone app

**Opening the app:** a blank chat in the project you used last, with the box at the bottom
("Ask Claude in api-server…"). Send starts a session there with that message, and the screen becomes its chat.

**Top bar:**
- Left: the drawer button. It has a blue dot or an amber question mark when any session in another project needs you.
- Middle: the project picker. It shows this project's name; tap for a list of projects (running ones and
  recent folders), each with its mark. Picking one gives a blank chat there.
- Right: a "new chat" button. Gives a blank chat in this project.

**The drawer:** opens with a swipe right from the left edge, or the drawer button.
- This project's sessions, running and past together, the one with the newest message on top.
  The order is the same rule as ChatGPT and Claude: newest activity first.
- Each row: its mark, its name, how long ago. No previews.
- Swipe a running session's row to End it, as now.
- Settings at the bottom of the drawer.

**A past conversation:** opens as a chat you can scroll, with the box at the bottom. Sending a message resumes
it with that message. Until then nothing runs.

**Kept from today:** the chat itself, prompt buttons, voice, Stop, read aloud, the "X is waiting" banner
(a tap opens that session), and the tool steps hidden (from the phone-swipe branch).

**Dropped:** the home screen, the project screen, and swiping between sessions (the drawer uses the same
gesture). The phone-swipe branch also showed that putting each chat in a sideways-scrolling page pushes the
input box off the bottom of the screen.

## Order of work

1. Server: seen times, `unread`, marking read, start with a message, read a past conversation, resume with a message. Tests in `test/`.
2. Mac app: the two marks, and marking the visible session read. Tests in `app/e2e`.
3. Phone: the new layout, the marks, marking read. The phone tests (`ios/BlimpUITests`) are rewritten for the new screens.

Each part is its own branch off `next` and works with the older versions of the others: an app that doesn't
send "seen" just never clears unread, and an older app ignores the `unread` field.

## Not doing

- Previews of the last message in the drawer (Max: not needed).
- Search in the drawer.
- Moving a session between projects.
