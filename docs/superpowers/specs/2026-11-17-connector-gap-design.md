# A warning when the account in use lacks a connector another account has

Date: 2026-11-17. Asked by Max: when blimp changes the Claude login, he should not silently lose connectors (Slack, Gmail, Google Drive, Google Calendar, Zapier, Claude Docs). Those are claude.ai connectors: they belong to the Claude account, so a session gets the connectors of whichever account is logged in. He chose the simple way: connect the same ones on every account himself (claude.ai/customize/connectors), and blimp tells him when an account is short of one. This spec is that warning. It builds on account switching (`2026-11-16-account-switching-design.md`) and is part of it: nothing here runs unless `"accounts": true` is in `~/.blimp/config.json`.

Ground rules:

- blimp only reads. It never adds, removes or signs in a connector, and never calls claude.ai itself. It asks Claude Code (`claude mcp list`) and reads what that prints.
- It only ever asks about the account that is logged in right now. It never puts a saved login somewhere else to ask about another account: a second copy in use could renew the login and make the saved copy worthless.
- It stores connector names and their state. No URLs, no tokens.

## Checked on claude1 (2026-11-17, Claude Code 2.1.325)

- `claude mcp list`, run in `/tmp`, exits 0 after about 6 seconds and prints one line per server. A claude.ai connector's line looks like `claude.ai Google Calendar: https://calendarmcp.googleapis.com/mcp/v1 - ✔ Connected`. The user's own servers have lines without the `claude.ai ` start (`ptc: uv run … - ✔ Connected`). The first line is `Checking MCP server health…`, then an empty line.
- There is no JSON form (`claude mcp list --help` has no such option).
- Earlier the same command showed a connector that needed a sign-in with a `!` and the words `Needs authentication` after the ` - `. A server that can't be reached shows `✗ Failed to connect` (from Claude Code's docs, not seen here).
- Not checked: what the command prints for claude.ai connectors when claude.ai can't be reached at all. So a reading with no connector in it is not believed the first time (see "A reading").

## 1. A reading

A reading is what `claude mcp list` said about the claude.ai connectors of the account in use.

- `parseMcpList(text)` returns `{ name, state }[]`: one entry per line that starts with `claude.ai ` and has `: ` in it. `name` is the text between `claude.ai ` and the first `: ` (so `Google Calendar`, `Claude Docs`). `state` comes from the text after the last ` - ` on the line: `"ok"` when it contains `Connected` and not `Failed`; `"signin"` when it contains `Needs authentication` (any case); `"down"` for anything else. Other lines are ignored. Two lines with the same name: the first one counts.
- The command is run the way blimpd already starts Claude Code in a session, so it finds the same `claude` on the same PATH (the login shell; see how `sessions.ts` and `kinds.ts` build that), with these differences: the arguments are `mcp list`, the working folder is the system temp folder, stdin is closed, stdout is captured, and it is killed after 60 seconds. The environment is blimpd's own (so a `CLAUDE_CONFIG_DIR` blimpd runs with applies). A non-zero exit, a kill, or output without the `Checking MCP server health` line is a failed reading: nothing is stored, one log line (`event: "connectors-failed"`), and the next try is 10 minutes later at the earliest.
- A reading with no connector in it (zero entries) is stored only when the reading before it for the same account, taken at least 60 seconds earlier and not more than 10 minutes earlier, was also zero. The first zero is remembered in memory only, and the check runs again 60 seconds later.
- The account can change while the command runs. Read `state.active` before and after; when it differs, or the live login is unfiled or unknown afterwards, throw the reading away.
- Stored in `~/.blimp/accounts/<account id>/connectors.json`, mode 600, written through a temp file and a rename like the other files there: `{ at, connectors: [{ name, state }], told: string[] }`. `told` is described in section 3 and is kept when a new reading replaces the file. `forgetLogin` already removes the whole folder.

## 2. When a reading is taken

After each tick of the account loop (same 1 second timer, `accountsOn()` true), a reading for the account in use is due when all of these hold:

- there are at least two saved logins (with one account there is nothing to compare);
- `state.active` is set, `state.unknown` is not, and the live login file's mtime equals `state.filed.mtime` (nothing unfiled);
- at least 30 seconds have passed since `state.switchedAt` (when it is set);
- the account's stored reading is missing, or older than `state.switchedAt`, or older than 24 hours;
- no reading is running, and no failed or first-zero reading asks for a wait that has not passed.

A reading never blocks the tick: it runs on its own and the loop goes on. Only one runs at a time.

So: a reading is taken about 30 seconds after every switch (by itself or by hand) and after blimp first adopts a login, and once a day for the account that stays in use. A connector added on claude.ai is noticed within a day, or at the next switch.

