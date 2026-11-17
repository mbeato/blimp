# Account switching

Date: 2026-11-16. Built 2026-11-16. Asked by Max: when a Claude account runs out of usage, he logs in to another one by hand (`/login`). blimp should do it. He picked: switch by itself and then tell him; tell the sessions that stopped on the limit to continue; no main account (stay on the account switched to until it runs out).

This is the first of three pieces he asked for the same day. The other two get their own specs: connectors that survive a switch, and the right model for each kind of task.

Ground rule: a login is a secret. Saved logins live on the server in a 700 folder, 600 files, and no route, log or command output ever carries one. Switching is off until `config.json` has `"accounts": true`.

## What is true on claude1 today (checked 2026-11-16, Claude Code 2.1.325)

- One config folder for every session (`~/.claude`), so every session shares one account at a time.
- A login is two things: `<claude dir>/.credentials.json` (600; `claudeAiOauth` with the access token, the refresh token and both expiry times; no account id in it; it can hold other sign-ins too, such as `mcpOAuth` for MCP servers: read from the 2.1.325 binary, not from its docs) and the `oauthAccount` object in `.claude.json` (`accountUuid`, `emailAddress`, organisation, plan).
- The access token lasts about 7 hours; the refresh token about 30 days.
- Running sessions follow a `/login` made in another session with no restart (Max, and seen in the session this was written in). Claude Code keeps the file's mtime and reloads when it changes (`lastCredentialsMtimeMs` in the binary). It opens the file with `O_NOFOLLOW`, so the file must stay a regular file, never a symlink.
- The `StopFailure` hook fires when a turn ends on an API error. Its input has `error` (`rate_limit` for a 429, `billing_error`, `overloaded`, `authentication_failed`, …), and optionally `error_details` and `last_assistant_message`.
- Claude Code has its own wait: after a limit it can arm a timer and resume when the limit resets (the `quota_auto_resume_*` notifications). What it shows on screen while armed is not known yet.

## Tested 2026-11-16 (two real logins, a throwaway session in its own config folder)

1. **The file is enough.** With the session running on the personal login, the work account's `.credentials.json` was put in place by a rename. The session's next turn ran on the work account: the status line's `rate_limits.seven_day` went from the personal account's numbers to the work account's. No restart, no key pressed.
2. **`oauthAccount` does not correct itself.** After the swap it still named the personal account. So after a swap by blimp, `.claude.json` (and what a session shows as its account) can name the wrong one. blimp does not write `.claude.json`, a file every session rewrites: `state.json`'s `active` is the truth, and `blimpd accounts` says which account is in use. This held for the test, but it is true only for about a day. Read from the 2.1.325 binary, not from its docs (2026-11-16): Claude Code re-fetches the profile at a process start once `profileFetchedAt` is more than 24 hours old and writes the record back, so the record follows the live login within about a day. It also rewrites the record by itself in some cases at a token refresh. So a changed record is not a sign of a `/login` (see Saving).
3. **No write-back seen.** The session did not rewrite the login file in the 30 seconds after the swap. Its old token was hours from expiry, so a renewal was not due; the log (below) notes any change to the live file blimp did not make.

## Still to find out

5. **At the first real limit** (cannot be forced): what `StopFailure` sends (`error`, the message, a reset time or none) and what the session shows. blimp writes these down (see Log) so the first one answers it.

## Saved accounts

Off unless `<socket dir>/config.json` has `"accounts": true`. It is checked every second, so turning it on needs no restart. Until then nothing is filed or switched. `blimpd accounts` says it is off and how to turn it on; `account use` and `forget` work either way.

`<socket dir>/accounts/` (700). One folder per account, named by `accountUuid`: `credentials.json` (only `{ "claudeAiOauth": ... }`, 600), `account.json` (the `oauthAccount` object, 600) and, once a different login has replaced it, `credentials.prev.json` (600, the one replaced, kept once, so a wrong save can be undone by hand). `state.json` there: `{ active, order, out: { <uuid>: { at, until } }, switchedAt, filed: { mtime, at }, unknown, renewed: { id, at } }`. `order` is the order accounts were added; `filed` is the live file's mtime when blimp last settled who is in use, and when it did; `unknown` is `true` while blimp can't tell whose login is in place; `renewed` is the last change filed as a renewal (both below). The file routes refuse the folder (`secretPaths`), and the folder listings and the file list leave it out, as with `secrets`.

