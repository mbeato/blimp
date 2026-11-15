# Phone attach: send photos and videos to a session from the iPhone's chat

Date: 2026-11-15. Branch `phone-attach` (after `visuals-3d`). Size: M.

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

## Spike first (not done yet)

With a real Claude Code session, through the chat socket's writes:

1. A paste of only image paths, then a paste of the text and Enter: do the pictures attach (`[Image #1]`) as they
   do for the Mac's drop? If the two pastes must be apart in time, how long?
2. What the transcript holds for that message, so the chat can show the pictures. A dropped screenshot is recorded
   as a text block `[Image: source: <path>]`; the entry that carries the typed words needs checking.
3. A video's path: it should stay as text, and Claude should read frames from it when asked.
4. While Claude is working: the message is queued, as text is. Do its pictures stay with it?

The design below assumes 1 works. If it doesn't, the paths go in the text and Claude reads the files itself, which
can ask for permission, and the plan changes.

## The server

- **`POST /uploads?name=<name>`** (Mac or phone token), the file as the body: saves it in `~/.blimp/uploads` under
  a plain, free name (`plainName` and `freeName`'s rules, moved from the Mac app's `transfers.ts` to the server
  for this route; the Mac keeps its own calls), making the folder if it isn't there. At most 2 GB, as
  `PUT /fs/upload`. Returns `{ path }`.
- **The chat socket's `input` message gains `files`**: a list of at most 10 paths, each an existing file in
  `~/.blimp/uploads` (anything else is refused, and nothing is typed). blimpd types the paths as one paste, then
  the text as another with its Enter, in one write if the spike allows. `text` may be empty when there are files.
- **The chat** (`chat.ts`): a picture in a user's message becomes `image: <path>` on that message when the path is
  in `~/.blimp/uploads`. The text stays as it is, so an app from before this change shows what it shows today.
- **`GET /uploads/<name>`** (Mac or phone token): the file, for the chat's pictures. Only that folder.
- **Clean-up:** files in `~/.blimp/uploads` older than 30 days go, when blimpd starts and once a day.

## The phone

- **A + button at the start of the message box.** A tap opens a menu: Photo Library (the system's picker, photos
  and videos, several at once, no permission needed) and Camera (a photo or a video).
- **What you picked sits in a row above the box**, each as a small picture with × to remove it, and a ring while
  it uploads. Uploading starts when you pick, so Send is quick. A failed one shows a retry mark.
- **Send** is on once there's text or a file. Tapped while files are still uploading, it waits for them, then
  sends. The row and the box clear together when blimpd has the message.
- **Refused on the phone, with words that say why:** over 10 files; a video over 500 MB after it's made smaller;
  a blimpd from before this change ("Update blimpd on the server to send photos").
- **In the chat**, your message shows its pictures above its words, each a small picture loaded from blimpd when
  it comes on screen; a tap shows it full screen. A video shows as a row with a film symbol and its name. Once the
  file is gone from the server: a grey box, "No longer kept".
- **Kept per chat**, as the typed draft is: the row survives leaving the chat and coming back while the app runs.
- **Permissions:** `NSCameraUsageDescription` gets new words that cover photos and videos for a session, not only
  the pairing code. The microphone's words already cover a video's sound.
- Not while Claude asks something: as with text, the message isn't sent ("Claude is asking something. Answer it
  first."), and the row stays.

## The Mac

Nothing changes. Its drop keeps its own upload calls; it could move to `POST /uploads` later.

## Tests

- Server (`bun test`): `POST /uploads` (a plain free name, the folder made, the size cap, each token);
  `GET /uploads/<name>` (the file; `..` and other folders refused); the socket's `files` (typed as the spike
  settles; a path outside the folder, a missing file and an 11th file refused); chat.test.ts (a picture becomes
  `image`, one outside the folder doesn't); the 30-day clean-up.
- BlimpKit (`swift test`): the `input` message with `files`; the message's `image`; a photo's size after scaling;
  the upload's name.
- Phone UI test: the picker can't be driven in the simulator, so the test build takes a file from `$E2E_WORK` by
  a launch argument; the row shows it, Send types the path into demo-chat's fake session, and the chat shows the
  picture.
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
