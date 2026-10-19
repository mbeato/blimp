# Mac checklist

The tests run on Linux, in Chromium. Some things only a real Mac can show. This list is those things. It takes about 15 minutes.

**Before you start**

- A server with blimpd installed and running (`systemctl --user status blimpd`).
- The `.dmg` from a release, or from the CI artifact `blimp-macos-dmg`.
- A Terminal window with SSH to the same server.
- On the server, a folder with a Markdown file, a PDF and a code file in it.

Each item says what to do, and what should happen. If the result is different, write down what you saw next to the item.

## Install and connect

- [ ] **Unsigned build opens.**
  Do: drag blimp to Applications and open it. When macOS blocks it, go to System Settings > Privacy & Security and click Open Anyway.
  Expect: macOS offers Open Anyway. It does not say the app is damaged. After that, blimp opens with no warning. (A signed build opens at once, with no warning.)

- [ ] **Opened from Finder, ssh still finds your helpers.**
  Do: quit blimp. Open it from Finder or the Dock, not from Terminal. Connect to a host whose `~/.ssh/config` entry uses a `ProxyCommand` or `Match exec` helper from Homebrew (for example `cloudflared` or `tailscale`), or an `IdentityAgent` (1Password, Secretive). If you have none, connect to a plain host and tick this with a note.
  Expect: Home's Welcome page says "connected". It shows no "SSH to … failed" error.

- [ ] **Quitting leaves no ssh behind.**
  Do: with a server connected, run `ps aux | grep '[s]sh -T'` in Terminal. Quit blimp with ⌘Q and run it again. Then open blimp, close its window with the red button, and run it again. Then open blimp, Force Quit it (⌥⌘Esc), wait 5 seconds, and run it again.
  Expect: blimp's `ssh -T … -L 127.0.0.1:… cat >/dev/null` lines show while blimp runs. After ⌘Q, none are left. After you close the window, none are left, or the app is still running (write down which). After Force Quit, none are left.

## Keyboard

- [ ] **App shortcuts reach the page, not the menu.**
  Do: open a project folder and a file in it. Click in the terminal. Press each key: ⌘K, Esc, ⌘N, ⌘P, Esc, ⌘O, Esc, ⌘B, ⌘B, ⌘J, ⌘J, ⌘W.
  Expect: ⌘K opens the session search. ⌘N starts a Claude session in this folder and shows it. ⌘P opens the file search, not a print dialog. ⌘O opens Open Folder, not the Mac's file picker. ⌘B hides and shows the files. ⌘J hides and shows the terminal. ⌘W closes the file tab and the window stays open.

- [ ] **Several windows.**
  Do: press ⌘⇧N. In the new window, open a different folder. Press ⌘K and pick a session from the first window's folder. Close every window with the red button, then click blimp in the Dock.
  Expect: ⌘⇧N opens a second window on Home. ⌘K brings the first window to the front with that session shown; it does not open a third window. The Window menu lists both windows by folder name. Clicking the Dock icon with no window open opens a new one.

- [ ] **Shortcuts with the editor in focus.**
  Do: open a code file and click in it. Press ⌘K and then ⌘C.
  Expect: the session search does not open. The editor comments the line, as in VS Code.

- [ ] **Terminal keys feel like the VS Code terminal.**
  Do: in a Claude prompt, type a few words. Try ⌥⌫, ⌘⌫, ⌥← and ⌥→, ⌘← and ⌘→. Select some output with the mouse and press ⌘C, then paste it in another app. Copy several lines from another app and press ⌘V in the terminal. Scroll back with the trackpad.
  Expect: ⌥⌫ deletes one word. ⌘⌫ deletes to the start of the line. ⌥ arrows move one word, ⌘ arrows go to the start or end of the line. ⌘C copies the selection. ⌘V pastes the lines as one paste; it does not send each line as a separate prompt. Scrolling is smooth.

## Look

- [ ] **Fonts look right.**
  Do: look at the terminal, the editor and the file tree. In the terminal, compare the letters with Terminal.app set to SF Mono.
  Expect: the terminal and the editor use SF Mono. The file tree, session list and dialogs use the system font (SF Pro). If the terminal looks like Menlo instead, write it down: the font stacks start with `ui-monospace`, which WebKit should map to SF Mono.

