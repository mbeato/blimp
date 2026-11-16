# Account switching

Date: 2026-11-16. Asked by Max: when a Claude account runs out of usage, he logs in to another one by hand (`/login`). blimp should do it. He picked: switch by itself and then tell him; tell the sessions that stopped on the limit to continue; no main account (stay on the account switched to until it runs out).

This is the first of three pieces he asked for the same day. The other two get their own specs: connectors that survive a switch, and the right model for each kind of task.

Ground rule: a login is a secret. Saved logins live on the server in a 700 folder, 600 files, and no route, log or command output ever carries one.

## What is true on claude1 today (checked 2026-11-16, Claude Code 2.1.325)

- One config folder for every session (`~/.claude`), so every session shares one account at a time.
- A login is two things: `<claude dir>/.credentials.json` (600; `claudeAiOauth` with the access token, the refresh token and both expiry times; no account id in it) and the `oauthAccount` object in `.claude.json` (`accountUuid`, `emailAddress`, organisation, plan).
- The access token lasts about 7 hours; the refresh token about 30 days.
- Running sessions follow a `/login` made in another session with no restart (Max, and seen in the session this was written in). Claude Code keeps the file's mtime and reloads when it changes (`lastCredentialsMtimeMs` in the binary). It opens the file with `O_NOFOLLOW`, so the file must stay a regular file, never a symlink.
- The `StopFailure` hook fires when a turn ends on an API error. Its input has `error` (`rate_limit` for a 429, `billing_error`, `overloaded`, `authentication_failed`, …), and optionally `error_details` and `last_assistant_message`.
- Claude Code has its own wait: after a limit it can arm a timer and resume when the limit resets (the `quota_auto_resume_*` notifications). What it shows on screen while armed is not known yet.

## Tested 2026-11-16 (two real logins, a throwaway session in its own config folder)

1. **The file is enough.** With the session running on the personal login, the work account's `.credentials.json` was put in place by a rename. The session's next turn ran on the work account: the status line's `rate_limits.seven_day` went from the personal account's numbers to the work account's. No restart, no key pressed.
2. **`oauthAccount` does not correct itself.** After the swap it still named the personal account. So after a swap by blimp, `.claude.json` (and what a session shows as its account) can name the wrong one. blimp does not write `.claude.json`, a file every session rewrites: `state.json`'s `active` is the truth, and `blimpd accounts` says which account is in use.
3. **No write-back seen.** The session did not rewrite the login file in the 30 seconds after the swap. Its old token was hours from expiry, so a renewal was not due; the log (below) notes any change to the live file blimp did not make.

## Still to find out

4. **How long after `.credentials.json` a `/login` writes `oauthAccount`.** Seen at one login: `oauthAccount.profileFetchedAt` was in the same second as the file's mtime. When `.claude.json` itself was written was not timed, so the save rule below allows 2 minutes.
5. **At the first real limit** (cannot be forced): what `StopFailure` sends (`error`, the message, a reset time or none) and what the session shows. blimp writes these down (see Log) so the first one answers it.

## Saved accounts

`<socket dir>/accounts/` (700). One folder per account, named by `accountUuid`: `credentials.json` (the file as it was, 600) and `account.json` (the `oauthAccount` object). `state.json` there: `{ active, out: { <uuid>: { at, until } } }`.

- **Saving.** blimpd looks at the live file's mtime every few seconds. A change it did not make itself is filed 2 minutes later, or at the next swap if that comes first. If `oauthAccount` in `.claude.json` also changed since blimpd last filed, it was a `/login`: the live file is saved under that `accountUuid` (a new folder for a uuid not seen before) and that account becomes `active`. If `oauthAccount` did not change, it was a session renewing the token: the live file is saved under `active`. Adding an account is `/login`, nothing else.
- **Before every swap** blimpd files the live file this way first, so the copy it will put back later has the newest refresh token.
- A saved login whose refresh token has expired can't be switched to. The list says so, and the next `/login` to that account replaces it.

## Noticing the limit

`StopFailure` joins blimp's Claude hooks (`install-hooks` adds it; Codex is untouched). `blimpd hook` writes the session's status as a finished turn, as `Stop` does, plus `failure: <error>` and the time. `rate_limit` and `billing_error` mean the account is out. The other errors change nothing here.

## Switching

When a session reports the account is out:

1. Mark the active account out: `at` now, `until` 5 hours on. (Once finding 5 shows how the hook's message gives the reset time, `until` becomes that time.)
2. Pick the next saved account that isn't out and whose login hasn't expired, in the order they were added, starting after the active one. None: don't switch; one notification, "Every account is out", until one comes back. Claude Code's own wait still runs.
3. Save the live file (above), then write the picked account's `credentials.json` to `<claude dir>/.credentials.json` through a temp file (600) and a rename, and set `active`. `.claude.json` is not touched (finding 2).
4. A limit stop in the 30 seconds after a switch does not start another one: it is a request that left before the swap. It still gets step 5.
5. **Continue.** A few seconds later, type `continue` and Enter into each session whose last hook event is a limit stop. `typeInto` already refuses a session that is asking something. If finding 5 shows a menu, the right keys go here; until it is known, a session whose screen shows a list of choices (`parseScreenOptions`, prompt.ts) is left alone and counted in the notification.
6. **Tell him.** One notification to the phone: "Now on <email>. <old email> ran out. 3 sessions continued." The Mac app raises its own notifications from the session list, so a Mac one needs an app change; it is not in this version.

## By hand

- `blimpd accounts`: each account's email, which is active, out until when, when its login expires. Never a token.
- `blimpd account use <email>`: steps 3 and 6 now. No `continue`.
- `blimpd account forget <email>`: removes its folder. Not the active one.

## Log

`<socket dir>/accounts/log.jsonl` (600): one line per limit stop, switch and save, with times, account uuids, the hook's `error`, `error_details` and `last_assistant_message`. No tokens. It answers finding 5, notes any change to the live file blimp did not make (finding 3), and says why a switch did or didn't happen.

## Not in this version

- An accounts screen in the Mac and iPhone apps.
- Switching before the limit from the status line's `rate_limits` numbers.
- Different accounts for different projects at the same time (needs a config folder per session).

## Docs

SECURITY.md gets a row for saved logins (where, modes, that the fs routes refuse the folder as they do `secrets`). DESIGN.md gets an Accounts section. README gets a short paragraph.

## Tests

- Server tests, each in a temp config folder with made-up tokens: saving a new login, a renewal, and a login whose `oauthAccount` arrives late; modes 700/600; the swap is a rename and leaves a regular file; picking the next account (order, out, expired, none left); the 30-second rule; several sessions stopping at once give one switch; `continue` goes only to limit-stopped sessions (a fake typist) and never to one that is asking; the hook's `StopFailure` status for each `error`; `blimpd accounts` output and the log never contain a token; the fs routes refuse the folder.
- By hand on claude1: `blimpd account use` with real sessions running, then a turn in each; finding 5 at the first real limit, read from the log.
