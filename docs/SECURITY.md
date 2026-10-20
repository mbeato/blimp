# blimp threat model

What blimp protects, from whom, and how. Anything in "Accepted" is a deliberate trade-off, not an oversight.

## What's at stake

blimpd can start Claude sessions, type into them, and read and write every file in your home folder. Whoever can talk to blimpd can do anything you can do on the server. So the whole design is about making sure only you can talk to it.

## Who might attack, and what stops them

| Attacker | What they try | What stops them |
|---|---|---|
| A web page open on your Mac | Call the local tunnel port (`fetch`, WebSocket, DNS rebinding) | Every request needs the token. The token is never in a cookie, so the browser never sends it on its own. A 401 has no CORS header, so a page can't read it to learn that the port is blimp. |
| Another program or user on your Mac | Same as above | Same token. (A program running as you can already read your SSH keys, so it's out of scope.) |
| Another user on the server | Connect to blimpd, or read its token | blimpd listens only on a unix socket in `~/.blimp` (folder 700, socket 600, token 600). No TCP port. |
| Another user on the server | Make zmx's socket folder first (`/tmp/zmx-<uid>` when there's no `XDG_RUNTIME_DIR`), then swap a session's socket for their own to get what you type | blimpd makes that folder itself (700) if it's missing, and refuses to start, or to run zmx, if it isn't yours or others can write it. |
| Someone on the network | Read or change traffic | Everything goes through your SSH connection. The app runs ssh with `BatchMode=yes`, so an unknown or changed host key fails instead of being accepted (unless your own `~/.ssh/config` says `StrictHostKeyChecking accept-new` or `no` for that host; blimp follows your config). |
| A malicious file in a repo you open (Markdown, SVG, PDF) | Run script inside the app, then call the app's native commands (for example, open SSH connections) | Markdown goes through DOMPurify. SVG is shown only as an image. pdf.js runs with scripting off. Markdown is parsed in a worker with time and size limits, so a hostile file can't freeze the app. The app's content security policy allows no remote scripts and no inline script. The native commands only take a host, user and port, or (for windows and notifications) strings that Rust stores, compares, or hands to a new window JSON-encoded, never as script. |
| Text printed in a terminal (a hostile program, a repo's output) | Get the app to open something by making it look like a link | Web links open only on ⌘-click, http and https only, in the system browser. File paths become links only for files that exist, and open only on ⌘-click, in a file tab, through the same home-folder check as every other file read. Nothing navigates the app. |
| A file dropped from Finder, or a name on the server | Overwrite something, or escape a folder, on either side | Uploads go to a hidden temp file, then a hard link (fails if the name is taken) or, after you pick Replace, a rename over a file; never over a folder; 2 GB at most. The Mac app reads only what you dropped or picked. Downloads land in `~/Downloads` under a name made safe there (no `/`, no leading dot, never over an existing file). A folder downloads as a `tar` that stores symlinks as links, so nothing outside home is read. |
| A web page in a browser tab (any site, or a dev server on a server port) | Reach blimp's page, its token or its native commands | In the Mac app the page is its own native web view, not part of blimp's page: it can't script blimp's page or read the token. Capabilities name only blimp's own web views (`main`, `w-*`), so the browser views get no commands, and they may load only web addresses (never `tauri://localhost` or `*.localhost`, blimp's own origins, where a page would count as the app; the native test tries this and expects to stay put). A window can only control its own views. Their cookies and storage are a data store of their own. In the browser build it's a sandboxed iframe on another origin. Forwards reach only 127.0.0.1 or ::1 on the server, never other hosts. Like any web page on your Mac, it could call the tunnel port, which needs the token. |
| A web page you send to a session | Get Claude to do something by what the page says (prompt injection) | Nothing goes to a session unless you pick Send to session and a session. What's sent is a file of the page's text, with its address, under `~/.blimp/uploads`, and its path is pasted for you to see before pressing Enter. Treat it like any text you paste in. |
| A crafted session name, folder or path | Escape the home folder, or the status folder | Every file path is resolved (symlinks too) and must stay inside home. Hook status files use the zmx session name only if it's a plain name. zmx, claude and git get argument lists, never shell strings. |
| Text sent from the phone | Send keys to a session (Esc, arrows, a fake end of paste, ctrl+C, zmx's detach key ctrl+\\) | `input` is pasted as a bracketed paste. Before that, `\r\n` and a lone `\r` become `\n`, and every other control character except tab is removed (U+0000–U+0008, U+000B–U+001F, U+007F–U+009F), so the text can't end the paste, press keys, interrupt or detach. Then Enter is pressed. It is refused while the session is waiting, so that Enter can't confirm a permission's highlighted "Yes". Apart from that Enter, only `answer` and `interrupt` send keys: `answer` types one digit 1–9 or Esc and nothing else, checked in code whatever the status file says (a digit for an option shown on screen, or Esc for No when the options couldn't be read); `interrupt` types Esc. |
| Anyone who can read the app's storage, logs or process list, on the Mac or the server | Learn a model key (Z.ai) | Keys live only on the server, where sessions run. The app sends a key once (`PUT /keys/zai`, over the tunnel, with the token) and keeps no copy; blimpd writes it to `~/.config/zai/key` (folder 700, file 600) through a temp file and a rename. No route returns a key (`GET /keys` says only whether there is one). A GLM session gets the key in its environment, read from the file at start: never on a command line, so not in `ps`, `zmx list`, `/sessions` or blimpd's log. Z.ai's address and the models are set after the login profile runs, so a profile that sets its own `ANTHROPIC_BASE_URL` can't send the key to another server. |
| A host or user name starting with `-` | Inject ssh options | The app rejects them and passes `--` before the destination. |
| A tampered app update | Get the app to install a different build | Updates must be signed with the updater key, which only the release workflow has (a repository secret); the app checks the signature against the public key built into it before installing. The update comes from this repository's GitHub releases over HTTPS. **Update server** runs the latest release's `install.sh` over your SSH connection, the same as installing by hand. |
| A tampered download | Install a different blimpd or zmx | zmx is pinned to a version and SHA-256 in `install.sh`. Releases publish SHA-256 sums. Dependencies are locked (`bun.lock`, `Cargo.lock`) and CI builds with `--frozen-lockfile` / `--locked`. Release builds run read-only, with every action pinned to a commit; only a separate publish step can write the release. |

## Accepted

- **Keystroke timing.** Plain `ssh` (OpenSSH 9.5+) hides typing rhythm by sending keystrokes in fixed 20 ms ticks. blimp's tunnel is a port forward, which doesn't do that, so a network observer could see when you type. This is the same as VS Code Remote or Tailscale. It's also part of why blimp is about 8–12 ms faster per keystroke than `ssh` at the median.
- **Whole home folder.** The file tree can open anything in your home folder, including dotfiles, and make new files and folders there. That's no more than your SSH access already allows.
- **Ending sessions.** Anyone with the token can end a session (`DELETE /sessions/<name>`). They could already type `exit` into it. Claude's conversation stays on disk either way.
- **Logins in browser tabs.** Sites you sign in to in a browser tab stay signed in (that's the point), in the app's own data store on your Mac. On macOS before 14 that's the system's default store for the app. Anyone who can read your Mac's files as you can read it, as with any browser.
- **Ports on the server.** blimp lists ports that programs in your sessions listen on and can forward them to your Mac while a browser tab is open. A forward has no token: while the tab is open, anything on your Mac (a web page in your browser included) can reach that dev server, as with VS Code's port forwarding or any `ssh -L`. All forwards are on `127.0.0.1`, and cookies don't tell ports apart, so two dev servers open at once can see each other's cookies. Close the tab to close the forward.
- **A key in a session's environment.** A Claude Code on GLM session has the Z.ai key in its environment, as a `claude-glm` script would. Programs in that session, and anything running as you on the server, can read it. Anyone with the token can replace or remove the key (not read it).
- **Codex hooks.** blimp's Codex hooks run `blimpd hook codex` outside Codex's sandbox, once you trust them in Codex. They only write a small status file in `~/.blimp/status`.
- **Token lifetime.** The token stays the same until you delete `~/.blimp/token` and restart blimpd. Anyone who has it can already reach you over SSH.

## Latency budget

Typing has to feel like `ssh`. Measured on a simulated 40 ms link (`bench/`):

| Path | Median | 95th percentile |
|---|---|---|
| `ssh -tt` + `zmx attach` (today) | 49 ms | 59 ms |
| `ssh -N -L` forward alone | 40 ms | 55–74 ms (rises with typing speed) |
| full blimp path (tunnel → WebSocket → blimpd → zmx) | 40–41 ms | 44–58 ms |

Target: the full blimp path stays within 5 ms of today's path at both the median and the 95th percentile. Measured: it's about 8–12 ms faster at the median (across runs) and no worse at the 95th. blimpd adds about 0.1 ms (median) over a direct `zmx attach`.