## 3. The gap, and telling

- For the account in use, with its stored reading: `missing` = names that are `"ok"` in some other saved account's stored reading and absent from this one. `signin` = names in this reading whose state is `"signin"` and that are `"ok"` in some other saved account's reading. Names compare exactly. A connector that is `"down"` here is neither (it exists; a server being down is not the account's doing). Accounts with no stored reading add nothing. Readings of accounts that are no longer saved are not read.
- The gap key is the sorted list of `missing` names followed by the sorted `signin` names each with `!` in front (`["Google Calendar", "!Slack"]`).
- After a reading is stored: when the gap is not empty and its key differs from the file's `told`, blimp tells once (the same `tell` the switcher uses: the journal line and the phone), then writes the key to `told` (only when `tell` did not throw; when it threw, `told` stays and the next reading tries again), and adds a log line (`event: "connector-gap", account, missing, signin`). Title: `<email> is missing connectors`. Body: `No Google Calendar, Zapier. Slack needs a sign-in. Add them at claude.ai/customize/connectors.` (the "No …" sentence only when `missing` has names, the "needs a sign-in" sentence only when `signin` has names; one name or many, joined with `, `).
- The same gap again says nothing: a gap the user has decided to live with is told once. When the gap becomes empty, `told` is set to `[]`, so a gap that comes back later is told again. When it changes to a different non-empty gap, it is told again.
- A new reading for one account can open a gap for another one (the work account gains a connector the personal one lacks). That is told when the other account is next in use and gets its own reading, not before.

## 4. `blimpd accounts`

Under an account's line, when that account has a stored reading and a non-empty gap against the other accounts' readings, one more line, indented two spaces: `  no Google Calendar, Zapier; Slack needs a sign-in` (either half alone when the other is empty). Computed when the command runs, from the stored readings, for every saved account and not only the one in use. No new command and no new option.

## Code

- New file `src/accounts/connectors.ts`: `parseMcpList`, reading and writing `connectors.json`, the gap function, the "is a reading due" rule as a pure function of state, readings and time, and a small class (like `Switcher`, with injected deps: `dir`, `live`, `list: () => Promise<string | undefined>` that runs the command and gives its output or undefined for a failed run, `tell`, `log`, `now`) with one method the loop calls after each tick. `startAccounts` in `switcher.ts` creates it beside the `Switcher` and calls it; `tell` and `log` are the switcher's own live ones (export what is needed, don't copy them).
- `cli.ts`: the extra line.
- Nothing in `store.ts`'s state shape changes. `rules.ts` gets the constants (`CONNECTORS_EVERY_MS` 24 h, `CONNECTORS_AFTER_SWITCH_MS` 30 s, `CONNECTORS_RETRY_MS` 10 min, `CONNECTORS_ZERO_AGAIN_MS` 60 s, `CONNECTORS_TIMEOUT_MS` 60 s).

## Not in this version

- Moving a connector out of the Claude account (Zapier could be; Slack and Google need the user's own OAuth apps; Claude Docs can't).
- Asking about an account that is not in use.
- A warning in the Mac or iPhone app beyond the phone notification.
- The user's own MCP servers (in `~/.claude.json`): they don't change with the login.

## Docs

README: two sentences in "More than one Claude account". DESIGN.md: a short part in the Accounts section (what a reading is, when it is taken, the file, the told-once rule). SECURITY.md: one sentence (blimpd runs `claude mcp list` as the user; the file holds names only).

## Tests

All with made-up names and no real login. No test runs the real `claude`.

- `parseMcpList`: the real-looking output above (six connectors, three own servers ignored); a `Needs authentication` line; a `✗ Failed to connect` line; a name with a space; a line with a second `: ` in its URL part; a doubled name; no connector lines; empty text.
- The gap: missing only; sign-in only; both; a connector `"down"` here is not in it; a connector that is `"signin"` on the other account too is not in it; an account with no reading adds nothing; three accounts.
- "Is a reading due": each condition on its own (one saved login, unknown, unfiled, 20 seconds after a switch, a fresh reading, a reading older than the switch, a reading 25 hours old, one running, a failed one 5 minutes ago and 11 minutes ago).
- The class, with a fake `list`: a reading is stored with mode 600 and `told` kept; a failed run stores nothing and logs once and waits 10 minutes; the first zero is not stored and the second (60 seconds later) is; a zero after a non-zero stored reading needs its own second zero; the account changing during the run throws the reading away; a gap is told once, not again on the next reading, again after it changed, and again after it was empty in between; `tell` failing (throwing) does not stop the loop and the gap is tried again at the next reading; two calls while one runs start only one.
- `blimpd accounts`: the extra line in its three shapes, none without a reading, none with an empty gap.
