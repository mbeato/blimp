# Phone attach: send photos and videos to a session from the iPhone's chat

Date: 2026-11-15. Branch `phone-attach` (on top of `visuals-3d`). Size: M. Built 11/15; as built.

## Why

Max: "i need a way to upload photos + videos from mobile chats", then "don't forget about the ability to upload
images to sessions from the mobile app". In the apartment session a broker texted him a video of a flat, and the
phone's chat had no way to pass it on.

Today the phone's chat sends text only. On the Mac you drop a file on a terminal: the app uploads it to
`~/.blimp/uploads` and types its path in, and Claude Code attaches a picture from a path it's given
(`TerminalPane.tsx` `uploadInto`). The phone has no way in.

## Decisions (11/15; the starred ones are mine, for Max to confirm)

- **The phone does what the Mac's drop does**: the file goes to `~/.blimp/uploads` on the server and its path goes
  to the session with the message. One place for both apps, and any agent can read a file from a path.
- **A photo is sent as a JPEG, at most 2048 px on its long side.*** An iPhone's HEIC isn't a format Claude reads,
  and Claude scales pictures down further anyway.
- **A video is sent as an MP4 at 720p, at most 500 MB.*** Claude can't watch a video, but it can pull still
  pictures out of one with ffmpeg on the server, as the apartment session did. A model that can watch gets the
  file itself.
- **Up to 10 files on one message.***
- **Files in `~/.blimp/uploads` are removed after 30 days.*** Nothing removes them today (18 screenshots since
  October), and videos are large. This also removes what the Mac dropped.

## Spike (11/15, done, with a real Claude Code 2.1.325; kept as `test/real-claude-files.test.ts`)

1. A pasted path of a picture is attached (`[Image #1]` in Claude Code's box), but a moment after the paste: with
   the next part typed 50 ms later, the second of two pictures arrived after the message had gone, and stayed in
   the box. So blimpd waits after each picture's paste until the box shows a new `[Image #n]` (it reads what its
   own zmx client is sent to draw), or 5 s. With that, two pictures and the words arrive together, in order, and
   Claude names what's in them without running a tool.
2. The transcript holds the prompt as the words with the marks in them (`[Image #1]what is this`), the picture
   itself, and `imagePasteIds`; then an entry of Claude Code's own (`isMeta`) with `[Image: source: <path>]` for
   each picture. The chat makes its cards from that entry, so a picture dropped from the Mac gets one too.
3. A path that isn't a picture's (`.mp4`) stays in the words as text, and Claude repeats it exactly.
4. Not tried: a message with pictures while Claude is working (it is typed the same way; text alone is queued
   by Claude Code then). It's on the checklist.

## The server

- **`POST /uploads?name=<name>`** (Mac or phone token), the file as the body: saves it in `~/.blimp/uploads` under
  a plain, free name (`plainName` and `freeName`'s rules, moved from the Mac app's `transfers.ts` to the server
  for this route; the Mac keeps its own calls), making the folder if it isn't there. At most 2 GB, as
  `PUT /fs/upload`. Returns `{ path }`.
- **The chat socket's `input` message gains `files`**: a list of at most 10 paths, each an existing file in
  `~/.blimp/uploads` (anything else is refused, and nothing is typed). blimpd types each path as a paste of its
  own, waits for a picture to be attached (the spike's 1), then types the text with its Enter. `text` may be
  empty when there are files.
- **The chat** (`chat.ts`): a file you sent is a message of its own, `{ role: "file", file, name, image?, summary,
  gone? }`, after your words: a picture from Claude Code's note of where it came from, any other file from its
  path in the words. The marks and the paths leave the words. An app from before this change hides the new role.
- **No new route to read a picture:** the phone asks `GET /fs/file?path=`, which it could already.
- **Clean-up:** files in `~/.blimp/uploads` older than 30 days go, when blimpd starts and once a day.

## The phone

- **A + button at the start of the message box.** A tap opens a menu: Photo Library (the system's picker, photos
  and videos, several at once, no permission needed) and Camera (a photo or a video).
- **What you picked sits in a row above the box**, each as a small picture with × to remove it, and a spinner while
  it uploads. Uploading starts when you pick, so Send is quick. A failed one shows a retry mark.
- **Send** is on once there's text or a file. Tapped while files are still uploading, it waits for them, then
  sends. The row and the box clear together when blimpd has the message.
- **Refused on the phone, with words that say why:** over 10 files; a video over 500 MB after it's made smaller;
  a blimpd from before this change ("Update blimpd on the server to send photos").
- **In the chat**, your message shows its files after its words, each picture a small picture loaded from blimpd
  when it comes on screen; a tap shows it full screen. A video shows as a row with a film symbol and its name. Once
  the file is gone from the server: its name, greyed, "No longer kept".
- **Kept per chat** while the app runs (on the chat's model, as its messages are): the row survives leaving the
  chat and coming back. Not across a cold launch, as the typed draft is.
- **Permissions:** `NSCameraUsageDescription` gets new words that cover photos and videos for a session, not only
  the pairing code. The microphone's words already cover a video's sound.
- Not while Claude asks something: as with text, the message isn't sent ("Claude is asking something. Answer it
  first."), and the row stays.

## The Mac

Nothing changes. Its drop keeps its own upload calls; it could move to `POST /uploads` later.

## Tests

- Server (`bun test`): `POST /uploads` (a plain free name, each token, `GET /fs/file` reads it back); the socket's
  `files` against a stand-in that attaches a picture 300 ms after its paste (the parts in order, Enter only after
  both marks; a path outside the folder, a missing file and an 11th file refused); chat.test.ts (a picture's and a
  video's cards, the marks and paths out of the words, one outside the folder not); the 30-day clean-up.
- Real Claude Code, opt-in (`BLIMP_REAL_CLAUDE=1 bun test test/real-claude-files.test.ts`): the spike's 1 to 3.
- BlimpKit (`swift test`): the `input` message with `files`; the message's `image`; a photo's size after scaling;
  the upload's name.
- Phone UI test (`testSendAPhoto`): the picker can't be driven in the simulator, so with `-attachDemo YES` + adds
  a picture made in the app; the row shows it uploaded, Send types its path into demo-chat's stand-in with the
  words, and the chat shows both.
- PHONE-CHECKLIST.md: "send a photo, three photos, a video and a camera shot, on Wi-Fi and cellular; ask what's
  in them".

## Docs

DESIGN.md (the routes, the socket's `files`, the clean-up), SECURITY.md (what the phone token can now write),
README.md and ios/README.md.

## Not in this change

- Other files from the phone (PDFs, the Files app).
- Pasting a picture into the box.
- A picture Claude sends back shown in the chat (a tool's image is still "[image]").
- Photos to Codex sessions: the phone's chat reads Claude Code's transcripts only.
- Pulling a video's frames on the phone or in blimpd before Claude sees it.
