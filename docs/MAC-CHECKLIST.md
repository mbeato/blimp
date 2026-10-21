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

- [ ] **The app updates itself.**
  Do: with v0.2.0 installed (from the `.dmg`, the last time by hand), wait for the next release (v0.2.1), then open blimp, or pick blimp > Check for Updates…. Click Restart to update.
  Expect: a bar says "blimp 0.2.1 is ready". After Restart to update, blimp closes and opens again as 0.2.1 (blimp > About blimp), with no "Open Anyway" step. Check for Updates… with nothing new says blimp is the newest version.

- [ ] **Update server.**
  Do: after the app updates to a version newer than blimpd on claude1, look under the tabs.
  Expect: a bar "blimpd on claude1 is 0.2.0; this app is 0.2.1" with Update server. After clicking it, the bar goes, blimp reconnects, and the sessions are still running (`claude1 ls`).

## Keyboard

- [ ] **App shortcuts reach the page, not the menu.**
  Do: open a project folder and a file in it. Click in the terminal. Press each key: ⌘K, Esc, ⌘N, ⌘P, Esc, ⌘O, Esc, ⌘B, ⌘B, ⌘J, ⌘J, ⌘⌥B, ⌘⌥B, ⌘W.
  Expect: ⌘K opens the session search. ⌘N starts a Claude session in this folder and shows it. ⌘P opens the file search, not a print dialog. ⌘O opens Open Folder, not the Mac's file picker. ⌘B hides and shows the files. ⌘J hides and shows the terminal. ⌘⌥B hides and shows the session list (and types no "∫" in the terminal). ⌘W closes the file tab and the window stays open.

- [ ] **Several windows.**
  Do: press ⌘⇧N. In the new window, open a different folder. Press ⌘K and pick a session from the first window's folder. Close every window with the red button, then click blimp in the Dock.
  Expect: ⌘⇧N opens a second window on Home. ⌘K brings the first window to the front with that session shown; it does not open a tab for that folder in the second window. The Window menu lists both windows by folder name. Clicking the Dock icon with no window open opens a new one.

- [ ] **Project tabs.**
  Do: open two folders with ⌘O. Open a file in each, and type something in each one's terminal. Click between the tabs. Quit with ⌘Q and open blimp again.
  Expect: each folder is a tab at the top, with its own row of file tabs below. Switching back shows the same open file and the same terminal text. After the restart, the same tabs are open, with the same one in front.

- [ ] **The inbox.**
  Do: in a folder, ask Claude in one session to do something small and wait for it to finish, without looking at that session (keep another one on screen). Wait a few seconds more. Click its line in the inbox at the top of the session list. Then click the inbox's header.
  Expect: the session is under Done with a few words on what it did (a little after the turn ends). The click shows that session, and its line leaves Done. The header folds the inbox to one line of counts, and it stays folded after a restart. While a session works, there's no In progress heading for it.

- [ ] **Drag a session to split the terminal.**
  Do: in a folder with two sessions, drag the second one from the session list onto the right half of the terminal. Type in it. Drag it again onto the left half. Click × on its split. Start one more drag and press Esc before you let go.
  Expect: while you drag, a label follows the pointer and the half you're over is lit. The two terminals show side by side, and your typing goes to the one you dropped. The second drag moves it to the left, with its text still there. × closes the split, and the session stays in the list. Esc drops nothing.

