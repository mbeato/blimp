# Session kinds and model keys

Date: 2026-10-19. Asked by Max: open Codex sessions, or Claude Code on other models (he uses GLM inside Claude Code for security work and Codex as a second reviewer), from the chevron next to + in the session list; keys or sign-ins in Settings. He picked "kinds and keys together".

Ground rule: sessions run on the server, so keys and sign-ins live on the server. The Mac app never stores a key; it sends one to blimpd once (over the tunnel, with the token) and blimpd writes it to a 600 file. No route ever returns a key.

## What Max has on claude1 today (the design must keep these working)

- `~/.local/bin/claude-glm`: sets `ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic`, `ANTHROPIC_AUTH_TOKEN` from `~/.config/zai/key` (600), `ANTHROPIC_MODEL=GLM-5.3`, `ANTHROPIC_DEFAULT_OPUS_MODEL=GLM-5.3`, `ANTHROPIC_DEFAULT_SONNET_MODEL=GLM-5.3`, `ANTHROPIC_DEFAULT_HAIKU_MODEL=GLM-5.3-Flash`, `CLAUDE_CODE_SUBAGENT_MODEL=GLM-5.3`, `API_TIMEOUT_MS=3000000`, unsets `ANTHROPIC_API_KEY`, then `exec claude "$@"`.
- `codex` (on the login shell's PATH via nvm), signed in: `~/.codex/auth.json` exists.

## Kinds

A kind is a way to start a session. blimpd knows these:

| id | Label | Available when | Runs (in the login shell, as sessions run today) |
|---|---|---|---|
| `claude` | Claude Code | `claude` is found | `claude` (today's behavior, unchanged) |
| `claude-glm` | Claude Code on GLM | `~/.config/zai/key` exists and isn't empty | `claude` with the env above, built by blimpd (model names from the `glm` section of `~/.blimp/kinds.json` if set, else the defaults above). The key is read from the file at start and passed in the environment, never on a command line. |
| `codex` | Codex | `codex` is found | `codex` |
| `shell` | Shell | always | the login shell (today's New shell) |
| custom | from the file | always listed | `~/.blimp/kinds.json`: `{ "kinds": [{ "id": "…", "label": "…", "command": ["argv", "…"], "env": { "K": "V" } }], "glm": { "model": "…", "fast": "…" } }`; ids are plain names, can't reuse a built-in id; a bad file is ignored with a note in `GET /kinds`. |

"Is found" = `command -v <name>` in the user's login shell (`$SHELL -l -i -c`, as sessions start), cached ~30 s, because nvm and `~/.local/bin` only join PATH there.

## blimpd

- `GET /kinds` → `[{ id, label, available, note? }]` in the order above (custom ones before Shell). `note` says why one isn't available ("Add a Z.ai key in Settings", "codex isn't installed") or a status ("signed in" / "not signed in" for Codex, from `~/.codex/auth.json`).
- `POST /sessions` takes `kind` (default `claude`; `shell: true` still works and means `kind: "shell"`; 400 for an unknown or unavailable kind). Resume (`resume`) stays Claude-only (`claude` and `claude-glm`).
- The kind a session was started with is remembered (`~/.blimp/session-kinds.json`, name → kind, entries for ended sessions dropped), and `Session.kind` reports it. Sessions started before this, or outside blimp, keep today's detection (`claude` or `shell`).
- `PUT /keys/zai` body `{ "key": string }` → writes `~/.config/zai/key` (folder 700, file 600, temp file + rename), 204. Key: 10–500 printable characters, no whitespace. `DELETE /keys/zai` → removes it, 204. `GET /keys` → `{ "zai": boolean }` only.
- Codex sign-in: `POST /sessions { dir, kind: "codex-login" }` starts a session running `codex login` (check `codex login --help` on claude1 for a device-code or headless option and prefer it); the user finishes it in that terminal. Not listed in the chevron; Settings starts it.
- Status: Claude Code kinds (`claude`, `claude-glm`) get working/waiting/idle from the existing hooks, since they're Claude Code. Codex gets them too, from blimp's own entries in `~/.codex/hooks.json` (Codex 0.160 reads hooks in Claude's format and sends the same JSON): `blimpd install-hooks` merges them in the way it does Claude's (keeps existing entries, adds blimp's after them since Codex keys each hook's trust by its place in the list, one-time backup `hooks.json.blimp-backup`, `uninstall-hooks` takes out only blimp's), only if `~/.codex` exists. They run `blimpd hook codex` and write the same status files, keyed by `ZMX_SESSION`: UserPromptSubmit, PreToolUse, PostToolUse → working; PermissionRequest → waiting; Stop → done. Codex's `notify` in config.toml is left alone (PermissionRequest gives waiting without it). Codex runs new hooks only after the user trusts them once in `/hooks`. Other kinds show no state (a plain mark, like a shell).
- SECURITY.md and DESIGN.md get the routes and the rule above.

## App

- `+` stays New Claude session. The chevron menu lists `GET /kinds` for the folder's server (fetched when the menu opens): every kind, the unavailable ones greyed with their note, then a separator and "Models and keys…" (opens Settings at Models).
- Each session row shows a small label for kinds other than `claude` and `shell` (GLM, Codex, Codex sign-in, or a custom kind's label), sent by blimpd as `Session.label`. Split headers show it too.
- Settings gets a **Models** section, per connected server: Z.ai key (Set / Not set; a password field + Save, which sends it with `PUT /keys/zai` and clears the field; Remove), Codex (Signed in / Not signed in; Sign in starts the `codex-login` session in the front tab's folder and closes Settings), and a line saying custom kinds live in `~/.blimp/kinds.json` on the server.

## Tests

- Server (`test/server.test.ts`): `/kinds` with fake `claude` / `codex` scripts on PATH and a fake key file; unavailable kinds and notes; `POST /sessions` with each kind starts the right command (the fake shell already prints what it runs) and the GLM env (check the key never appears in `zmx list` output or argv); custom kinds file, good and bad; `PUT/DELETE /keys/zai` (mode 600, 400 for bad keys, never returned); `Session.kind` reported from the remembered kind.
- Browser e2e: the chevron lists kinds from a test server that has fake launchers; picking Codex starts a session labelled Codex; an unavailable kind is greyed; Settings > Models: paste a key → GLM becomes available; Remove → not.
- Native run: `/kinds` through the app, and Settings > Models renders.

- Hooks (`test/hooks.test.ts`): Codex's hooks.json merge, backup, clean uninstall, and the Codex states, with temp files only.

As built: `codex-login` runs `codex login --device-auth`. A bad kinds.json shows in `/kinds` as a greyed `{ id: "kinds.json", label: "Your kinds", note }` entry where its kinds would be. GLM also needs `claude` to be found.

Done when: all suites pass (unit, server, Rust, browser, native), docs updated, then release as the next plain version (scripts/version.sh, tag).
