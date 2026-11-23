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

- [ ] **The lit target follows the pointer on a Retina screen.**
  Do: on a Retina screen (the Mac's own), make the window large and expand folders so the tree reaches the bottom of the window. Drag a file from Finder slowly from the top of the tree to the bottom row, watching the pointer's tip. Then over the terminal, and let go on a Claude session's terminal near its bottom right. Then do it again in full screen (⌃⌘F), and in a second window (⌘⇧N).
  Expect: the lit folder is always the one under the pointer's tip, at any height: the first row just below the title bar, the middle, and the last row at the bottom of the window (not one row lower, about a title bar's height off, and not one about halfway up the window). Over the terminal, the split under the pointer is lit. The file lands in `~/.blimp/uploads` and its path is typed into that session, not into the tree. The same in full screen and in the second window. If it's still off, write down by how much, and whether it's the same at the top and the bottom.

- [ ] **A picture that isn't a file.**
  Do: drag a picture straight from a web page in Safari (or from Photos) onto a Claude session. Then select some text in Safari and drag it onto the session. Then take a screenshot (⌘⇧4), drag the screenshot file from the desktop onto the session.
  Expect: the first two drops light nothing and blimp says only files can be dropped, and how to save a picture as a file; nothing is typed. The screenshot file uploads and its path is typed in.

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

## Menu bar

The page describes the menu and Rust draws it, so none of this runs in the Linux tests. Each item is one check. Write down any item that is missing, does nothing, or happens twice.