- **Saving.** blimpd looks at the live file's mtime every second. First: if the live login is exactly another saved account's, a swap happened and blimp's note of it was lost; that account is taken as `active` and nothing is saved (log `adopted`; checked at once and on the first tick after a start). Any other change is filed once it is 30 seconds old, because a `/login` writes its record first, then its login file, and its note last, after network calls that can take 20 seconds (read from the 2.1.325 binary); a switch waits while a change is unfiled. Whose login it is:
  1. Claude Code fires its Notification hook with `notification_type: "auth_success"` when a `/login` succeeds. `blimpd hook` writes `<socket dir>/auth-success.json` with the time and the Claude folder it ran for (`dir`). A session with another config folder (`CLAUDE_CONFIG_DIR`) runs the same hook, so blimpd ignores a note whose `dir`, as a real path, is not its own Claude folder's, and a note with no `dir`.
  2. A note newer than blimp's last settle (`filed.at`) makes the change a `/login`. Its owner is the account `.claude.json`'s `oauthAccount` names, once that record's `profileFetchedAt` is newer than the settle. Until then blimp waits. If the record has not followed within 60 seconds (the profile request failed, so the record has no `profileFetchedAt`), nothing is saved and blimp can't tell whose login is in place (below).
  3. With no such note it is a renewal: saved under `active`. The record is not consulted. With no account in use yet, the record names the owner. While blimp can't tell whose login is in place, it is held instead (below).
  4. The login's `claudeAiOauth` is saved; a different one already there is kept once as `credentials.prev.json`. A `/login` also sets `switchedAt`, so it gets the quiet time (Switching, step 5).

  Why not "the record changed": Claude Code rewrites `oauthAccount` by itself (about once a day at a process start, and in some cases at a token refresh), so a changed record does not mean a login. A login where Claude Code fires no hook (`claude auth login` in a plain shell) is taken for a renewal; `blimpd account use <email>` or a `/login` in a session puts it right. Adding an account is `/login` in a session, nothing else. Don't use `/logout` on an account blimp keeps: it revokes the login on Anthropic's side (read from the 2.1.325 binary), so the saved copy stops working. Change accounts with `/login`, and drop one with `blimpd account forget`.
- **When blimp can't tell whose login is in place** (`unknown`). Set when a `/login`'s record never followed (step 2): log `unknown`, `why: "login without a record"`. `active` is removed, and one notification goes to the phone: "blimp can't tell which account is logged in" ("The last /login was not saved. Run blimpd account use <email>, or /login again in a session."). While it is set, a changed live login is filed only when its owner is certain: it equals a saved login (adopted), or a note newer than `filed.at` comes with a fresh record (a `/login`). Anything else is held: noted as settled, saved under nobody, logged `held`. Nothing switches (Switching, step 2). It is cleared by an adoption, by such a `/login`, or by `blimpd account use`.
- **A late note**: a note newer than `filed.at` with no change left to file, so a `/login`'s change may have been filed as a renewal before its note came. Each renewal-filing notes `renewed`: the account it was saved under and the live file's mtime for that change (`at`); the next one replaces it, and no login is in it. blimp never moves or restores a saved login by itself: a late note changes no file, `active` stays, and `unknown` is not set. The note is used up (`filed.at` is now) and `renewed` is removed. If the note is at or after `renewed.at` and less than 5 minutes after it (a `/login`'s note can't come later), one notification goes to the phone: "A /login may have been saved under the wrong account" ("Log in to <email> again with /login in a session.", the account `renewed` named, or its id). Otherwise nothing is told. The log gets `late login notice` with `account` and `told`.
- **Before every swap** blimpd files the live file this way first, so the copy it will put back later has the newest refresh token.
- A saved login whose refresh token has expired can't be switched to. The list says so, and the next `/login` to that account replaces it.

## Noticing the limit

`StopFailure` joins blimp's Claude hooks (`install-hooks` adds it; Codex is untouched). `blimpd hook` writes the session's status as a finished turn, as `Stop` does, plus `failure: <error>`, `details`, `message` (each cut to 300 characters). `rate_limit` and `billing_error` mean the account is out. The other errors change nothing here.

Only some stops count. The session must be of kind `claude` (a `claude-glm` session's limit is another provider's). The status file must be one the session wrote itself: its `at` is not older than the session, and the session has a conversation id. A file left by an earlier session of the same name is ignored, and so is a stop from before blimpd started. Each stop (a session and its `at`) asks for a switch once.

## Switching

When a session reports the account is out:

