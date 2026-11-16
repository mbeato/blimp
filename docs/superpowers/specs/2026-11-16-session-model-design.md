# A session's model: shown on its row, and chosen when blimp starts one

Date: 2026-11-16. Asked by Max: the right model for each kind of work without switching by hand: planning on Fable, building on Opus, research on Haiku. He approved doing it in steps. Step 1 is not in blimp: two helper agents in his Claude setup (`implementer` on Opus, `researcher` on Haiku) and a rule in his global instructions, so the main session stays on Fable and hands work down. This spec is step 2, the small blimp part. Step 3 (a "Build on Opus" button when a plan is approved) waits until he has used step 1 for a while.

Ground rule: blimp never changes the model of a running conversation. A typed `/model` asks for a confirmation while the cache is warm, and every switch re-reads the whole conversation at full price (both seen 2026-11-16 on Claude Code 2.1.325). A model is chosen when a session starts, or work goes to a helper.

## Checked on claude1 (2026-11-16, Claude Code 2.1.325)

- `claude --model opus --effort low` starts on Opus when settings.json says `model: fable`, `effortLevel: high`: launch flags beat settings.
- `claude --model haiku --effort high` is accepted.
- With the session on Fable, a helper whose file says `model: opus` ran on Opus and one that says `model: haiku` ran on Haiku.
- A transcript's assistant lines carry `message.model` (for example `claude-opus-5-5`). blimpd already reads it for the context meter (`activity.ts`, `a.context.model`) and drops it after that.
- Not checked: whether `--model` on `--resume` overrides the conversation's model. So blimp passes neither flag on a resume.

## 1. The row shows the model

- `Session.model?: string`: the model id of the session's latest reply, from its transcript, when the session list reads activity (the same condition as `context`). Absent before the first reply and for sessions that aren't Claude Code.
- `Session.label` for kind `claude`: the model's short name, when `model` is known. Today the label is empty for `claude` and holds the kind's label for the others (GLM, Codex, a custom kind's): those stay as they are. The Mac app already draws `label` on the row, the split header and the tooltip, so no app change. The iPhone decodes `label`; where it draws it was not checked.
- Short names, by what the id contains, case-insensitive: `fable` → `Fable`, `opus` → `Opus`, `sonnet` → `Sonnet`, `haiku` → `Haiku`. Anything else: the id as it is, cut to 24 characters. A `[1m]` suffix is ignored for the name.
- A session's own model only. A helper's replies are in the helper's own transcript and don't change the row.

## 2. A model and an effort when blimp starts a session

- `POST /sessions` takes two more optional fields: `model` (1 to 60 characters of `A-Z a-z 0-9 . _ - [ ]`) and `effort` (`low`, `medium`, `high`, `xhigh` or `max`). 400 with a plain message for anything else.
- Only for kind `claude`. 400 for another kind ("only Claude Code takes a model" / "… an effort"): GLM sets its own model, Codex and a shell have none.
- Not with `resume`: 400 ("a resumed conversation keeps its model"). See "Not checked" above.
- `launchFor` gets an options argument `{ model?, effort? }` and, for `claude` without a resume, adds `--model <m>` and `--effort <e>` after `--mcp-config <file>`. Both places that build the claude arguments get them (the normal one and the "login shell found nothing" one). The first message still goes last, after `--`.
- `blimpd start <folder> <first message> [--model <m>] [--effort <e>] [--job <reason>]`: passes them in the POST body. The flags may come anywhere after the folder; a flag with no value is a usage error. The usage text and the header comment in `main.ts` say so.
- The assistant's instructions (the text blimpd gives it about `blimpd start`) get two sentences: start research and lookups with `--model haiku`; start building from an agreed plan with `--model opus`; give no model for planning or when unsure, so the user's own default applies.
- The apps send neither field. Sessions started from the Mac or the iPhone start on the user's default, as today.

## Not in this version

- A model or effort picker in either app.
- A model for the one-click handoff's new session, and the "Build on Opus" button (step 3).
- Showing a session's effort: the transcript doesn't record it.
- Changing a running session's model or effort.

## Docs

DESIGN.md: `POST /sessions` gets the two fields and their rules; the Session fields list gets `model` and the new meaning of `label`; `blimpd start` gets the flags. README: one sentence where sessions' rows are described, if there is such a place; otherwise nothing.

## Tests

- `test/kinds.test.ts`: `launchFor("claude", undefined, …, { model: "opus", effort: "high" })` gives args `["claude", "--mcp-config", <file>, "--model", "opus", "--effort", "high"]`; only a model; only an effort; none (unchanged from today); the "login shell found nothing" path gets them too; with a resume they are not added by `launchFor` (the route refuses first, but `launchFor` must not add them either).
- `test/server.test.ts`, beside the existing `POST /sessions` cases (the fake shell there prints what it runs): a start with `model` and `effort` runs claude with both flags before the `--` and the first message; a bad `model` (a space, 61 characters, a `;`) and a bad `effort` are 400; either with `kind: "claude-glm"`, `"codex"` or `"shell"` is 400; either with `resume` is 400.
- The short-name function: each of the four names from a real-looking id, mixed case, a `[1m]` id, an unknown id, a 40-character unknown id (cut to 24).
- `test/activity.test.ts` or `test/sessions.test.ts`, whichever already builds a session from a transcript fixture: a `claude` session whose transcript's last reply is `claude-opus-5-5` has `model: "claude-opus-5-5"` and `label: "Opus"`; a GLM session keeps its kind label and still gets `model`; a session with no reply yet has neither; the lite list (no activity) is unchanged.
- `blimpd start`'s argument parsing: `--model` and `--effort` in different positions, a missing value, and that the POST body carries them. Follow how `--job` is tested.
