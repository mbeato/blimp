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
  Expect: the sidebar shows the sessions. It shows no "SSH to … failed" error.

- [ ] **Quitting leaves no ssh behind.**
  Do: with a server connected, run `ps aux | grep '[s]sh -N'` in Terminal. Quit blimp with ⌘Q and run it again. Then open blimp, close its window with the red button, and run it again.
  Expect: blimp's `ssh -N … -L 127.0.0.1:…` lines show while blimp runs. After ⌘Q, none are left. After you close the window, none are left, or the app is still running (write down which).

## Keyboard

- [ ] **App shortcuts reach the page, not the menu.**
  Do: open two or three session tabs. Click in the terminal. Press each key: ⌘K, Esc, ⌘N, ⌘P, Esc, ⌘B, ⌘B, ⌘1, ⌘2, ⌘W.
  Expect: ⌘K opens the session search. ⌘N starts a session in the current folder, in a new tab. ⌘P opens the file search, not a print dialog. ⌘B hides and shows the files pane. ⌘1 and ⌘2 switch tabs. ⌘W closes the current tab and the window stays open. The session from that tab is still in the sidebar.

- [ ] **Shortcuts with the editor in focus.**
  Do: open a code file and click in it. Press ⌘K and then ⌘C.
  Expect: the session search does not open. The editor comments the line, as in VS Code.

- [ ] **Terminal keys feel like the VS Code terminal.**
  Do: in a Claude prompt, type a few words. Try ⌥⌫, ⌘⌫, ⌥← and ⌥→, ⌘← and ⌘→. Select some output with the mouse and press ⌘C, then paste it in another app. Copy several lines from another app and press ⌘V in the terminal. Scroll back with the trackpad.
  Expect: ⌥⌫ deletes one word. ⌘⌫ deletes to the start of the line. ⌥ arrows move one word, ⌘ arrows go to the start or end of the line. ⌘C copies the selection. ⌘V pastes the lines as one paste; it does not send each line as a separate prompt. Scrolling is smooth.

## Look

- [ ] **Fonts look right.**
  Do: look at the terminal, the editor and the sidebar. In the terminal, compare the letters with Terminal.app set to SF Mono.
  Expect: the terminal and the editor use SF Mono. The sidebar and dialogs use the system font (SF Pro). If the terminal looks like Menlo instead, write it down: WebKit may not find "SF Mono" by name, and `ui-monospace` would be the fix.

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

- [ ] **⌘S and the reload bar.**
  Do: open a text file, change a line, press ⌘S. In Terminal on the server, run `git diff` (or `cat`) on the file. Then change a line in blimp and do not save. In Terminal, change the same file (`echo x >> file`).
  Expect: after ⌘S, the server shows your change, and the dot on the file tab goes away. After the change on the server, a bar shows "Changed on the server" with Reload and Keep mine. Reload shows the server's version. Keep mine saves yours.

## Links

- [ ] **Terminal links open in the default browser.**
  Do: in a session, run or print an `https://` URL. Click it.
  Expect: it opens in your default browser (not in blimp). blimp stays as it was.

## Notifications and Dock

- [ ] **Permission prompt and banner.**
  Do: open a session and ask Claude for something that needs your answer: ask it to create a file (in the default permission mode it asks first), or to ask you a question. Then click another app at once, so that blimp is not in focus.
  Expect: the first time, macOS asks whether blimp may send notifications. Allow it. Within 5 seconds of the question, a banner shows "*title* is waiting for you" with the folder. On the first run, the banner shows after you click Allow.

- [ ] **No banner when you are already looking.**
  Do: do the same, but keep blimp in focus with that session's tab active.
  Expect: no banner. The row moves to "Waiting for you" with a dot.

- [ ] **Dock badge.**
  Do: get two sessions to wait for you at the same time. Then answer one, then the other.
  Expect: the Dock icon shows 2, then 1, then no badge.

## Connection

- [ ] **Reconnect after sleep.**
  Do: with a session tab open, put the Mac to sleep for a few minutes. Wake it.
  Expect: within about a minute, the sidebar is live again and the terminal works, with no click. (ssh notices a dead link after 45 seconds, and blimp then retries after 1, 2, 5 and 10 seconds.) If it stays "offline", click Try again and write down how long you waited.

- [ ] **Reconnect after a network change.**
  Do: switch from Wi-Fi to another network (or turn Wi-Fi off and on).
  Expect: the same as after sleep.

- [ ] **Two devices on one session.**
  Do: open a session in blimp. On the server in Terminal, run `zmx attach <name>` (the name is in `zmx list`). If you have a second Mac with blimp, open the same session there too. Type in each one.
  Expect: what you type in one shows in all of them. When you detach the Terminal client with `ctrl+\`, blimp keeps working.