- [ ] **Light and dark mode.**
  Do: switch macOS between Light and Dark in System Settings > Appearance.
  Expect: blimp follows the change, the terminal and editor too.

## Files

- [ ] **Markdown viewer.**
  Do: open a Markdown file that has headings, a list, a code block, a relative image and a relative link to another file.
  Expect: it shows rendered, with the image. A click on the relative link opens that file in the pane. Click Edit: the text opens in the editor. Click Preview to go back.

- [ ] **PDF viewer.**
  Do: open a PDF with several pages.
  Expect: all pages show, sharp on a Retina screen, and you can scroll through them.

- [ ] **Autosave, Claude's edits, and the reload bar.**
  Do: open a text file and change a line. Wait two seconds. In Terminal on the server, run `git diff` (or `cat`) on the file. Then ask Claude to change that file while it is open. Last, type in blimp and, within a second, change the same file in Terminal (`echo x >> file`).
  Expect: without ⌘S, the server shows your change within about a second, and the dot on the file tab goes away. Claude's change shows in the open file by itself, and the cursor stays where it was. After the clash, a bar shows "Changed on the server" with Reload and Keep mine, and the file on the server still has the Terminal change. Reload shows the server's version. Keep mine saves yours.

- [ ] **New file and new folder.**
  Do: in the file tree, click a folder, then the New folder button, type a name and press Enter. Then the New file button, a name, Enter.
  Expect: the folder shows inside the one you clicked. The file shows inside the new folder and opens in a tab. Both exist on the server (`ls`).

## Links

- [ ] **Terminal links open in the default browser.**
  Do: in a session, run or print an `https://` URL. Click it, then ⌘-click it.
  Expect: the plain click opens nothing. The ⌘-click opens it in your default browser (not in blimp). blimp stays as it was.

- [ ] **File paths in the terminal open in a tab.**
  Do: ask Claude to edit a file, then ⌘-click the path it prints (like `Update(src/app.ts)`). In a shell, run `echo src/app.ts:10` with a real file and ⌘-click it.
  Expect: the file opens in a tab. With `:10`, the cursor is on line 10. A path to a file that doesn't exist is not underlined.

## Sessions

- [ ] **Session list and trash.**
  Do: open a folder with two Claude sessions, one working and one idle. Hover each and click the trash icon. Start a New shell from the + menu.
  Expect: only that folder's sessions are listed, each with its mark. The idle one ends at once and its conversation moves to Earlier. The working one asks "End this session?" first. `zmx list` on the server agrees. The shell row shows `>_` and its name.

## Notifications and Dock

- [ ] **Permission prompt and banner.**
  Do: open a session and ask Claude for something that needs your answer: ask it to create a file (in the default permission mode it asks first), or to ask you a question. Then click another app at once, so that blimp is not in focus.
  Expect: the first time, macOS asks whether blimp may send notifications. Allow it. Within 5 seconds of the question, a banner shows "*title* is waiting for you" with the folder. On the first run, the banner shows after you click Allow.

- [ ] **No banner when you are already looking.**
  Do: do the same, but keep blimp in focus with that session in the terminal.
  Expect: no banner. The session's row shows an amber dot.

- [ ] **Dock badge.**
  Do: get two sessions to wait for you at the same time. Then answer one, then the other.
  Expect: the Dock icon shows 2, then 1, then no badge.

## Connection

- [ ] **Reconnect after sleep.**
  Do: with a session open, put the Mac to sleep for a few minutes. Wake it.
  Expect: within about a minute, the session list is live again and the terminal works, with no click. (ssh notices a dead link after 45 seconds, and blimp then retries after 1, 2, 5 and 10 seconds.) If it stays "offline", click Try again and write down how long you waited.

- [ ] **Reconnect after a network change.**
  Do: switch from Wi-Fi to another network (or turn Wi-Fi off and on).
  Expect: the same as after sleep.

- [ ] **Two devices on one session.**
  Do: open a session in blimp. On the server in Terminal, run `zmx attach <name>` (the name is in `zmx list`). If you have a second Mac with blimp, open the same session there too. Type in each one.
  Expect: what you type in one shows in all of them. When you detach the Terminal client with `ctrl+\`, blimp keeps working.
