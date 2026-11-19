# Usage

Built 2026-11-19. Asked by Max: see token usage, stats and cost across every account logged in on the server and every model, as contextscope does for one account. He picked: history and limits; limits only have to be live for the account in use; a thin bar under the terminal that shows usage passively and opens the full view on a click.

Ground rule: blimp only reads what Claude Code and Codex already write. The one change it makes to anyone's settings is the status line step, which is a command the user runs and can undo.

## What is true on claude1 today (checked 2026-11-19, Claude Code 2.1.325, Codex CLI, Bun 1.4.3)

- **Claude Code writes every reply's usage.** A transcript line with `type: "assistant"` has `message.model`, `message.id`, `requestId`, `timestamp`, `cwd`, `isSidechain` and `message.usage`: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`, and `speed`. Transcripts are `<claude dir>/projects/<project>/<session>.jsonl`; a helper agent's are in `<session>/subagents/`.
- **The same reply is written more than once.** Counted over every file: 403,845 usage lines, 225,424 distinct replies. 177,613 repeats were in the same file (one line per content block) and 808 in another file (a resumed conversation). The key that tells them apart is `message.id` with `requestId`, as contextscope uses.
- **A line with `model: "<synthetic>"` is not a reply.** It is Claude Code's own error text (310 of them), with zero tokens.
- **History is short.** The oldest reply on disk is from 2026-10-16: Claude Code deletes transcripts after about 30 days. So blimp must keep its own totals, or nothing older can ever be shown.
- **Size.** 43,954 files, 13.4 GB. Python read all of it in 130 seconds.
- **Models seen:** `claude-opus-5-5`, `claude-fable-5-2`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-haiku-4-5-20251001`, `claude-sonnet-4-6`, `claude-fable-5-1`, `claude-opus-4-8`, `GLM-5.3`, `GLM-5.3-Flash`, `morph-dsv41flash`, `morph-dsv41flash-abliterated`, `morph-kimik31`. 64% of replies are a helper agent's. No reply used fast mode.
- **A transcript does not say whose account paid.** Claude Code's `session-owner` line names an account, but only 1 reply in 9 has one before it, and after a swap by blimp it names the old account. It is not used. blimp's own log (`accounts/log.jsonl`, since 2026-11-16) says which account was in use when.
- **One Claude folder.** `~/.claude2` has had no login since October and shares the same `projects` folder.
- **Codex writes each turn's usage.** A session file (`<codex home>/sessions/**/*.jsonl`) has `turn_context` lines with `model` (`gpt-6-astra`, `gpt-5.6-terra`, `gpt-6-luna`) and `event_msg` lines with `payload.type: "token_count"`: `info.total_token_usage` (`input_tokens`, `cached_input_tokens`, `output_tokens`; it only grows; cached is part of input, reasoning is part of output) and `rate_limits.primary` (`used_percent`, `window_minutes`, `resets_at` in seconds) with `plan_type`. 284 files.
- **Claude's limit numbers reach only the status line.** Its command gets JSON on stdin with `rate_limits.five_hour` and `rate_limits.seven_day`, each `{ used_percentage (0 to 100), resets_at (seconds) }`, plus `session_id` and `transcript_path`. They are there only for a subscription login, only after the session's first reply, and a window goes once its reset time passes (statusline docs, read 2026-11-19). No hook, file or command gives them. The status line here is already taken: `node …/gsd-statusline.js`.
- **`bun:sqlite` is in Bun** (SQLite 3.53.4), so a database adds no dependency.

## Counting

`blimpd usage-scan` (blimpd runs it; it is not for people) reads what is new and adds it to `<socket dir>/usage/usage.db` (folder 700, file 600). SQLite because a scan must count a line once even if it is stopped half way: each file's lines and how far it was read are saved in one transaction.

- **Files.** Every `*.jsonl` under `<claude dir>/projects` and under `<codex home>/sessions`. Table `files (path, at)`: `at` is how many bytes were read. A scan reads a file from `at` to its last full line. A file smaller than `at` is left alone. A file that is gone leaves the table. Its totals stay.
- **A Claude reply** is counted when its line is `type: "assistant"`, has `message.usage`, and its model is not `<synthetic>`. Table `seen (key, day)` holds `message.id:requestId` of every counted reply for 40 days (longer than Claude Code keeps a transcript), so a repeat in the same file, in another file or in a later scan is not counted again.
- **A Codex turn** is the growth of `total_token_usage` since the file's last `token_count` (kept in `files`), under the model of the `turn_context` before it. Input is `input_tokens − cached_input_tokens`, cache read is `cached_input_tokens`.
- **Totals.** Table `rows`, one per hour (UTC), account, model, project, helper or not, and tier: replies, input, output, cache read, 5-minute cache write, 1-hour cache write. Project is the line's `cwd`. Tier is `fast` when `usage.speed` is `fast`, `long` when the model has a long-prompt price and the prompt (input, cache read and cache write together) is over its mark, else none.
- **Whose account.**
  - A model that does not start with `claude-` is not on a Claude account: account `other`. Codex: account `codex`.
  - With an accounts log: the account in use at the reply's time, from the log's `switch` (`to`), `login`, `adopted` and `renewal` (`account`) lines, read from `log.1.jsonl` and `log.jsonl`. An `unknown` line means nobody until the next of those. A reply from before the log's first line has no account, shown as "Before account tracking".
  - With no accounts log (switching was never on, or a Mac): the account `.claude.json` names when the scan runs.
- **When.** 30 seconds after blimpd starts, then every 10 minutes, and when `GET /usage` is asked and the last scan ended over a minute ago. One at a time. It is a child process, so a long first scan does not hold up blimpd. What a failed scan says goes to blimpd's own log (`src/usage/service.ts`).
- **How long.** On claude1 the first full scan took 189 seconds and counted 225,779 Claude replies. A second scan took 1.4 seconds.
- **Codex's limit.** The newest `token_count` line's `rate_limits` and `plan_type` are kept in the database as they are.

## Cost

`src/usage/prices.ts`: USD per million tokens, from the vendors' pricing pages on 2026-11-19. A model id's date ending (`-20251001`) and `[1m]` are dropped before the lookup.

| Model | Input | Output | Cache read | 5-min write | 1-hour write |
|---|---|---|---|---|---|
| claude-fable-5-2 | 8 | 40 | 0.20 | 10 | 16 |
| claude-fable-5-1 | 10 | 50 | 0.25 | 12.50 | 20 |
| claude-opus-5-5 | 4 | 20 | 0.20 | 5 | 8 |
| claude-opus-5, claude-opus-4-8 | 5 | 25 | 0.50 | 6.25 | 10 |
| claude-sonnet-5-5 | 2 | 10 | 0.10 | 2.50 | 4 |
| claude-sonnet-5 | 2 | 10 | 0.20 | 2.50 | 4 |
| claude-sonnet-4-6 | 3 | 15 | 0.30 | 3.75 | 6 |
| claude-haiku-5-5 | 0.10 | 0.50 | 0.01 | 0.125 | 0.20 |
| claude-haiku-5-5, prompt over 100,000 tokens | 0.50 | 2.50 | 0.05 | 0.625 | 1 |
| claude-haiku-4-5 | 1 | 5 | 0.10 | 1.25 | 2 |
| gpt-6-astra | 10 | 50 | 1 | | |
| gpt-5.6-terra | 2 | 12 | 0.20 | | |

- Fast mode is twice the model's prices (Fable 5.2, Opus 5.5, Opus 5, Opus 4.8; the page's fast rows are each exactly double, and caching multiplies on top).
- GLM and Morph have no price here: Z.ai's page could not be read exactly, and Morph's are Max's own. Codex's `gpt-6-luna` is in the real data and has no price here either. `<socket dir>/prices.json` adds or replaces prices: `{ "GLM-5.3": { "input": 1.4, "output": 4.4, "cacheRead": 0.26 } }` (missing write prices count as the input price). A file that is there but wrong is ignored as a whole, with a note saying why, as with `kinds.json`.
- A `prices.json` entry is matched by the id as written first, then by the shortened id (no date ending, no `[1m]`), then the table is (`entryFor` in `src/usage/prices.ts`).
- A model with no price is counted in tokens, adds nothing to cost, and is named in `unpriced`.
- Cost is worked out when asked, so a corrected price corrects history.
- The cost is what the tokens would cost at API prices. Max pays subscriptions, so every place that shows it says "at API prices".
- Not priced: Codex's long-context prices (its window is under the mark), US-only inference, web searches.

## Limits

- **`blimpd statusline`** is a status line command that stands in front of the user's own. It reads stdin, saves the limit numbers, then runs the user's own command with the same stdin and prints what that prints. Whatever goes wrong in blimp's part, the user's command still runs. With no command of the user's it prints nothing.
- **Saving.** Only when `rate_limits` is there. To `<socket dir>/usage/limits/<account>.json`, through a temp file and a rename: `{ at, fiveHour: { used, resetsAt }, sevenDay: { used, resetsAt } }`. The account is `accounts/state.json`'s `active`, or `one` when there is none (the server names it from `.claude.json` when asked). After a swap, a session that has not replied since still carries the old account's numbers, so nothing is saved when the session's transcript (`transcript_path`) was last written before `switchedAt`. Nothing is saved either while logins are saved but blimp can't tell which one is in place (no `active`): the numbers would be nobody's (`saveLimits` in `src/usage/statusline.ts`).
- **`blimpd install-statusline`** runs only from the built blimpd binary, since the status line runs that exact binary, as the hooks do. It keeps the `statusLine` object now in Claude's `settings.json` in `<socket dir>/usage/statusline.json`, then sets its `command` to this blimpd's `statusline` (other keys, such as `padding`, stay). Run again, it changes nothing. `settings.json` is written as `install-hooks` writes it (its symlink followed, a backup kept once). **`blimpd uninstall-statusline`** puts the kept object back, or removes `statusLine` when there was none.
- If another tool sets the status line again later, blimp's numbers stop coming. Every number shows its age, and `blimpd usage` says when the step is not in place.
- **What is shown.** The account in use: its numbers. Any other saved account: its last numbers with their age. A window whose reset time has passed shows as reset, not as its old number.
- Codex's limit needs none of this (Counting).

## API

- `GET /usage?days=<1 to 3660>&tz=<minutes east of UTC>`: the days are local days by `tz`, today included. `{ scanning, firstDay, totals, days: [{ day, byAccount, byModel }], accounts, models, projects, unpriced }`. `totals` and each entry of `accounts`, `models` and `projects` are `{ replies, input, output, cacheRead, cacheWrite, cost, helperCost }`; an account also has `id` and `email`, a model `model` and `priced`, a project `project`. `projects` is the 20 with the most cost, then one "Everything else". `byAccount` and `byModel` are cost by id. Before the first scan has ended, `scanning` is true and the rest is empty. A read-only open of the database finds nothing until the first scan has made its tables, so it answers "still counting" too (`openUsage` in `src/usage/db.ts`).
- `GET /usage/now?tz=`: `{ accounts: [{ id, email, inUse, at, fiveHour, sevenDay }], codex: { at, plan, windows: [{ minutes, used, resetsAt }] }, today: { cost, tokens }, statusline }`. A window is `{ used, resetsAt, reset }`. `statusline` says whether the step is in place. It reads small files and one day of rows.
- `blimpd usage [--days N]` asks the running blimpd and prints the same: limits, then totals, then by account, by model and by project.
- No route returns a token, and none of this reads a login.

## The apps

- **Bottom bar** (`components/StatusBar.tsx`). A strip one text line high along the bottom of the window, full width, for the server of the tab in front. Items left to right: the account in use (the part of its email before `@`), `5h` and `week` meters with their percent, `Codex` and its meter when Codex has a limit, and "today $N". A meter is red over 80%, as a session row's context bar. Hovering the bar says when each window resets and how old the numbers are (one tooltip: the items are one button). A click anywhere on the usage items opens the Usage window. It asks `/usage/now` when shown, when the window gets focus, and every 60 seconds while the window is visible. An older blimpd (404), or any other error, shows an empty bar. With the status line step not in place, or no numbers for the account in use, the Claude meters are left out. The bar is a row of items, so later ones (a branch, ports) go in without a new layout. The toast and the transfers list sit 22 px higher, above it.
- **Usage window** (`components/UsageDialog.tsx`; Server menu, "Usage…"; also a click on the bar). For the server of the tab in front.
  - Limits: one line per account and one for Codex, with the meters, reset times, "in use" or the numbers' age. An account's last numbers show also while the status line step is not in place, with a line saying how to put it back.
  - Range: Today, 7 days, 30 days, All.
  - Four numbers: cost (at API prices), tokens, replies, the share of input that came from cache.
  - Cost per day as bars, coloured by account or by model (a switch). Drawn by hand: the app has no chart library and this does not need one. The 5 with the most cost get a colour each, the rest one grey. Over 90 days, a bar is 7 days.
  - Tables by account, by model and by project: input, output, cached, cost, share of cost. A model with no price says "no price".
  - While the first scan runs: "Counting your history…".
  - An older blimpd (404): the window says it is too old to count usage and to update it.
- `lib/usage.ts`: the types and the wording (1.2M, $12.34, "resets in 1 h 40 min", a meter's level), and the bars' grouping by day or week (`chart`), unit tested.
- The iPhone app: not in this version.

## Not in this version

- The iPhone screen and widget.
- Live limits for an account that is not in use (it would need blimp to use a saved login).
- A list of past limit stops (the accounts log has them).
- Fast mode, long-context and geo prices beyond what Cost says.
- Per-account totals from before 2026-11-16.
- A setting to hide the bottom bar.

## Docs

DESIGN.md gets a Usage section under "blimpd API", the bottom bar and the Usage window under "UI", and "Usage…" in the menu table. README gets a short paragraph with the status line step. SECURITY.md gets a row: the usage folder holds account ids, emails and project paths, never a login, and `blimpd statusline` runs the user's own status line command as before. MAC-CHECKLIST gets the bar and the window.

## Tests

- Server, each in temp folders with made-up transcripts: a reply counted once across a repeat in the same file, in another file and in a second scan; a half-written last line waits for the next scan; `<synthetic>` skipped; the two cache write kinds; helper or not; the hour; the tier (Haiku 5.5 over the mark, fast); Codex growth, its model, cached input taken out of input; a file that shrank or went; the account from the log (a switch, before the first line, an `unknown` line), with no log, and for a model that is not Claude's; prices (date ending and `[1m]` dropped, `prices.json` adds and replaces, a wrong file ignored with a note, a model with no price); the summary by day with `tz`, the 20 projects; `/usage` while the first scan runs; `/usage/now` (a window past its reset, an account's numbers' age, no status line step).
- The status line: the user's command gets the same stdin and its output comes back; a failing save still runs it; nothing saved without `rate_limits` or for a session that has not replied since a swap; install then uninstall gives back the same settings; install twice changes nothing.
- App: `lib/usage.ts`.
- By hand on claude1: the first scan's totals against the spike's (225,424 replies up to 2026-11-19 15:03 UTC); `install-statusline`, then the GSD status line still shows and a number arrives after one reply; `blimpd account use` and the bar follows; the bar and the window in the Mac app against a real server.