- [ ] Every menu is there, in this order: blimp, File, Edit, View, Server, Window, Help. Each has the items in docs/DESIGN.md "macOS menu", with the keys shown there.
- [ ] Each key works once, with the terminal focused: ⌘B hides Files and a second ⌘B shows them (one press never toggles twice), ⌘J, ⌥⌘B, ⌘W closes one file tab, ⌘, opens Settings, ⌘N starts one session, ⌘T opens one browser tab.
- [ ] The same keys work once with the editor focused (a code file, cursor in it).
- [ ] The same keys work once with a browser tab in front, clicked into its page.
- [ ] With a dialog open (Settings, Open Folder…, Manage servers…): ⌘, closes Settings and opens nothing else; ⌘B and ⌘J act once.
- [ ] Each menu item does what its key does, once: File > Save, File > Close Tab, View > Files, View > Terminal, View > Sessions.
- [ ] In the editor, ⌘K then ⌘C comments the line (Monaco's chord) and the session search does not open; outside the editor ⌘K opens it. View > Jump to Session… shows no key and opens the search.
- [ ] ⇧⌘[ and ⇧⌘] move to the previous and next project tab, wrapping round, and the Window menu shows them as ⇧⌘[ and ⇧⌘].
- [ ] ⌘+ (the = key), ⌘- and ⌘0 make the terminal and editor text bigger, smaller and back to default, once per press. The menu shows Bigger Text as ⌘= (write down if it shows ⌘+).
- [ ] With no file open, File > Save is greyed. Press ⌘S: nothing happens and nothing beeps more than once.
- [ ] File > Save and Close Tab go grey and back as a file is opened and closed, with nothing else happening in the window. Also: with no file open, ⌘P shows Quick Open and File > Close Tab is on until it closes.
- [ ] With no server connected (stop blimpd, or turn off Wi-Fi), File > Open Folder… is greyed. Press ⌘O: blimp says "No server is connected yet." (write down if the greyed item swallows the key and nothing shows).
- [ ] View's check marks follow the panels: hide Files with the button at the top right, and View > Files loses its tick; show it with ⌘B, and the tick comes back. Browser Tabs is greyed in a folder with no browser tabs.
- [ ] The Server menu follows the focused window: with two windows on two different servers, click each window and open Server; the tick is on that window's server. File > Open Recent lists that server's recent folders.
- [ ] Server lists each server by its name only (no " — offline"). Clicking one goes to its Home. Server > Update Server… is greyed unless blimpd there is older than the app.
- [ ] With a saved server you can't reach (it goes between offline and connecting every few seconds), open the Server menu and keep it open for 30 seconds: it stays open.
- [ ] View > Enter Full Screen, then open View again: write down whether the item now says "Exit Full Screen" or still "Enter Full Screen".
- [ ] The Window menu lists the open windows by folder name; clicking one brings it forward.
- [ ] File > Close Window (⇧⌘W) closes this window only; its tabs don't come back at the next launch, as with the red button.
- [ ] Close every window with the red button: the menu bar becomes the small one (blimp, File, Edit, Window, Help). File > New Window (⇧⌘N) opens a window, and the full menu comes back.
- [ ] Help: type "shortcuts" in the Help menu's search box; it finds Help > Keyboard Shortcuts and points to it. Keyboard Shortcuts opens the dialog. blimp Help opens the README on GitHub in your browser; Report a Problem… opens a new issue page.
- [ ] blimp > Check for Updates… checks once and says what it found; blimp > Settings… opens Settings.
- [ ] Minimize every window. blimp > Settings… brings the main window back with Settings open (with main closed, another window); Help > blimp Help and Report a Problem… open their pages, and no window comes back.

## Servers

- [ ] Add server… (from the chevron on the Home tab, the first tab in the top bar) offers the `Host` names from your `~/.ssh/config` as you type.
- [ ] Add a host that doesn't exist: the dialog says "Connecting to …", then shows the error and a hint, and stays open with your fields. Cancel while it connects: `ps aux | grep '[s]sh -T'` shows no tunnel for that host.
- [ ] Add server, Stop, Add server again: the second try connects. (Stop is Cancel while it connects: the first-run form stays; from the chevron, open Add server… again.) Best with a server that takes a few seconds to answer. `ps aux | grep '[s]sh -T'` then shows one tunnel for that host.
- [ ] On the first-run form (no server saved yet), press Install blimpd and then Install: a Cancel shows while it installs, and puts the form back as it was before the click.
- [ ] Add a server where blimpd isn't installed (a fresh VM or account): the error says blimpd isn't set up, and Install blimpd installs it and connects.
- [ ] Install blimpd (in Add server and in Manage servers…) first shows a Mac dialog, "Install blimpd on <user@host:port>?" (only the parts typed: with a user and port 2222, "max@box:2222"), with Install and Cancel. Install is the blue default button; Esc cancels. Cancel: nothing is installed, no error or notice shows, and the dialog is as it was before the click. Install: it installs.
- [ ] Add a host whose key isn't in `~/.ssh/known_hosts`: the hint shows the exact `ssh` command to run once from Terminal.
- [ ] With two windows open, rename a server in Manage servers… in one: the other window's Home tab, server list and tabs show the new name at once.

## Look

- [ ] **Fonts look right.**
  Do: look at the terminal, the editor and the file tree. In the terminal, compare the letters with Terminal.app set to SF Mono.
  Expect: the terminal and the editor use SF Mono. The file tree, session list and dialogs use the system font (SF Pro). If the terminal looks like Menlo instead, write it down: the font stacks start with `ui-monospace`, which WebKit should map to SF Mono.

- [ ] **Light and dark mode.**
  Do: switch macOS between Light and Dark in System Settings > Appearance.
  Expect: blimp follows the change, the terminal and editor too. The welcome page's blimp shows in both the light and the dark theme (silver on dark, ink on light).

## Files

- [ ] **Markdown viewer.**
  Do: open a Markdown file that has headings, a list, a code block, a relative image and a relative link to another file.
  Expect: it shows rendered, with the image. A click on the relative link opens that file in the pane. Click Edit: the text opens in the editor. Click Preview to go back.

- [ ] **HTML files as pages.**
  Do: ask Claude to write an HTML report with a chart image and a stylesheet in a folder next to it (`img/`, `css/`), and a `<script>` that changes the heading. Open the HTML file. Switch the app between light and dark mode.
  Expect: it shows as a page on white, with the image and the stylesheet's look. The heading is the one in the file (the script does not run). Click Edit: the HTML text opens in the editor, and an edit saves. Click Preview: the page shows the edit. Ask Claude to change the file: the page updates by itself (back at the top).

- [ ] **Gallery of a folder's images.**
  Do: right-click a folder with a few dozen images (renders or screenshots) and pick Show as Gallery. Scroll down. Ask Claude to write one more image there. Click a picture.
  Expect: a tab named after the folder shows the pictures in a grid, newest first, each with its name and age. Pictures further down load as you scroll, without a stall. The new image shows up first within a few seconds. A click opens that image in its own tab, and the gallery tab stays until you close it (× or ⌘W).

- [ ] **PDF viewer.**
  Do: open a PDF with several pages.
  Expect: all pages show, sharp on a Retina screen, and you can scroll through them.

- [ ] **Autosave, Claude's edits, and the reload bar.**
  Do: open a text file and change a line. Wait two seconds. In Terminal on the server, run `git diff` (or `cat`) on the file. Then ask Claude to change that file while it is open. Last, type in blimp and, within a second, change the same file in Terminal (`echo x >> file`).
  Expect: without ⌘S, the server shows your change within about a second, and the dot on the file tab goes away. Claude's change shows in the open file by itself, and the cursor stays where it was. After the clash, a bar shows "Changed on the server" with Reload and Keep mine, and the file on the server still has the Terminal change. Reload shows the server's version. Keep mine saves yours.

- [ ] **Right-click a file: paths, rename, delete.**
  Do: right-click a file in the tree and pick Copy Path, then paste in TextEdit. Then Copy Relative Path, and paste. Click a Claude session, then right-click a file named with a space and pick Send Path to Session. Click a folder and press ⌥⌘C, then ⌥⇧⌘C, and paste each. Right-click a file and pick Rename…, type a new name, Enter. Then click a folder, press Enter, type a new name, Enter. Then press ⌘⌫ and pick Delete. Last, click one text file, then another, then the first again, and press ⌘⌫; pick Cancel.
  Expect: the full path on the server, then the path from the project folder. The session's prompt shows the path in single quotes, with nothing sent. The keys copy the folder's two paths. The rename box selects the file's name without its extension, and the file is renamed on the server (`ls`); its open tab follows. Enter on the clicked folder renames it. The delete dialog names the folder and says you can't undo it; then the folder is gone on the server. With text files open, ⌘⌫ after the click still asks to delete the file, and no text goes from the editor.

- [ ] **Drag from the tree.**
  Do: drag a file from the tree onto a Claude session's terminal. Then drag a file onto a folder in the tree, and pick Move. Then drag a folder onto itself.
  Expect: while you drag, the name follows the pointer and the target is lit. On the terminal, the path is typed in, with nothing sent. On the folder, blimp asks "Move X into Y?", then the file is in that folder on the server and the folder opens. A folder onto itself lights nothing and asks nothing. Finder drags still work as before.

- [ ] **Right-click a file tab.**
  Do: open a file deep in the tree, collapse the folders (the button at the top of the files) and hide the files (⌘B). Right-click the file's tab and pick Reveal in Files.
  Expect: the files show, the folders open down to the file, and its row is selected.

- [ ] **New file and new folder.**
  Do: in the file tree, click a folder, then the New folder button, type a name and press Enter. Then the New file button, a name, Enter.
  Expect: the folder shows inside the one you clicked. The file shows inside the new folder and opens in a tab. Both exist on the server (`ls`).

## Visuals

- [ ] Ask Claude for a chart in a session of the open project. The first show in a session asks permission (the terminal shows the prompt); allow it. A tab with its title opens and comes to the front; the terminal keeps the keyboard.
- [ ] The chart and any diagram are drawn, in light and dark (System Settings > Appearance while it's open: it redraws). A narrow window and a wide one both lay it out.
- [ ] Ask for a change: the same tab shows the new copy. A visual from a session in another project doesn't open here.
- [ ] While you type in a file, a new visual's tab is added without taking the editor's place.
- [ ] Ask Claude for a 3D model of a room with a few pieces of furniture. It draws. Drag turns it, the wheel zooms, a right drag moves it. A narrow window and a wide one both fill with it.

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

- [ ] **A browser tab left for an hour sleeps.**
  Do: open three browser tabs in a folder. Leave the middle one in the background for over an hour (another tab in front). Click it. Then let another tab sleep the same way, and close it with its ×.
  Expect: after the hour, the middle tab is dimmed, and its tooltip says it's asleep. The click shows Waking… and then the page, loaded again, still in the middle of the strip and no longer dimmed. The closed tab leaves the strip.

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

- [ ] **"No, because…" from outside the terminal (real Claude).**
  Do: in a blimp session, ask Claude to run `git push --dry-run`, so it asks first. In Terminal on the server, run `curl -s --unix-socket ~/.blimp/blimpd.sock -H "Authorization: Bearer $(cat ~/.blimp/token)" http://blimpd/sessions` and find that session: write down its `name` and its `prompt.at`. Then run `curl -s --unix-socket ~/.blimp/blimpd.sock -H "Authorization: Bearer $(cat ~/.blimp/token)" -d '{"deny":true,"at":<at>,"text":"use a branch instead"}' http://blimpd/sessions/<name>/answer`. Run that last command once more.
  Expect: the session's `prompt` has `"input": "git push --dry-run"` and `"risky": true`. The first answer returns `{"id":…}`. In blimp's terminal the prompt closes, "use a branch instead" is sent as your message, and Claude replies to it. The second one returns `{"error":"the question changed"}` and types nothing.

- [ ] **A plan's text in the session list (real Claude).**
  Do: in a session, press Shift+Tab until Claude is in plan mode, and ask for a short plan. When it asks "Would you like to proceed?", run the first `curl` from the item above.
  Expect: that session's `prompt` has `"tool": "ExitPlanMode"`, a `plan` with the plan's text, and `options` as the screen shows them (its last row, "Tell Claude what to change", is listed as "No, keep planning").

- [ ] **Continue in New Session.**
  Do: in a real Claude session that did some work, right-click its row and pick Continue in New Session. Wait for Claude to answer.
  Expect: the row says "Writing handoff" while Claude writes. Claude saves notes/<today>/HANDOFF-….md in the folder and replies with its path. A new session opens in a split to the right, and its first message is "Read notes/…/HANDOFF-….md and do it". The old row says "Handed off". The new row has a ↳ before its title, and its tooltip names the old session.

- [ ] **Context meter.**
  Do: open a folder with a long Claude session (over half of its context window used; `/context` in Claude shows how much).
  Expect: a thin grey bar along the bottom of its row, as long as the part used. Over 80% it is red. Hovering the row shows "Context N% (… of … tokens)", close to what Claude's own status line says. It is easy to see but doesn't draw the eye more than the amber "waiting" mark.

- [ ] **Run a command Claude gives you.**
  Do: ask Claude "give me a bash command that prints the date and sleeps 3 seconds, in a code block, don't run it". Hover the command in the Run bar above its terminal (the terminal's first line shows below the bar), then click it. When it ends, click Send result to Claude. Run it again and press Ctrl-C in its split before it ends. Then ask Claude, in one message: "show me `ls /nope` in a bash block, then create the file notes/x.txt" (it asks before it writes the file, in the same reply). While it asks, run `ls /nope` from the bar and press Send result. Answer Claude, type it any message, then right-click the `ls /nope` split's header and pick Send Result to Claude.
  Expect: the tooltip shows the whole command. A split opens to the right, in the folder Claude works in, and shows the output, then `── exit 0 ──` and a shell prompt. The bar showing or going doesn't make Claude's screen redraw. The bar says "exit 0"; Send result types "[blimp run] … finished with exit 0" with the output into Claude, and Claude answers it. Ctrl-C ends the run with `── exit 130 ──` and the split keeps its shell. `ls /nope` says a non-zero exit (1 on macOS) in red. While Claude asks something, a notice says "Claude is asking something. Answer it first." and nothing is typed. After your message the bar is gone, and the right-click item types the result. In a narrow split the bar cuts the last commands, not the first one's button. × hides the bar until Claude's next reply with commands.

- [ ] **Which session is on what.**
  Do: in a git repo on the server with `gh` signed in, check out a branch that has a pull request. Start two Claude sessions there and ask each to edit the same file. Hover each row. Right-click a row and pick **Open PR #n**. Press ⌘K.
  Expect: no row shows a warning sign. The row's tooltip says "On branch *x*". **Open PR #n** opens the pull request in your default browser. ⌘K shows the branch after the folder.

- [ ] **Give a Secret.**
  Do: right-click a Claude session, pick Give a Secret…, type the name `TEST_SECRET` and paste any text as the value. Click Save and Tell Claude. Then ask Claude "is TEST_SECRET set up? don't show it".
  Expect: the dialog closes. Claude gets a note saying where the file is, and the note does not have the value. Claude reads the file without printing the value. Settings > Models lists TEST_SECRET. Remove takes it away. blimp refuses to list `~/.blimp/secrets`: in the files on the left (Home), unfolding `.blimp` then `secrets` folds it back at once, and nothing in it shows. ⌘P from a folder above it does not list `TEST_SECRET`. In Open Folder (⌘O), Browse into `.blimp` then `secrets` shows "that's one of blimp's own files".

## Notifications and Dock

- [ ] **Permission prompt and banner.**
  Do: open a session and ask Claude for something that needs your answer: ask it to create a file (in the default permission mode it asks first), or to ask you a question. Then click another app at once, so that blimp is not in focus.
  Expect: the first time, macOS asks whether blimp may send notifications. Allow it. Within 5 seconds of the question, a banner shows "*title* is waiting for you" with the folder. On the first run, the banner shows after you click Allow.

- [ ] **No banner when you are already looking.**
  Do: do the same, but keep blimp in focus with that session in the terminal.
  Expect: no banner. The session's row shows an amber dot.

- [ ] **A background job finishes.**
  Do: in a Claude session, ask Claude to run `sleep 60 && echo built` in the background. Keep blimp in focus with that session in the terminal. Click "1 job" in its row, read the popover, then press Esc. Wait for the minute to pass.
  Expect: the row says "Working · 1 job" (or "Idle · 1 job"). The popover lists "Command", what the command does, and how long it has run. When it ends, a banner says "*what it does* finished" with the session's title and folder, even though you are looking at the session. The row then says "job done". With the popover open when the job ends, no banner shows. That holds with a second blimp window open too (⌘⇧N): no banner from either.

- [ ] **Dock badge.**
  Do: get two sessions to wait for you at the same time. Then answer one, then the other.
  Expect: the Dock icon shows 2, then 1, then no badge.

## Usage

These need a server whose blimpd counts usage, with `blimpd install-statusline` run there, and a Claude session that has replied since.

- [ ] **The bottom bar.**
  Do: look at the bottom of the window. Run `blimpd usage` on the server and compare.
  Expect: a bar under the files, the terminal and the sessions, full width, in both the light and the dark theme. On the right, after a thin line: the account in use (its email before `@`), `5h` and `week` with a meter and a percent each, `Codex` with its meter if you use Codex, and `today $N`. The numbers match `blimpd usage`. The terminal's last line is not hidden behind it. A toast and the transfers list sit just above it.

- [ ] **The server.**
  Do: look at the left end of the bar. Hover it. Then stop blimpd on the server, or turn the network off.
  Expect: the server's dot and name, as on the Home tab. The tooltip reads like `claude1 · blimpd 0.3.19 · connected`. When the server can't be reached, the dot turns red and the tooltip says offline. A click does nothing.

- [ ] **The branch and its pull request.**
  Do: focus a session in a git folder whose branch has an open pull request. Hover the branch, then click it. Then focus a session on a branch with no open pull request, then one in a folder that isn't a git checkout.
  Expect: a branch icon, the branch and `#<number>`. The tooltip is the pull request's title, and a click opens it in the browser. With no open pull request: the branch alone, and a click does nothing. Outside a git checkout: no branch item at all.

- [ ] **Sessions working and waiting.**
  Do: have one session working and one waiting for you (on any folder of the server). Hover the item, then click it. Then let both finish.
  Expect: `1 working` and `1 waiting`, with `1 waiting` in amber, the only amber in the bar. The tooltip names the waiting session. A click opens Jump to Session. With nothing working or waiting, the item is gone.

- [ ] **The focused session.**
  Do: focus a Claude session that has replied. Hover the item. Then focus a plain shell.
  Expect: its model (`Opus`, `Fable`…), a small meter and its context percent; the tooltip reads like `Context 62% (620k of 1M tokens)`, as the session row's bar. From 80% the meter and the percent are red. With a plain shell focused, the item is gone.

- [ ] **Jobs.**
  Do: ask Claude to run something in the background (a long `sleep`, say). Hover the item.
  Expect: `1 job` while it runs; the tooltip lists the jobs' labels, one per line. When it ends, the item is gone.

- [ ] **A narrow window.**
  Do: make the window as narrow as it goes.
  Expect: the left items shrink and their words end in "…" first; the usage part on the right stays whole. Nothing in the bar wraps onto a second line or scrolls.

- [ ] **Red over 80%.**
  Do: wait until a limit is over 80% (or note it when it happens).
  Expect: that meter's fill and its percent turn red, the same red as a session row's context bar. At exactly 80% it is not red yet.

- [ ] **Hover and click.**
  Do: hover the usage part of the bar. Then click it. Close the window with Esc, then click a row in the session list and press Tab until the usage part has the focus ring, and press Space.
  Expect: the tooltip says each limit's reset ("resets in 1 h 40 min"), how old the numbers are and today's tokens, one per line. A click anywhere on the usage part opens the Usage window. It is one tab stop, and Space opens the window too (write down if Tab never reaches it).

- [ ] **The bar follows the tab in front.**
  Do: with two servers saved, switch between tabs on each. On the server, run `blimpd account use <another email>`, then wait a minute or click into the window.
  Expect: the bar shows the server, branch, sessions and numbers of the tab in front. After the switch it names the new account; its meters show its last numbers, or none until it has replied.

- [ ] **The Usage window.**
  Do: choose Server > Usage…. Click Today, 7 days, 30 days and All, then By account and By model. Scroll the window.
  Expect: the head says "Usage" and the server's name, with the range at the right; it stays put while the rest scrolls. 30 days is raised first. Then a card per account and one for Codex: the name, "in use" or how old the numbers are, and for each window its percent, a meter and when it resets. Then one strip of four numbers, each with a line under it: Cost "at API prices" and how it compares with the days before, Tokens with the share read from cache, Replies with the helpers' share of cost, Per day with the busiest day. Each range changes them, the chart and the table. No number is cut off at 30 days or All. Everything reads in both themes.

- [ ] **Cost or tokens.**
  Do: at 30 days, click Tokens in the head, then Today, then Models and Projects in the table. Click Cost.
  Expect: Show (Cost, Tokens) sits left of the range, both at the right, on one line. Cost is raised first. By tokens the card says "Tokens per day" ("Tokens per hour" on Today), the axis, hover box and legend say tokens (1.2B, 500M), and the fourth number is tokens per day (per hour) with the busiest by tokens; the other three numbers don't change. The table is most tokens first ("Everything else" last), each row's bar and Share are its share of the tokens, and a model with no price has a bar and a share but its Cost still says "no price". The dots match the chart's colours. Cost puts everything back. Against a server with an older blimpd, Show is not there.

- [ ] **The chart.**
  Do: at 30 days, look at the chart. Move the pointer slowly across the bars, from the first to the last, then out of the chart.
  Expect: grid lines with their values on the left, the top line a round number at or above the busiest day; dates under the first and last bars and about every week between. Today's bar is a little paler. Under the pointer, the day gets a light band and a box beside it, to the right in the left half and to the left in the right half, never cut off by the card: the date ("Mon Nov 16", "so far" for today), the total, and a line per account or model with its cost, most first. Moving between bars never flickers. The legend under the chart has each colour's name and its cost. The colours are easy to tell apart in both themes.

- [ ] **Today by the hour.**
  Do: click Today.
  Expect: "Cost per hour" with 24 bars, 00 to 23, dates 00, 06, 12 and 18 under them, and this hour's bar paler. The hover box says the hour ("14:00"). The fourth number is Per hour with the busiest hour.

- [ ] **The tabs.**
  Do: in the table, click Accounts, Models and Projects. Hover a model and a project.
  Expect: Models is chosen first. Each tab shows one table, most cost first, with a share bar, Cost, Share, Input, Output, Cached and Replies lined up on the right, and a light fill on the row under the pointer. Models read as people say them (`Opus 5.5`, `Haiku 4.5`, `GPT-6 Astra`; `GLM-5.3` as written); the tooltip has the id. An account or model that has a colour in the chart has its dot. A model with no price (GLM, Morph, `gpt-6-luna`) says "no price" with an empty bar and "—", and a line under the table names them and says to add them to `~/.blimp/prices.json`. Accounts show their email; replies from before account tracking show as "Before account tracking". A project shows its folder's name, then where it is in grey (`~/characterquilt`); its tooltip has the full path. The last project row is "Everything else" when there are more than 20.

- [ ] **The daily copy.**
  Do: on the server, list `~/.blimp/usage/backups` a few minutes after blimpd starts, and again on later days.
  Expect: one `usage-<date>.db` per day (the UTC date), only you can read it, and never more than 7.

- [ ] **Counting.**
  Do: on a server where blimpd has never counted, update blimpd (or stop it, move `~/.blimp/usage` aside, and start it). Open the Usage window within a minute.
  Expect: "Counting your history…". Within a few minutes it fills in by itself, with no click. Put the folder back afterwards if you moved it.

- [ ] **An older blimpd.**
  Do: connect to a server whose blimpd is older than this feature.
  Expect: the bottom bar shows the server and the sessions but no usage part, and no toast or error shows. Server > Usage… says blimpd there is too old to count usage and to update it.

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

## A Mac as the server

These need a Mac with an Apple chip that runs blimpd (a Mac mini, say), logged in at its desktop, and a second computer with SSH to it.

- [ ] **The installer works from an SSH login, also a second time.**
  Do: from the second computer, in an SSH login to the Mac, run the installer (`curl -fsSL https://github.com/mbeato/blimp/releases/latest/download/install.sh | sh`). Then run `launchctl print gui/$(id -u)/dev.blimp.blimpd | grep state`. Start a session from blimp. Run the installer again, and the `launchctl` line again.
  Expect: both times the installer ends with "Done." and no "launchctl couldn't load", and the line says `state = running`. The session is still there after the second run (`ZMX_DIR=~/.zmx ~/.local/bin/zmx list`). (Checked by hand on macOS 27.2.1 with the desktop logged in: launchd takes `bootout` and `bootstrap gui/<uid>` from an SSH login.)

- [ ] **Update server on a Mac server.**
  Do: when the app is newer than blimpd on the Mac server, click Update server in the bar under the tabs.
  Expect: as on a Linux server: the bar goes, blimp reconnects, and the sessions are still running. (Update server runs the same installer over SSH.)

- [ ] **Nobody logged in at the desktop.**
  Do: restart the Mac and do not log in at its screen. From the second computer, run the installer over SSH.
  Expect: it says nobody is logged in at this Mac's desktop and that blimpd starts at the next desktop login. After you log in at the screen, the `launchctl` line says `state = running`.

- [ ] **A folder with a socket in it downloads.**
  Do: on the Mac server, make a folder with a file and a unix socket in it (a folder that holds a running dev server's `.sock`, say). In blimp, download that folder.
  Expect: the download finishes, and the archive has the file. (A Mac's tar leaves the socket out and still exits 0; checked by hand.)