1. Mark the active account out: `at` now, `until` 5 hours on. (Once finding 5 shows how the hook's message gives the reset time, `until` becomes that time.)
2. File the live file (above). If a change is still unfiled, wait for the next tick. While blimp can't tell whose login is in place, don't switch: nothing is marked out, no next account is picked, nobody gets `continue`, and the stop asks again once the owner is known.
3. Pick the next saved account that isn't out and whose login hasn't expired, in the order they were added, starting after the active one. None: don't switch; one notification, "Every Claude account is out" ("Claude Code carries on by itself when a limit resets."). blimp does not check again on a timer: the next limit stop does, and Claude Code's own wait resumes sessions when a limit resets. There is no automatic switch back.
4. Put the picked login in place: read `<claude dir>/.credentials.json`, replace only its `claudeAiOauth` key (every other key, such as `mcpOAuth`, stays), write it through a temp file (600) and a rename, and set `active`. `.claude.json` is not touched (finding 2).
5. A limit stop in the 30 seconds after a switch, or after a login by hand, does not start another one: it is a request that left before the swap.
6. **Continue.** After a switch, wait 3 seconds and look again (the session list is tried 3 more times, 1 second apart, if it can't be read; still unread, nobody is typed into and the notification says so). Every session still stopped on that same limit gets `continue` and Enter (`typeInto`). A session whose screen shows a menu or a confirm dialog, or whose screen can't be read, is left alone and counted in the notification. With no switch in the tick, only a stop inside the 30 seconds after the last switch that is also under a minute old gets `continue`, so a restart does not type into an old stop. Each stop gets it at most once. If finding 5 shows a menu at a limit, the right keys go here.
7. **Tell him.** One notification to the phone: "Now on <email>", body "<old email> ran out. 3 sessions continued." (plus " N left as they were." when some were left alone; "No session was waiting on it." when none; "blimp could not read the sessions, so none was continued." when it could not look). An account with no email goes by its id. The Mac app raises its own notifications from the session list, so a Mac one needs an app change; it is not in this version.

## By hand

- `blimpd accounts`: each account's email (or id), which is active, out until when, when its login expires. Never a token. While blimp can't tell which account is logged in, none is shown in use and a line after the list says so.
- `blimpd account use <email or id>`: file, then step 4 now. No `continue`, no phone notification; it prints what it did and logs a `switch` with `byHand`. It refuses while a change to the live file is under 30 seconds old ("a login is still settling; try again in <n> seconds"), and while a login made a moment ago is not saved yet. While blimp can't tell whose login is in place, it works and clears that; the login that was in place is saved under nobody, and it says so first.
- `blimpd account forget <email or id>`: removes its folder. Not the active one.

## Log

`<socket dir>/accounts/log.jsonl` (600; past 1 MB it becomes `log.1.jsonl`): one line per event, with its time. Events: `stop` (session, `error`, `details`, `message`, account), `switch` (from, to, `byHand`), `login`, `renewal`, `adopted`, `unfiled` (a change with nobody to file it under, or no login in it), `unknown` (`why`), `late login notice` (`account`, `told`), `held`, `not continued` and `error` (the same text again only after 10 minutes). Ids, emails and the hook's text only, never a token. It answers finding 5 and says why a switch did or didn't happen. Finding 3 (a change to the live file blimp did not make) shows as a `renewal`, `login`, `unfiled` or `held` line.

## Not in this version

- An accounts screen in the Mac and iPhone apps, and a Mac notification.
- Switching before the limit from the status line's `rate_limits` numbers.
- Different accounts for different projects at the same time (needs a config folder per session).

## Docs

SECURITY.md gets a row for saved logins (where, modes, that the file routes refuse the folder and the listings leave it out, as with `secrets`). DESIGN.md gets an Accounts section. README gets a short paragraph.

## Tests

- Server tests, each in a temp config folder with made-up tokens: saving a new login, a renewal, and a login whose `oauthAccount` arrives late; modes 700/600; the swap is a rename, leaves a regular file and keeps the file's other keys (`mcpOAuth`); picking the next account (order, out, expired, none left); the 30-second rule; several sessions stopping at once give one switch; `continue` goes only to limit-stopped sessions (a fake typist) and never to one that is asking; the hook's `StopFailure` status for each `error`; `blimpd accounts` output and the log never contain a token; the fs routes refuse the folder.
- By hand on claude1: `blimpd account use` with real sessions running, then a turn in each; finding 5 at the first real limit, read from the log.
