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
2. **`oauthAccount` does not correct itself.** After the swap it still named the personal account. So after a swap by blimp, `.claude.json` (and what a session shows as its account) can name the wrong one. blimp does not write `.claude.json`, a file every session rewrites: `state.json`'s `active` is the truth, and `blimpd accounts` says which account is in use.
3. **No write-back seen.** The session did not rewrite the login file in the 30 seconds after the swap. Its old token was hours from expiry, so a renewal was not due; the log (below) notes any change to the live file blimp did not make.

## Still to find out

4. **How long after `.credentials.json` a `/login` writes `oauthAccount`.** Seen at one login: `oauthAccount.profileFetchedAt` was in the same second as the file's mtime. When `.claude.json` itself was written was not timed, so the save rule below allows 2 minutes.
5. **At the first real limit** (cannot be forced): what `StopFailure` sends (`error`, the message, a reset time or none) and what the session shows. blimp writes these down (see Log) so the first one answers it.

## Saved accounts

Off unless `<socket dir>/config.json` has `"accounts": true`. It is checked every second, so turning it on needs no restart. Until then nothing is filed or switched. `blimpd accounts` says it is off and how to turn it on; `account use` and `forget` work either way.

`<socket dir>/accounts/` (700). One folder per account, named by `accountUuid`: `credentials.json` (only `{ "claudeAiOauth": ... }`, 600) and `account.json` (the `oauthAccount` object, 600). `state.json` there: `{ active, order, out: { <uuid>: { at, until } }, switchedAt, filed: { mtime, record } }`. `order` is the order accounts were added; `filed` is the live file's mtime and `oauthAccount` as last filed. The file routes refuse the folder (`secretPaths`), and the folder listings and the file list leave it out, as with `secrets`.

- **Saving.** blimpd looks at the live file's mtime every second. A change it did not make is filed 2 minutes after it was first seen, or at the next swap if that comes first. If `oauthAccount` in `.claude.json` also changed since blimpd last filed, it was a `/login`: the live file's `claudeAiOauth` is saved under that `accountUuid` (a new folder for a uuid not seen before) and that account becomes `active`. If `oauthAccount` did not change, it was a session renewing the token: it is saved under `active`. A login by hand also sets `switchedAt`, so it gets the quiet time (Switching, step 5). Adding an account is `/login`, nothing else.
- **A lost state write.** If the live login is exactly another saved account's, a swap happened and blimp's note of it was lost. The next look takes that account as `active` and saves nothing (log: `adopted`).
- **Before every swap** blimpd files the live file this way first, so the copy it will put back later has the newest refresh token.
- A saved login whose refresh token has expired can't be switched to. The list says so, and the next `/login` to that account replaces it.

## Noticing the limit

`StopFailure` joins blimp's Claude hooks (`install-hooks` adds it; Codex is untouched). `blimpd hook` writes the session's status as a finished turn, as `Stop` does, plus `failure: <error>`, `details`, `message` (each cut to 300 characters). `rate_limit` and `billing_error` mean the account is out. The other errors change nothing here.

Only some stops count. The session must be of kind `claude` (a `claude-glm` session's limit is another provider's). The status file must be one the session wrote itself: its `at` is not older than the session, and the session has a conversation id. A file left by an earlier session of the same name is ignored, and so is a stop from before blimpd started. Each stop (a session and its `at`) asks for a switch once.

## Switching

When a session reports the account is out:

1. Mark the active account out: `at` now, `until` 5 hours on. (Once finding 5 shows how the hook's message gives the reset time, `until` becomes that time.)
2. File the live file (above).
3. Pick the next saved account that isn't out and whose login hasn't expired, in the order they were added, starting after the active one. None: don't switch; one notification, "Every Claude account is out" ("Claude Code carries on by itself when a limit resets."). blimp does not check again on a timer: the next limit stop does, and Claude Code's own wait resumes sessions when a limit resets. There is no automatic switch back.
4. Put the picked login in place: read `<claude dir>/.credentials.json`, replace only its `claudeAiOauth` key (every other key, such as `mcpOAuth`, stays), write it through a temp file (600) and a rename, and set `active`. `.claude.json` is not touched (finding 2).
5. A limit stop in the 30 seconds after a switch, or after a login by hand, does not start another one: it is a request that left before the swap.
6. **Continue.** After a switch, wait 3 seconds and look again. Every session still stopped on that same limit gets `continue` and Enter (`typeInto`). A session whose screen shows a menu or a confirm dialog, or whose screen can't be read, is left alone and counted in the notification. With no switch, only a stop inside the 30 seconds after the last switch gets `continue`. Each stop gets it at most once. If finding 5 shows a menu at a limit, the right keys go here.
7. **Tell him.** One notification to the phone: "Now on <email>", body "<old email> ran out. 3 sessions continued." (plus " N left as they were." when some were left alone; "No session was waiting on it." when none). An account with no email goes by its id. The Mac app raises its own notifications from the session list, so a Mac one needs an app change; it is not in this version.

## By hand

- `blimpd accounts`: each account's email (or id), which is active, out until when, when its login expires. Never a token.
- `blimpd account use <email or id>`: file, then step 4 now. No `continue`, no phone notification; it prints what it did.
- `blimpd account forget <email or id>`: removes its folder. Not the active one.

## Log

`<socket dir>/accounts/log.jsonl` (600; past 1 MB it becomes `log.1.jsonl`): one line per event, with its time. Events: `stop` (session, `error`, `details`, `message`, account), `switch` (from, to, `byHand`), `login`, `renewal`, `adopted`, `unfiled` (a change with nobody to file it under), `not continued` and `error`. Ids, emails and the hook's text only, never a token. It answers finding 5 and says why a switch did or didn't happen. Finding 3 (a change to the live file blimp did not make) shows as a `renewal`, `login` or `unfiled` line.

## Not in this version

- An accounts screen in the Mac and iPhone apps, and a Mac notification.
- Switching before the limit from the status line's `rate_limits` numbers.
- Different accounts for different projects at the same time (needs a config folder per session).

## Docs

SECURITY.md gets a row for saved logins (where, modes, that the file routes refuse the folder and the listings leave it out, as with `secrets`). DESIGN.md gets an Accounts section. README gets a short paragraph.

## Tests

- Server tests, each in a temp config folder with made-up tokens: saving a new login, a renewal, and a login whose `oauthAccount` arrives late; modes 700/600; the swap is a rename, leaves a regular file and keeps the file's other keys (`mcpOAuth`); picking the next account (order, out, expired, none left); the 30-second rule; several sessions stopping at once give one switch; `continue` goes only to limit-stopped sessions (a fake typist) and never to one that is asking; the hook's `StopFailure` status for each `error`; `blimpd accounts` output and the log never contain a token; the fs routes refuse the folder.
- By hand on claude1: `blimpd account use` with real sessions running, then a turn in each; finding 5 at the first real limit, read from the log.
