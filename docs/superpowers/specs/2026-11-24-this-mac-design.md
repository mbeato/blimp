# This Mac: blimp runs on the Mac it is installed on, with no SSH

Date: 2026-11-24. Status: approved, not built. Size: M.

## Problem

A new user opens blimp and gets a form that asks for an SSH host. Someone with no server can't
start. blimpd already runs on an Apple-chip Mac (0.3.x, "A Mac as the server"), but the app
reaches every blimpd through `ssh`, also one on the same Mac. That needs Remote Login turned on
(an admin setting), the Mac's own key in `authorized_keys`, and its host key in `known_hosts`.

## Decisions

- **First open shows a choice, not a form.** "Where should blimp run your sessions?" with two
  buttons: **This Mac** (the main one) and **A server…**.
- **This Mac needs one click and one confirmation.** The app connects to the blimpd on this Mac.
  If there is none, macOS's own dialog asks once, says what gets installed, and the app installs
  it and connects.
- **No SSH for This Mac.** The app reads blimpd's token from this Mac's disk and passes bytes
  between a local port and blimpd's socket itself.
- **blimpd does not change.** Same binary, same install script, same socket, same token. A Mac
  that is somebody's SSH server and this Mac's own "This Mac" can be the same blimpd.
- **Servers work as before,** and can be added later. Add server also offers This Mac while it
  isn't in the list.
- **Install downloads, it does not come inside the app.** The app runs the latest release's
  install script on this Mac, as Install blimpd does on a server. So the first setup needs the
  internet. Update server does the same for This Mac.
- **Removing This Mac from the list leaves blimpd installed,** as removing a server does. The
  README's uninstall steps cover the rest.
- **Nothing is migrated.** A saved `localhost` server keeps going through SSH.

Not in this change: the iPhone app and account switching with a Mac's blimpd (both unsupported
today), blimpd inside the app bundle, an uninstall button.

## What the person sees

First open, no saved servers, in the Mac app:

> **Where should blimp run your sessions?**
>
> **[ This Mac ]** Sessions run on this Mac. They pause while it sleeps.
>
> **[ A server… ]** A Linux server or another Mac, over SSH. Sessions keep running when this
> Mac is off.

- **This Mac**
  1. The screen says "Connecting to this Mac…".
  2. blimpd is there and answers: This Mac is saved and blimp opens on Home.
  3. blimpd isn't set up (or doesn't answer): the Mac's own dialog asks "Set up blimp on this
     Mac?" with what it does: it downloads blimpd from the latest blimp release, runs it in the
     background while you are logged in, and adds blimp's status hooks to Claude Code's
     settings. Buttons: **Set Up**, **Cancel**.
  4. Set Up: the screen says "Setting up this Mac…", then connects as in 2.
  5. Cancel: back to the choice, nothing said.
  6. An error (no internet, an Intel Mac, an old macOS) shows under the buttons, with the
     install script's last lines. The buttons stay, so a click tries again.
- **A server…** shows today's Add a server form, with a **Back** button to the choice.

Later, with servers saved: the Add server window has a line above the form, "Or run sessions on
this Mac, with no SSH." and a **Use This Mac** button. It does steps 1 to 6. The line isn't shown
when This Mac is already in the list.

In lists (the Home tab, the server menu, Manage servers) the entry is named **This Mac** until
the person renames it. Manage servers shows "this Mac" where a server shows its address.
Update server and Install blimpd work on it and run on this Mac.

In a plain browser (development, the Playwright tests) there is no This Mac: a browser reaches
only the blimpd in its URL, as now.

## How it works

### The saved entry

`Server` gets `local?: true`. This Mac is `{ host: "", local: true }` plus an optional `name`.
Its key is `this mac`. No SSH server can have that key: the Rust shell refuses a host or user
with whitespace in it.

### Rust shell

A new file, `app/src-tauri/src/local.rs`, holds what is This Mac's own:

- **The bridge.** A listener on `127.0.0.1:<port the OS picks>`. For each connection it opens
  `~/.blimp/blimpd.sock` and copies bytes both ways until either side closes; when one side
  ends, the other's write half is shut, so HTTP and WebSockets end cleanly. A connection whose
  socket can't be opened is closed at once. One bridge at most; it is stopped when This Mac is
  disconnected (removed from the list) and at quit.
- **`connect_local() → { id, port, token, home }`**, the same shape `connect` returns, with id
  `this mac`.
  1. Read `~/.blimp/token`. Not there: the error starts with `blimpd isn't set up on this Mac`,
     the words the UI already knows.
  2. Start the bridge if it isn't running.
  3. Ask `/health` through it, for up to 10 s, as `connect` does. No answer:
     `blimpd on this Mac didn't answer within 10 seconds`.
  Every call reads the token again and asks `/health` again, so a blimpd that was reinstalled or
  restarted is found by the link's normal retry. Nothing about a connection is kept but the
  bridge and the last token (for transfers).
- **`install_local()`** asks in a native dialog, then runs the release's install script on this
  Mac: `/bin/sh -c 'curl -fsSL …/install.sh | sh'`, with the same `PATH` the app gives ssh.
  "Cancelled." if the person says no. After the script ends well, it waits up to 10 s for the
  token file, so the connect that follows finds it. Resolves to the script's last lines; an
  error carries them too.

The commands that take a server id know `this mac`:

- `disconnect` stops the bridge.
- `update_server` runs the install script on this Mac, with no dialog (the click on Update
  server is the consent, as for a server).
- `forward_port` answers with the same port: a session's port on This Mac is already on this
  Mac. `unforward_port` and `drop_tunnel` do nothing.
- Downloads and uploads (`transfer.rs`) get This Mac's port and token from the same place they
  get a tunnel's.

Debug builds: `BLIMP_REMOTE_DIR` replaces `~/.blimp` for This Mac too, so the native e2e test
can reach its test blimpd through the bridge. `install_local` and `update_server` refuse to run
then, as they do now.

### UI

- `lib/connection.ts`: the `local` field, the key, the default name, and `connectServer` calling
  `connect_local` for it. A try of This Mac has nothing to cancel (no ssh); a cancelled try's
  answer is ignored.
- `lib/updates.ts`: `installServer` calls `install_local` for it.
- `lib/hints.ts`: for This Mac, the hints say what is true here (no SSH advice), and Install
  blimpd is also offered when blimpd doesn't answer, since the install starts it again.
- `lib/thismac.ts` (new): the steps of "use This Mac" (try, install when it isn't set up, try
  again) as one function with its connect and install passed in, so it is tested without a UI.
- `components/FirstRun.tsx` (new): the choice. `components/AddServerDialog.tsx`: the Use This Mac
  line, and Back on the first-run form.

## Security

Nothing new is reachable. The bridge is the same thing ssh's `-L` is today: a port on
`127.0.0.1` that any program on the Mac can connect to, that leads to blimpd's socket, and
behind which every request needs the token. The token file and the socket are already readable
only by the Mac's user, and the app runs as that user. The install runs the same script, from
the same release address, that Install blimpd runs over SSH, after the same kind of native
dialog that script in the page can't click.

## Tests

- Rust (`local.rs`): bytes go both ways through the bridge to a socket in a temp folder; a
  closed side ends the other; a missing socket closes the connection; stopping the bridge frees
  the port; a missing token gives the words `isNotSetUp` knows.
- `lib/thismac.test.ts`: already set up; not set up then installed; cancelled; install fails;
  connect fails after install.
- `lib/connection.test.ts`, `lib/hints.test.ts`: the key, the name, the hints for This Mac.
- Native e2e (`app/e2e-native`): Add server → Use This Mac connects to the test blimpd through
  the bridge with no ssh child for it, and its sessions show.
- By hand on a Mac (`docs/MAC-CHECKLIST.md`): a fresh user with no blimpd, Remote Login off: the
  choice, Set Up, Home, a session starts; Cancel; no internet; This Mac beside a server.
