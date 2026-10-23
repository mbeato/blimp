# Phone: project strip, back arrow, and no recaps or summary in the apps

Date: 2026-10-23. Branch `phone-strip` (worktree /Users/mbeato/blimp-strip).

## Why

Max used blimp as his only way into the server for a week, on the Mac and the iPhone. What he said:

- On the phone, switching projects is slow: open the drawer, tap the project's name, pick from a menu.
- Getting back to a project's page from a chat always means opening the drawer.
- The drawer has too much above the sessions: the project name, Inbox and a big New session button.
- The summary paragraph on the project page is a wall of text, repeats the lists under it, and gives no clear next step.
- Recaps are out of the way now (a side panel on the phone, the bottom of the session list on the Mac), so he never reads them. He chose to drop them from the apps.

New session itself is fine where it is.

## Decisions

- The drawer gets a strip of project icons down its left side (picked over making the page title the switcher: 2 taps from a chat instead of 3, and every project's marks in sight).
- A chat's top-left button is a back arrow to the project's page. In a chat there's no ☰ button; a swipe right opens the drawer.
- The apps stop showing recaps and the summary. **The server keeps both** (Max's call): it still answers `GET /sessions/<name>/recap` and still writes digests. A recap is written only when asked for, so it now costs nothing. Digests keep their hourly Haiku cost.
- Suggested replies learned from Max's past answers are a separate design, after this one.

## The phone

### The drawer

```
┌────┬──────────────────────┐
│ BL │ blimp            [+] │
│ CH●│                      │
│ MB │ ACTIVE               │
│    │ ? arch explainer     │
│    │ ● mac mobile review  │
│    │ ◌ perf check     4m  │
│    │ BROWSER              │
│    │   localhost:3000     │
│    │ › Earlier  14        │
│ ⚙  │                      │
└────┴──────────────────────┘
```

- **The strip.** One icon per project, from `Drawer.projects` (running projects and recent folders, newest activity first). The order is read when the drawer opens and held while it stays open, so an icon never moves under a finger.
- **An icon** is two capital letters from the folder's name: the first letters of its first two words when the name has words split by `-`, `_`, `.` or a space (`brain-memory` → `BM`), else its first two letters (`blimp` → `BL`). `/` shows as `/`. Two projects can share letters; the header beside the strip names the one picked, and VoiceOver reads the full name.
- **Its mark** is the project's `ProjectChoice.mark`, the same rule the project menu uses now: the amber question mark when a session there asks you something, the blue dot for an unread reply, nothing otherwise. The picked project's icon is highlighted.
- **Tapping an icon** shows that project's page behind the drawer and its sessions in the drawer. The drawer stays open. Tapping the picked project's icon shows its page too.
- **Settings** is a gear at the bottom of the strip.
- **Beside the strip:** the project's name, with a small **+** that does what New session does now (closes the drawer, shows the project's page with its box ready to type into, nothing starts until Send). Then Active, Browser and Earlier, as now.
- **Gone from the drawer:** the project menu, the Inbox row and its "N need you", and the big New session button.

### A chat's top bar

```
‹ blimp      mac mobile review     ◔ 🔈
```

- Top left: **‹** and the project's name. A tap shows the project's page.
- The back arrow carries the mark the ☰ button has now (`Drawer.badge`): amber when something but this chat needs you, else blue for an unread reply.
- The middle is the chat's title as now. The project's name under it goes, since the back arrow says it.
- Right: the context gauge and the speaker. No Recap button.
- A swipe right still opens the drawer. A swipe left does nothing any more.
- A past conversation's top bar gets the same back arrow.

### The project page

- ☰ top left, as now, opens the drawer. The title is "Inbox" with the project's name under it, as now.
- No summary paragraph. The page is: the "Since 11:40 PM: …" line after a while away, then Needs you (oldest first, with its answers in the row), Finished not read yet, Working, and "+3 other", as now.
- With nothing in it, it says the project's name and "What should Claude do here?", as now.

## What the apps stop showing

**Phone**
- The recap drawer (`RecapDrawer` in ChatExtras.swift), its toolbar button and new-recap dot, the swipe left that pulls it (HomeView `recapPull`), the auto-load after an hour away (SessionView `recapIfDue`), and the chat model's recap state.
- BlimpKit's `RecapCard` (the hour-away rule and the swipe rules) and `Recap.sections`, and the recap words in ChatRules, with their tests. The `Recap` type and the API's recap call go too, as nothing calls them.
- The summary paragraph (InboxView `paragraphSection`), `Digest.swift` and the Store's reading of digests, with their tests. Digests still come in the session list; the phone's decoder ignores the field.

**Mac**
- The return card (`RecapCard.tsx`, `useRecaps`) in the session list and over the terminal when the list is hidden, and Recap in a session's right-click menu.
- `lib/recap.ts` and its test, the API's recap call, the card's CSS, and `app/e2e/recap.spec.ts`; `app/e2e/work.spec.ts` no longer expects Recap in the right-click menu.

**Docs**
- README, docs/DESIGN.md, ios/README.md, docs/MAC-CHECKLIST.md and docs/PHONE-CHECKLIST.md: the recap and phone-summary parts go; the drawer, top bar and project page parts say what's above. DESIGN keeps the server's recap route and digests, and says no app shows them now.

**Server:** unchanged.

## What stays

Continue in New Session, the context meter, "Since you left" (on the page and in the chat), session names, the few words on finished rows, the Next waiting chip, one-tap replies, the browser tabs.

## Tests

- BlimpKit (`swift test`, CI job kit-linux): a new `Strip` rule with tests: the two letters for a name (one word, words split by each separator, `/`, a one-letter name), and that an order read at opening holds while the projects' activity changes.
- iPhone UI tests (CI job app-e2e):
  - `testRecapDrawer` goes.
  - Tests that check the drawer is open or closed by `drawerInbox` existing check the strip (`drawerStrip`) instead.
  - Tests that go back by the drawer's Inbox (`test4StartAndEnd`, `testInbox` and others) use the back arrow (`inboxBack`); the page's `screenTitle` still begins with "Inbox".
  - Tests that pick a project from the menu (`project-<name>`) tap its strip icon (`strip-<name>`).
  - `testNewSessionFromTheDrawer` uses the drawer's + (`drawerNewSession`, kept as its identifier).
  - A new test: from a chat in one project, open the drawer, tap another project's icon: the drawer stays open with that project's sessions, and the page behind is that project's.
  - `testInbox` checks there's no summary paragraph (`inbox-digest` is gone) and the chat's top bar order (back, title, gauge, speaker).
- Mac: `bun test src`, `bunx tsc --noEmit`, and the e2e specs that remain pass. No new Mac test: only removals.
- Server: `bun test ./test` passes unchanged.

The phone can only be built and UI-tested in CI (no Swift on the Linux box), so its checks run when the branch is pushed.

## Out of scope

- Suggested replies learned from past answers (next design).
- Deleting `~/.blimp/recaps.json` or `digests.json`, or turning digests off on the server.
- Any change to the Mac's layout beyond removing the card and the menu item.
