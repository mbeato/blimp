# A project's inbox: what's waiting, in progress and done

## What Max asked for

The phone opens a project to an empty chat. It should be more of an inbox per project: what each session is
doing, kept up to date by a small model call when a turn ends. Max picked, in order:

- a summary of the whole project on top, the session rows below it;
- "since you last looked": a Done line stays until you open that session, like the blue dot;
- the phone and the Mac (on the Mac, at the top of the session list);
- every line in the summary opens the session it's about.

## Notes (blimpd)

When a Claude session's turn ends (state `done` or `waiting`, and its transcript has a prompt or a reply it
didn't have at the last note), Haiku reads the turn and writes the session a note: a status and at most about 8
words.

- `src/notes.ts`, run like the names (`src/names.ts`): a loop every 5 s, one call at a time, at most 120 an
  hour, on your own Claude sign-in through `askClaude` (no tools, no MCPs, no hooks, nothing saved). Off with
  `{"names": false}` in config.json, the same switch as names.
- What Haiku reads: the session's title, the latest 3 requests and Claude's latest reply, each cut to about
  300 characters (the names' `Summary`, no tool calls or output).
- Its answer: one line, `DONE | <words>`, `PROGRESS | <words>` or `QUESTION | <words>`. DONE: Claude did what
  was asked and waits for the next request. PROGRESS: the work isn't finished (Claude stopped part way, or says
  what it does next). QUESTION: Claude asks you something or waits for a decision. Anything else is a failed
  try; a failed session waits 10 minutes or its next turn, whichever is later.
- `<socket dir>/notes.json`: `{ "<sessionId>": { "status": "done" | "progress" | "question", "text": string,
  "at": ms, "turn": "<prompts>/<replies>" } }`, 600, through a temp file, the 500 newest kept.
- `GET /sessions` and `GET /conversations` carry each one's `note` (`{ status, text, at }`), none while names
  are off.

## The summary (both apps, the same rules)

From the project's running sessions and its Earlier conversations (those no running session has open):

- **Waiting on you**: a running session that waits (the amber question mark), or one that's done with a
  `question` note. Its words: what the prompt asks (a permission's summary, a question's text), else the
  note, else nothing.
- **In progress**: a running session that's working, or done with a `progress` note. Its words: the note.
- **Done**: a running session that's done and unread, or an Earlier conversation that's unread, unless its
  note puts it above. Its words: the note.

Each line: the session's title, then its words. Waiting on you first, then In progress, then Done; within each,
newest activity first. A heading with nothing under it isn't shown; with nothing at all, no summary.

A tap or click on a line opens that session: on the Mac as a click on its row (or on its Earlier row, which
resumes it); on the phone its chat (or the past conversation to read). Opening it marks it seen, as now, so a
Done line goes.

## Mac app

At the top of the session list, above the rows: the summary, folding to one line ("1 waiting · 1 in progress ·
2 done") with a chevron. Folded or not is remembered per window in localStorage.

## Phone app

Opening a project (at launch, or from the picker) shows its inbox: New chat at the top, the summary, then the
project's sessions and past conversations as the drawer lists them. The picker's subtitle says "Inbox". The
toolbar's New chat still opens a blank chat, and the drawer gets an Inbox row at the top.

## Tests

- Server: when a note is wanted (the turn changed, not mid-turn, not a shell, failed waits); the prompt; the
  answer parsing; notes.json; a tick writes a note with a fake model and none when it fails or names are off;
  `/sessions` and `/conversations` carry notes.
- The summary rules: in TypeScript (app) and Swift (BlimpKit), the same cases.
- App e2e: the summary shows and a click opens the session; it folds. iPhone e2e: the project opens to the
  inbox, a tap on a line opens that chat.

## Not doing

- A second model call to merge notes into prose.
- Notes for shells or other kinds that aren't Claude Code.
- A summary across all projects.