- [ ] **Drag a session to another window, and back.**
  Do: open a second window with ⌘⇧N and put it beside the first. Drag a session from the first window's list onto the second window's terminal and let go. Then drag it from the second window (its row or its split's name) back onto the first. Then drag one and let go on the desktop, away from both windows.
  Expect: it moves to the window you let go over, into that folder's tab, on the half you let go over; the window it left stops showing it. Let go on the desktop, a new window opens about there with it. If it lands in the wrong window or a new window opens while you were over one, write down where the windows were (and which screen, with several).

- [ ] **Two windows on one folder never show the same session, even after a restart.**
  Do: open the same folder in two windows (⌘⇧N, then the folder). Show a different session in each, and split one of them. Quit blimp (⌘Q) and open it again. Then do it once more with one of the sessions in Home instead of a folder. Then install an update when one comes, which restarts blimp for you.
  Expect: after each restart, every session is on screen in one window only. A session one window shows isn't in the other window's session list. If one window is left with an empty terminal, it picks a session no other window shows.

- [ ] **Right-click a session.**
  Do: right-click a session in the list, and the name on top of a split.
  Expect: a small menu with Open in New Window (and on a split, Open All Splits in New Window), not the system's Reload / Inspect menu. Each opens a new window with the session (or all the splits, side by side), and this window stops showing them.
  Then: split two sessions, right-click one of them and pick Unsplit. Split them again, click a third session (the split is kept), right-click one of the two and pick Unsplit.
  Expect: the first Unsplit leaves the one you right-clicked on screen alone, and the other is its own row again. The second leaves the third session on screen, and the two are no longer joined in the list; clicking one shows it alone.

- [ ] **Widths.**
  Do: drag the line right of the files, the line left of the session list, and the line between two splits.
  Expect: each pane gets wider or narrower as you drag. None goes narrower than about 160 px.

- [ ] **The show/hide buttons at the top right.**
  Do: click each of the three buttons twice.
  Expect: they hide and show the files, the terminal and the session list. A hidden pane's button looks dimmer.

- [ ] **Shift+Enter in Claude.**
  Do: in a Claude session, type a word, press Shift+Enter, type another word. Don't press Enter.
  Expect: the second word is on a new line in Claude's input box, and nothing was sent.

- [ ] **Split groups and other windows.**
  Do: split two sessions side by side. Then open a second window and show one of this folder's sessions there.
  Expect: in the list, the two splits are at the top, joined by a blue line, numbered 1 and 2 like their headers, and the project tab shows "2". The session the second window shows is not in the first window's list at all: it's listed only in the window that shows it. Close it there, and it's back in the first window's list.

- [ ] **Upload by drag from Finder.**
  Do: drag a file from Finder over the tree, and move it over a folder. Let go. Drag the same file onto the same folder again. Then drag a folder in. Then drag a screenshot onto a Claude session.
  Expect: the folder under the pointer lights up, and the file appears in it on the server. The second time, blimp asks Replace, Keep both or Skip. The folder arrives with what's in it. The screenshot appears in `~/.blimp/uploads`, and its path is typed into Claude's prompt. If the folder that lights up isn't the one under the pointer, write down how far off it is (and whether the screen is Retina).

- [ ] **Download and Upload….**
  Do: right-click a file and pick Download. Right-click a folder and pick Download as .tar.gz. Right-click a folder and pick Upload… and choose a file.
  Expect: both downloads are in Downloads, and the progress box at the bottom left has Show in Finder. The macOS file picker opens for Upload…, and the file arrives on the server.

- [ ] **A web page from the server.**
  Do: in a session, start a dev server (for example `python3 -m http.server 8000`). Click Open on "Port 8000 is open". Type a path in the bar and press Enter. Click Open in Browser. Close the tab.
  Expect: the page shows in a tab next to the files, and the path loads. Open in Browser shows it in Safari while blimp runs. If the tab shows an error or a blank page instead, write down what the page is (some sites refuse to be shown inside another page).

- [ ] **Split groups, as in VS Code.**
  Do: split two sessions. Click a third session in the list. Then click either of the two.
  Expect: the third shows on its own and the two stay grouped (dimmer in the list). Clicking either brings both back side by side.

- [ ] **Settings.**
  Do: press ⌘, (and try blimp > Settings…). Set Theme to Light while the Mac is dark, raise the terminal text size, and turn Option key as Meta on; in a shell, type Option+B.
  Expect: the whole window, the editor and the native title bar go light at once; the terminal text gets bigger and still fills its pane; Option+B moves back a word instead of typing ∫. Another open window changes too. The settings are still there after quitting and opening blimp again.

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

- [ ] **The globe hides browser tabs, and that and a hidden window stop the browser stream.**
  Do: in a folder with no browser tabs, click the globe at the top right. Open a page that keeps changing (a clock or a video) in the tab it opens. Open Activity Monitor's Network tab and watch blimp. Click the globe again. Then once more. Then minimize blimp, and later bring it back. Then cover blimp fully with another app's window.
  Expect: the first click opens a browser tab. The second takes the browser tabs out of the strip, and blimp's network use drops to almost nothing. The third brings back the same tab, still on the same page. Minimized, blimp's network use drops too, and the page comes back live when you return. Note whether a fully covered window also drops; that depends on macOS telling the page it's hidden.

- [ ] **Tabs drag into another order.**
  Do: open three folders as project tabs, and three browser tabs in one of them. Drag the last project tab to the left, between two others, and then onto Home. Drag a browser tab past another. Click a tab without moving the mouse. Quit blimp and start it again.
  Expect: each tab moves where you let go of it, and never in front of Home. A click without moving just picks the tab. The new order is still there after the restart.

- [ ] **A right-click on a terminal link offers the blimp browser.**
  Do: right-click the same `https://` URL. Pick Open in Blimp Browser. Right-click it again and pick Copy Link, then paste somewhere. Right-click plain text in the terminal.
  Expect: a menu with Open in Blimp Browser, Open in Default Browser and Copy Link. The first opens the page in a browser tab next to the file tabs. Copy Link copies the URL. On plain text you get the usual Mac menu, not this one.

- [ ] **File paths in the terminal open in a tab.**
  Do: ask Claude to edit a file, then ⌘-click the path it prints (like `Update(src/app.ts)`). In a shell, run `echo src/app.ts:10` with a real file and ⌘-click it.
  Expect: the file opens in a tab. With `:10`, the cursor is on line 10. A path to a file that doesn't exist is not underlined.

## Sessions

- [ ] **Session list and trash.**
  Do: open a folder with two Claude sessions, one working and one idle. Hover each and click the trash icon. Start a New shell from the + menu.
  Expect: only that folder's sessions are listed, each with its mark. The idle one ends at once and its conversation moves to Earlier. The working one asks "End this session?" first. `zmx list` on the server agrees. The shell row shows `>_` and its name.

- [ ] **Run a command Claude gives you.**
  Do: ask Claude "give me a bash command that prints the date and sleeps 3 seconds, in a code block, don't run it". Hover the command in the Run bar over the top of its terminal, then click it. When it ends, click Send result to Claude. Run it again and press Ctrl-C in its split before it ends. Then ask Claude, in one message: "show me `ls /nope` in a bash block, then create the file notes/x.txt" (it asks before it writes the file, in the same reply). While it asks, run `ls /nope` from the bar and press Send result. Answer Claude, type it any message, then right-click the `ls /nope` split's header and pick Send Result to Claude.
  Expect: the tooltip shows the whole command. A split opens to the right, in the folder Claude works in, and shows the output, then `── exit 0 ──` and a shell prompt. The bar showing or going doesn't make Claude's screen redraw. The bar says "exit 0"; Send result types "[blimp run] … finished with exit 0" with the output into Claude, and Claude answers it. Ctrl-C ends the run with `── exit 130 ──` and the split keeps its shell. `ls /nope` says a non-zero exit (1 on macOS) in red. While Claude asks something, a notice says "Claude is asking something. Answer it first." and nothing is typed. After your message the bar is gone, and the right-click item types the result. In a narrow split the bar cuts the last commands, not the first one's button. × hides the bar until Claude's next reply with commands.

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
