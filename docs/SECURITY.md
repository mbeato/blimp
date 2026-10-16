# blimp threat model

What blimp protects, from whom, and how. Anything in "Accepted" is a deliberate trade-off, not an oversight.

## What's at stake

blimpd can start Claude sessions, type into them, and read and write every file in your home folder. Whoever can talk to blimpd can do anything you can do on the server. So the whole design is about making sure only you can talk to it.

## Who might attack, and what stops them

| Attacker | What they try | What stops them |
|---|---|---|
| A web page open on your Mac | Call the local tunnel port (`fetch`, WebSocket, DNS rebinding) | Every request needs the token. The token is never in a cookie, so the browser never sends it on its own. |
| Another program or user on your Mac | Same as above | Same token. (A program running as you can already read your SSH keys, so it's out of scope.) |
| Another user on the server | Connect to blimpd, or read its token | blimpd listens only on a unix socket in `~/.blimp` (folder 700, socket 600, token 600). No TCP port. |
| Someone on the network | Read or change traffic | Everything goes through your SSH connection. The app runs ssh with `BatchMode=yes`, so an unknown or changed host key fails instead of being accepted. |
| A malicious file in a repo you open (Markdown, SVG, PDF) | Run script inside the app, then call the app's native commands (for example, open SSH connections) | Markdown goes through DOMPurify. SVG is shown only as an image. pdf.js runs with scripting off. The app's content security policy allows no remote scripts and no inline script. The native commands only take a host, user and port. |
| A crafted session name, folder or path | Escape the home folder, or the status folder | Every file path is resolved (symlinks too) and must stay inside home. Hook status files use the zmx session name only if it's a plain name. zmx, claude and git get argument lists, never shell strings. |
| A host or user name starting with `-` | Inject ssh options | The app rejects them and passes `--` before the destination. |
| A tampered download | Install a different blimpd or zmx | zmx is pinned to a version and SHA-256 in `install.sh`. Releases publish SHA-256 sums. Dependencies are locked (`bun.lock`, `Cargo.lock`). |

## Accepted

- **Keystroke timing.** Plain `ssh` (OpenSSH 9.5+) hides typing rhythm by sending keystrokes in fixed 20 ms ticks. blimp's tunnel is a port forward, which doesn't do that, so a network observer could see when you type. This is the same as VS Code Remote or Tailscale. It also makes blimp about 9 ms faster per keystroke than `ssh` at the median.
- **Whole home folder.** The files pane can open anything in your home folder, including dotfiles. That's no more than your SSH access already allows.
- **Token lifetime.** The token stays the same until you delete `~/.blimp/token` and restart blimpd. Anyone who has it can already reach you over SSH.

## Latency budget

Typing has to feel like `ssh`. Measured on a simulated 40 ms link (`bench/`):

| Path | Median | 95th percentile |
|---|---|---|
| `ssh -tt` + `zmx attach` (today) | 49 ms | 59 ms |
| `ssh -N -L` forward alone | 40 ms | 55–74 ms (rises with typing speed) |

Target: the full blimp path (tunnel → WebSocket → blimpd → zmx) stays within 5 ms of today's path at both the median and the 95th percentile.
