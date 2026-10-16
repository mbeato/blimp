# blimp

**Not released yet.** This repository is private, and it has no release yet. Until it is public and has a release, the install steps below do not work: the downloads fail, and there is no `.dmg` to download.

blimp is a Mac app for Claude Code sessions that run on your own Linux server. It shows every live session in one window. Each session shows what it is doing, and the ones that wait for your answer are at the top. Click a session to use its terminal, as if you had connected with SSH. The files the session works on are in a pane next to the terminal, where you can read and edit them. You do not need to keep a terminal open, and you do not need another editor.

![blimp in dark mode: sessions on the left, a Claude Code terminal in the middle, files on the right](docs/screenshots/main-dark.png)

blimp follows the system setting for light or dark mode. See the [light mode screenshot](docs/screenshots/main.png).

These screenshots come from the browser build that the end-to-end tests use. The sessions in them are made up.

## How it works

- The app runs your normal `ssh` command. It uses your keys, your SSH agent and your `~/.ssh/config`.
- On the server, a small service called **blimpd** listens on a private unix socket (`~/.blimp/blimpd.sock`). It does not open a network port. The app forwards a local port to that socket through SSH.
- Sessions run in **zmx**, a small program that keeps terminal sessions alive. When you close the app, your sessions keep running on the server. With user systemd, this needs linger (see [Requirements](#requirements)).
- blimp is one more way to attach to those sessions. A plain terminal still works at the same time. On the server, `zmx list` shows the same sessions, and `zmx attach <name>` joins one. If you type in one place, the text shows in both places.

## Requirements

**Server**

- Linux on x86_64 or arm64.
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code), on the `PATH` of your login shell. blimp starts each session as `claude`, through your login shell, in the folder you choose.
- A Claude Code login on the server. Run `claude` on the server once and log in. If you do not, each new session in blimp shows Claude's login steps instead of a prompt.
- An SSH server that allows forwarding to a unix socket. The app needs this to reach blimpd. It is on by default. A hardened `/etc/ssh/sshd_config` can turn it off with `AllowStreamLocalForwarding no` (or `remote`), or with `DisableForwarding yes`. To check, run `sudo sshd -T | grep -i forwarding` on the server. It must show `disableforwarding no`, and `allowstreamlocalforwarding` must be `yes`, `all` or `local`.
- `curl`, `tar` and `sha256sum`. Most Linux systems have them.
- User systemd (`systemctl --user`). This is recommended. If you have it, the installer runs blimpd as a user service. If you do not have it, you must start blimpd yourself, and start it again after each reboot.
- Linger, if you use systemd. This is strongly recommended.
  - Without linger, systemd stops blimpd when your last SSH connection to the server ends. That also ends every session that blimpd started. The app's own connection counts. So if you quit blimp and no other SSH connection is open, your sessions end.
  - To turn linger on: `sudo loginctl enable-linger "$USER"`. To check it: `loginctl show-user "$USER" -p Linger`.
  - Turning linger on usually needs root. If you do not have sudo, ask the server's admin to run `loginctl enable-linger <your user name>` as root.

**Mac**

- macOS 11 (Big Sur) or later, with Safari 16 or later installed. macOS 13 (Ventura) and later come with Safari 16 or later.
- SSH with a key, and no password prompt. blimp runs `/usr/bin/ssh` with `BatchMode=yes`, so ssh never asks you anything. Test this in Terminal first. This command must print `ok` without a prompt:
  `/usr/bin/ssh -o BatchMode=yes yourserver echo ok`
- The server's host key must be in `~/.ssh/known_hosts` already. Connect once from Terminal and accept the key.

## Install the server part

Run this on the server, as your normal user (not root):

```sh
curl -fsSL https://raw.githubusercontent.com/mbeato/blimp/main/install.sh | sh
```

The script does these things (see [install.sh](install.sh)):

1. It stops if the system is not Linux, or the CPU is not x86_64 or arm64, or `curl` is missing.
2. It installs into `~/.local/bin`. It does not need root.
3. **zmx:** if you already have zmx, the script keeps it. If not, it downloads zmx 0.8.1 from zmx's GitHub releases. It checks the download against a SHA-256 sum that is written in the script, and stops if the sum does not match.
4. **blimpd:** it downloads `blimpd-linux-x64` or `blimpd-linux-arm64` from the latest blimp release on GitHub. It also downloads `SHA256SUMS` from the same release, and stops if the binary does not match.
5. **Claude Code hooks:** it runs `blimpd install-hooks`. This adds blimp's status hooks to `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`). It keeps all your other settings and hooks. Before the first change, it saves a copy as `settings.json.blimp-backup`. These hooks tell blimp the moment a session starts to wait for you.
6. It tells you if `claude` is not found. It does not install Claude Code for you.
7. **Service:** if user systemd works, it writes `~/.config/systemd/user/blimpd.service`, then enables and starts it. If not, it prints the command to start blimpd yourself.
8. It prints this server's own name and your user name. In the app, enter the name that you use with ssh. That name can be different: for example an alias from `~/.ssh/config`, a full domain name, or an IP address.

To read the script before you run it:

```sh
curl -fsSL https://raw.githubusercontent.com/mbeato/blimp/main/install.sh -o blimp-install.sh && less blimp-install.sh
```

Then run it with `sh blimp-install.sh`. After that, you can delete `blimp-install.sh`.

To check the service: `systemctl --user status blimpd`. To list sessions from the command line: `~/.local/bin/blimpd sessions`.

## Install the app

Download the `.dmg` file from [GitHub Releases](https://github.com/mbeato/blimp/releases). Open it and drag **blimp** to Applications. It is a universal build, so it runs on Apple silicon and Intel Macs.

The release notes say whether the app is signed and notarized. If it is not, it has only an ad-hoc signature.

- **Signed build:** open it like any other app. No extra step.
- **Unsigned build:** macOS blocks the first launch. The ad-hoc signature makes macOS offer "Open Anyway" instead of saying the app is damaged.
  1. Open blimp once. macOS shows a warning. Close the warning.
  2. Open System Settings > Privacy & Security. Scroll down and click **Open Anyway** next to the message about blimp. Confirm.
  3. On macOS 14 and earlier, you can also Control-click (or right-click) blimp in Applications and choose **Open**. macOS 15 removed this shortcut, so use step 2 there.
  4. Last resort, in Terminal: `xattr -dr com.apple.quarantine /Applications/blimp.app`

## First run

1. Open blimp. It shows **Add a server**.
2. Enter the **Host**: the same name you type after `ssh`. A `Host` alias from `~/.ssh/config` works. This is not always the name that the installer printed.
3. **User** and **Port** are optional. Leave them empty to use what your `~/.ssh/config` says, as `ssh` does.
4. Click **Add server**.

The sidebar shows "Connecting to yourserver…". Then it shows your sessions, grouped by folder. If no session runs, it shows "No sessions running. Press ⌘⇧N to start one." If the connection fails, the sidebar shows the error and two buttons: **Try again** and **Remove server**. See [Troubleshooting](#troubleshooting).

To add more servers, click **+ Add server** at the bottom of the sidebar. The app keeps your server list on the Mac.

## Using it

**Sidebar**

- **Waiting for you** is at the top. It lists every session that waits for your answer, on all servers, with a dot. A session in this group does not show again in its folder group.
- Below that, there is one group per folder (`~/project`), newest session first. Each row shows the title, the state (**working**, **waiting for you** or **done**) and the time since the last activity. The title is your `/rename` title, else Claude's title, else the first prompt.
- Click **+** on a folder group to start a new session in that folder.
- With more than one server, each server has its own section with its name. A server that is not connected shows its last list dimmed, because those states can be old.

**Sessions and tabs**

- Click a session to open it in a terminal tab. Each open session has a tab. A dot on a tab means that session waits for you.
- **⌘N** starts a new session in the folder of the current tab, at once. If no tab is open, it opens **New session in…**.
- **⌘⇧N** opens **New session in…**. Pick a recent folder, browse the server, or type a path (like `~/projects/app`). Then choose **New conversation**, or pick an earlier conversation to resume. This is the same list that `/resume` shows in that folder.
- blimp starts every session in the real folder on the server, the same as typing `claude` there. So Claude reads that project's CLAUDE.md and settings, and `/resume` shows that folder's history.
- Closing a tab (**⌘W**, the **×**, or a middle-click) only detaches. The session keeps running on the server.
- A reboot of the server ends all running sessions. With user systemd and linger, blimpd starts again by itself after the reboot.
- If the session ends, the tab shows "Session ended". If you detach with `ctrl+\` (zmx's detach key), the tab shows "Detached" and a **Reattach** button. If the connection drops, the tab reconnects by itself.
- **⌘K** opens a search over all sessions on all servers, by title, folder and name. Use ↑ ↓ to pick one and Enter to open it.

**Files pane**

- The pane on the right opens at the folder of the current session. **⌘B** shows or hides it.
- Click a file in the tree to open it. **⌘P** opens a file by name.
- **Text and code** open in Monaco, the editor inside VS Code. It has the same keys, search and replace, and multi-cursor. **⌘S** saves.
- **Markdown** shows rendered. Click **Edit** to change it and **Preview** to go back. A relative link opens that file in the pane. Web links in Markdown do not open.
- **Images** (png, jpg, jpeg, gif, webp, svg, ico, bmp) show fitted to the pane.
- **PDF** files show all pages, with pdf.js.
- Other binary files show "Can't show this file" and the file size.
- The tree and the open files update when a session changes them.

**When a file changes on the server**

- If you have no unsaved edits, the file reloads by itself.
- If you have unsaved edits, a bar says "Changed on the server", with **Reload** and **Keep mine**. **Reload** loads the server's version and drops your edits. **Keep mine** saves your version over the server's.
- The same bar shows if you press ⌘S and the file changed on the server since you opened it.

**Notifications and Dock badge**

- When a session starts waiting for you, blimp sends a Mac notification: "*title* is waiting for you", with the folder. It does not send one if the window is in focus and that session's tab is the active tab.
- macOS asks for permission the first time blimp sends a notification.
- The Dock icon shows how many sessions wait for you.

### Keyboard shortcuts

| Keys | What it does |
|---|---|
| ⌘K | Jump to any session by its title, folder or name. In the editor, ⌘K goes to the editor (its ⌘K chords, as in VS Code). |
| ⌘N | New session in the current tab's folder. With no tab open, opens "New session in…". |
| ⌘⇧N | New session in…: pick a folder, then start a new conversation or resume one. |
| ⌘1 to ⌘9 | Go to session tab 1 to 9. |
| ⌘W | Close the current session tab. The session keeps running. |
| ⌘B | Show or hide the files pane. |
| ⌘P | Open a file by name in the session's folder. Shows the files pane if it is hidden. |
| ⌘S | Save the open file (when the files pane shows). |
| Esc | Close a dialog. |
| ↑ ↓ Enter | Move and pick in the session search and the dialogs. |
| ⌘Q | Quit blimp. Sessions keep running on the server. |

In the terminal, keys work like the VS Code terminal on macOS:

| Keys | What it does |
|---|---|
| ⌘C | Copy the selected text. |
| ⌘V | Paste. |
| ⌘⌫ | Delete to the start of the line (sends ctrl+U). |
| ⌥⌫ | Delete the word before the cursor (sends ctrl+W). |
| ⌘← / ⌘→ | Go to the start or end of the line (ctrl+A / ctrl+E). |
| ⌥← / ⌥→ | Go one word left or right (Esc b / Esc f). |
| `ctrl+\` | Detach (zmx). The session keeps running. |

A click on a web link in the terminal opens it in your default browser. Only `http` and `https` links open.

## Security in brief

blimpd can start sessions, type into them, and read and write every file in your home folder. So the design makes sure that only you can talk to it. The full threat model is in [docs/SECURITY.md](docs/SECURITY.md).

- blimpd has no network port. It listens on a unix socket in `~/.blimp`. The folder has mode 700, and the socket and the token file have mode 600.
- The app reaches blimpd only through your own SSH connection. Because ssh runs with `BatchMode=yes`, an unknown or changed host key makes the connection fail. It is not accepted, unless your own `~/.ssh/config` says so for that host.
- On the Mac, any program or web page can reach the local port. So every request must carry a random token (`~/.blimp/token` on the server). The token is never in a cookie.
- Files from the server cannot run script in the app. Markdown goes through DOMPurify, SVG shows only as an image, and pdf.js runs with scripting off. A strict content security policy blocks remote and inline script.
- The installer checks zmx against a pinned SHA-256 sum, and blimpd against the release's `SHA256SUMS`.
- **Accepted trade-off, keystroke timing:** plain `ssh` (OpenSSH 9.5 and later) sends keystrokes in fixed 20 ms ticks, so that a network observer cannot see your typing rhythm. blimp's tunnel is a port forward, which does not do this. So a network observer can see when you type, but not what you type. VS Code Remote and Tailscale have the same trade-off.
- The files pane can open anything in your home folder, dotfiles too. Your SSH access already allows that.

## Latency in brief

Typing in blimp must feel like `ssh`. These numbers come from [docs/SECURITY.md](docs/SECURITY.md). They were measured with the bench in [bench/](bench/README.md), on a simulated link with a 40 ms round trip:

| Path | Median | 95th percentile |
|---|---|---|
| `ssh -tt` + `zmx attach` (a plain terminal) | 49 ms | 59 ms |
| `ssh -N -L` forward alone | 40 ms | 55–74 ms (rises with typing speed) |
| full blimp path (tunnel, WebSocket, blimpd, zmx) | 40–41 ms | 44–58 ms |

On that link, blimp's median was 8 to 12 ms lower than the plain terminal across runs, and its 95th percentile was not higher. blimp cannot make the network faster. If your round trip to the server is slow, typing in blimp is slow too.

## Troubleshooting

The sidebar shows the error from ssh or blimpd. Most problems show up there.

**"SSH to yourserver failed: Permission denied (publickey)."**
ssh did not find a key that it can use without a prompt. blimp never shows a passphrase prompt.
- Test in Terminal: `/usr/bin/ssh -o BatchMode=yes yourserver echo ok`. Fix it there first.
- If your key has a passphrase, load it into the agent: `ssh-add --apple-use-keychain ~/.ssh/id_ed25519`. To load it again after each restart, add `AddKeysToAgent yes` and `UseKeychain yes` to that host in `~/.ssh/config`.
- If you set `SSH_AUTH_SOCK` in your shell profile (for example for gpg-agent), apps that you open from Finder do not see it. Use `IdentityAgent` in `~/.ssh/config` instead. 1Password and Secretive use `IdentityAgent` too.
- blimp uses `/usr/bin/ssh`, not a Homebrew ssh. Test with `/usr/bin/ssh`.

**"SSH to yourserver failed: Host key verification failed."**
The server's key is not in `~/.ssh/known_hosts`, or it changed. Connect once from Terminal (`ssh yourserver`), check the key, and accept it. Then click **Try again**.

**"blimpd isn't set up on yourserver: …No such file or directory"**
The token file `~/.blimp/token` does not exist. blimpd makes it the first time it starts. Install the server part, or start blimpd.

**"blimpd on yourserver didn't answer within 10 seconds"**
SSH works, but the app cannot reach blimpd. Often the message ends with `channel 1: open failed: connect failed: open failed` (the number can differ). There are two causes.
- blimpd does not run. On the server:
  - `systemctl --user status blimpd` shows if it runs, and its last log lines.
  - `journalctl --user -u blimpd -n 50` shows more of the log.
  - `systemctl --user restart blimpd` starts it again.
- blimpd runs, but the SSH server does not allow forwarding to a unix socket. Run `sudo sshd -T | grep -i forwarding` on the server. If it shows `disableforwarding yes`, or `allowstreamlocalforwarding no` or `remote`, change that setting in `/etc/ssh/sshd_config` (or in a file in `/etc/ssh/sshd_config.d/`), then reload sshd. Without sudo, ask the server's admin.

**No user systemd**
The installer then prints this start command. It keeps blimpd running after you log out:
`nohup "$HOME/.local/bin/blimpd" serve >"$HOME/blimpd.log" 2>&1 &`
Do this again after each reboot. Without user systemd, `XDG_RUNTIME_DIR` is often not set, and zmx then keeps its sockets in `/tmp/zmx-<your uid>`. On a shared server, first add `export ZMX_DIR="$HOME/.zmx"` to your shell profile. blimpd and your terminal must use the same `ZMX_DIR` to see the same sessions.

**blimpd refuses to start because of zmx's socket folder**
blimpd checks the folder where zmx keeps its sockets, because another user who can write there could take over a session. If the check fails, blimpd stops with one of these messages:
- `blimpd: zmx's socket folder <folder> isn't a folder you own. Set ZMX_DIR to a private folder.`
- `blimpd: zmx's socket folder <folder> is writable by others. Run: chmod 700 <folder>`

Do what the message says. With systemd, set `ZMX_DIR` for the service: run `systemctl --user edit blimpd`, add the two lines `[Service]` and `Environment=ZMX_DIR=%h/.zmx`, then run `systemctl --user restart blimpd`. Set the same `ZMX_DIR` in your shell profile.

**`~/.local/bin` is not on your PATH**
The installer then prints a note. blimp still works: the service and the hooks use the full path. Only commands that you type need it. First log out and log in again. Many systems, Debian too, add `~/.local/bin` to the `PATH` by themselves once the folder exists. If it is still not on the `PATH`, use `~/.local/bin/blimpd`, or add `export PATH="$HOME/.local/bin:$PATH"` to your shell profile.

**A new session ends at once**
blimp starts `claude` through your login shell. Check that your login shell finds it: `$SHELL -l -i -c 'command -v claude'`.

**The installer stops at the hooks step**
`blimpd install-hooks` stops if `~/.claude/settings.json` is not valid JSON. It does not overwrite a file it cannot read. Fix the file, then run `~/.local/bin/blimpd install-hooks` again, and run the installer again.

**A `ProxyCommand` helper is not found**
Apps opened from Finder get a short `PATH`. blimp adds `/opt/homebrew/bin` and `/usr/local/bin` to the `PATH` it gives ssh. For a helper in another folder, use its full path in `~/.ssh/config`.

## Uninstall

**Server.** Run these on the server, in this order.

1. End the sessions that you want to end. Uninstalling does not stop them. `zmx list` shows them, and `zmx kill <name>` ends one. Do this before step 4, because step 4 can remove zmx.
2. Remove the Claude Code hooks: `~/.local/bin/blimpd uninstall-hooks`
3. Stop the service: `systemctl --user disable --now blimpd`
4. Remove the files:
   - `rm ~/.config/systemd/user/blimpd.service && systemctl --user daemon-reload` (the folder is `$XDG_CONFIG_HOME/systemd/user` if you set `XDG_CONFIG_HOME`)
   - `rm ~/.local/bin/blimpd`
   - `rm -r ~/.blimp` (the socket, the token, and the hook status files in `status/`)
   - `rm ~/blimpd.log`, if you started blimpd yourself with `nohup`.
   - `rm ~/blimp-install.sh`, if you downloaded the script to read it first.
   - zmx, only if the installer put it there (it printed "zmx: installing 0.8.1") and you do not use zmx for anything else. zmx keeps a log for each session, and these logs can contain terminal output. So remove its folders too:
     1. Run `~/.local/bin/zmx version`. The `log_dir` line shows where the logs are. Usually this is `~/.local/state/zmx/logs`. If you set `ZMX_DIR`, it is in that folder.
     2. `rm ~/.local/bin/zmx && rm -r ~/.local/state/zmx`
     3. If you set `ZMX_DIR` (for example to `~/.zmx`), also remove that folder, and the `export ZMX_DIR` line from your shell profile.
5. Check `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`):
   - If `settings.json.blimp-backup` exists, it is your settings file from before the install. Check that `settings.json` is correct, then delete the backup.
   - If there is no backup, `settings.json` did not exist before the install. If it now holds only `{}`, you can delete it.
6. If you turned linger on only for blimp, turn it off: `sudo loginctl disable-linger "$USER"`

**Mac.**

1. Quit blimp and drag it from Applications to the Trash.
2. Delete `~/Library/Application Support/dev.blimp.app`. It holds your server list (`servers.json`).
3. WebKit can also keep data in `~/Library/WebKit/dev.blimp.app` and `~/Library/Caches/dev.blimp.app`. Delete them if they exist.

## Development

```
src/            blimpd (Bun + TypeScript, compiled to one binary)
test/           blimpd tests and the install tests
app/            the Mac app (Tauri v2)
  src/          the interface: React + TypeScript + Vite
  src-tauri/    the native shell: Rust (SSH tunnel, server list, notifications)
  e2e/          Playwright tests that drive the interface against a real blimpd over SSH
bench/          the latency bench
docs/           design, threat model, screenshots
install.sh      server setup
.github/workflows/  CI and release
```

[docs/DESIGN.md](docs/DESIGN.md) says how the parts talk to each other. The package manager is bun everywhere (`bun install`, `bun run`).

**blimpd** (in the repo root, on Linux):

- `bun install`
- `bun test` runs the blimpd tests in `test/`. They need zmx on your `PATH`. They start real zmx sessions named `blimptest-*` and kill them at the end.
- `bun run build` builds `dist/blimpd-linux-x64` and `dist/blimpd-linux-arm64`.
- `bun src/main.ts sessions` runs blimpd from source. `install-hooks` works only from a built binary, because the hooks run that exact file.
- `sh test/install-debian.sh` runs `install.sh` on a fresh Debian 13 in systemd-nspawn. It needs sudo, debootstrap and systemd-container. Run `bun run build` first.

**App** (in `app/`):

- `bun install`
- `bun run test` runs the interface's unit tests.
- The interface is built for the Safari 16 engine (`build.target` in `app/vite.config.ts`). That is why the app needs macOS 11 with Safari 16, or macOS 13. The app bundle itself declares macOS 10.13, which is Tauri's default. On a system without the Safari 16 engine, the interface may not work.
- `bun run dev` serves the interface in a browser, on `http://localhost:5173`. A browser cannot open SSH, so give it a blimpd in the URL:
  1. Forward a local port to a blimpd socket: `ssh -N -L 127.0.0.1:7777:/home/you/.blimp/blimpd.sock yourserver`
  2. Get the token: `ssh yourserver cat .blimp/token`
  3. Open `http://localhost:5173/?blimpd=http://127.0.0.1:7777&token=<token>`. Use `127.0.0.1`, because the content security policy allows only that address.
- `bun run tauri dev` runs the real app with live reload. `bun run tauri build` builds it. Both need a Mac with Rust and the Xcode Command Line Tools.
- `bun run e2e` runs the Playwright tests. They run on Linux and need:
  - bun, and zmx on your `PATH` or in `~/.local/bin`;
  - `ssh localhost` with a key and no prompt (or set `BLIMP_E2E_HOST` to another host);
  - Playwright's Chromium: `bunx playwright install chromium`;
  - `script` from util-linux.

  The tests start their own blimpd on a temporary socket, and name their zmx sessions `blimpe2e-*`. They do not touch your own blimpd or `~/.claude`. To make the README screenshots: `ZMX_DIR=$(mktemp -d) BLIMP_SHOTS=1 bun run e2e screenshots`

**Latency bench:** see [bench/README.md](bench/README.md). It needs sudo, to make a network namespace with a delayed link.

**Releasing:**

1. Set the version: `sh scripts/version.sh 0.3.0`. This sets the same version in `package.json`, `app/package.json`, `app/src-tauri/tauri.conf.json` and `app/src-tauri/Cargo.toml`, then refreshes `Cargo.lock`. With no version, it prints the current one, or lists all four if they differ. Commit the change.
2. Push a tag for that version: `git tag v0.3.0 && git push origin v0.3.0`.
3. The release workflow stops if the tag is not `vX.Y.Z` or `vX.Y.Z-rc.N`, or if it does not match the version in the four files. Then it builds both blimpd binaries, `SHA256SUMS` and the Mac `.dmg`, and publishes them with `install.sh` as a GitHub release.
4. A tag like `v0.3.0-rc.1` makes a prerelease. The installer skips prereleases.
5. The workflow signs and notarizes the Mac app only when all six Apple secrets are set for the repository: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID`. If any secret is missing, the app has only an ad-hoc signature, which needs no Apple account. The release notes say which kind of build it is.

## License

MIT. See [LICENSE](LICENSE).
