# Phone strip, back arrow, no recaps or summary in the apps: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The iPhone drawer gets a strip of project icons and a chat gets a back arrow to its project's inbox; the phone and the Mac stop showing recaps, and the phone stops showing the project summary paragraph.

**Architecture:** One new pure rule in BlimpKit (`Strip`: two letters per project, an order held while the drawer is open). The rest is SwiftUI and React edits in place, mostly removals. The server (`src/`) is not touched: it keeps the recap route and keeps writing digests.

**Tech Stack:** SwiftUI + Swift Testing (BlimpKit) + XCUITest (iPhone), React + TypeScript + bun test + Playwright (Mac app), Markdown docs.

**Spec:** `docs/superpowers/specs/2026-10-23-phone-strip-design.md` (read it first; it says why).

## Global Constraints

- Work only in `/Users/mbeato/blimp-strip` on branch `phone-strip`. Never touch `main`, the live blimpd (`~/.blimp`, `~/.local/bin/blimpd`) or `~/.claude`. Never push unless the task says so.
- Do not change anything under `src/` or `test/` (the server). Do not change `ios/e2e/` (the stand-in Claude still answers recap asks; nothing asks now).
- Commits: one long subject line, `<Area>: <what the user now sees>, <why>`, no body, **no Co-Authored-By or any Claude attribution**.
- Match the code around you: a plain-English header comment per file that says what it does, comments that say why, short names. Swift: 4-space indent. TypeScript: 2-space indent, double quotes. When you remove a feature, also fix every comment that names it.
- The iPhone build treats every Swift warning as an error: leave no unused variable, parameter or import behind.
- There is no Swift toolchain on this machine. Swift code is compiled and tested only in CI (`.github/workflows/ios.yml`: job `kit-linux` runs `swift test` for BlimpKit; job `app` builds the app; job `app-e2e` runs the UI tests). Task 7 pushes and watches CI. Until then, re-read each Swift edit against the code it calls.
- Bun is at `~/.bun/bin`: run `export PATH="$HOME/.bun/bin:$PATH"` before any `bun` command.
- UI test element names: the drawer is open while `drawerStrip` exists; a strip icon is `strip-<folder name>`; the drawer's project name is `drawerProject`; the drawer's + is `drawerNewSession`; the chat's back arrow is `backButton`; the inbox's ☰ is `drawerButton`.

---

### Task 1: BlimpKit `Strip` rule

**Files:**
- Create: `ios/BlimpKit/Sources/BlimpKit/Strip.swift`
- Test: `ios/BlimpKit/Tests/BlimpKitTests/StripTests.swift`

**Interfaces:**
- Consumes: `ProjectChoice` (`ios/BlimpKit/Sources/BlimpKit/Home.swift:40`: `dir`, `name`, `mark`, `activity`), `Drawer.name(of:)`.
- Produces: `Strip.letters(_ name: String) -> String` and `Strip.held(_ projects: [ProjectChoice], order: [String]) -> [ProjectChoice]`, used by `DrawerView` in Task 4.

- [ ] **Step 1: Write the test**

Create `ios/BlimpKit/Tests/BlimpKitTests/StripTests.swift`:

```swift
import Foundation
import Testing
@testable import BlimpKit

// The drawer's project strip: each project's two letters, and an order that holds while the drawer is open.

private func project(_ dir: String, activity: Double) -> ProjectChoice {
    ProjectChoice(dir: dir, name: Drawer.name(of: dir), mark: .none, activity: activity)
}

@Test func aProjectsLettersAreItsFirstTwoOrTheFirstLettersOfItsFirstTwoWords() {
    #expect(Strip.letters("blimp") == "BL")
    #expect(Strip.letters("characterquilt") == "CH")
    #expect(Strip.letters("brain-memory") == "BM")
    #expect(Strip.letters("my_app") == "MA")
    #expect(Strip.letters("site.v2") == "SV")
    #expect(Strip.letters("two words here") == "TW")
    // a separator first or doubled makes no empty word
    #expect(Strip.letters("-tmp") == "TM")
    #expect(Strip.letters("a--b") == "AB")
    #expect(Strip.letters("x") == "X")
    #expect(Strip.letters("/") == "/")
}

@Test func theStripKeepsTheOrderItOpenedWithWhileActivityChanges() {
    let order = ["/a", "/b", "/c"]
    // /c gets the newest activity while the drawer is open: it stays where it was
    let now = [project("/c", activity: 9), project("/a", activity: 3), project("/b", activity: 2)]
    #expect(Strip.held(now, order: order).map(\.dir) == ["/a", "/b", "/c"])
    // a project new since goes last; one gone since is left out
    let later = [project("/d", activity: 10), project("/c", activity: 9), project("/a", activity: 3)]
    #expect(Strip.held(later, order: order).map(\.dir) == ["/a", "/c", "/d"])
    // nothing held yet: as they come
    #expect(Strip.held(now, order: []).map(\.dir) == ["/c", "/a", "/b"])
}
```

- [ ] **Step 2: Write the rule**

Create `ios/BlimpKit/Sources/BlimpKit/Strip.swift`:

```swift
// The drawer's strip of projects (DrawerView): an icon each, two letters from its folder's name, in the order
// the drawer came out with, so an icon never moves under a finger while it's open.
import Foundation

public enum Strip {
    /// Two capital letters for a project's name: the first letters of its first two words when it has words
    /// split by "-", "_", "." or a space ("brain-memory" → "BM"), else its first two letters ("blimp" → "BL").
    public static func letters(_ name: String) -> String {
        let words = name.split(whereSeparator: { "-_. ".contains($0) })
        if words.count >= 2 { return (words[0].prefix(1) + words[1].prefix(1)).uppercased() }
        return String((words.first ?? Substring(name)).prefix(2)).uppercased()
    }

    /// projects in `order` (their folders, as the drawer came out), then any new since in their own order. One
    /// gone since is left out.
    public static func held(_ projects: [ProjectChoice], order: [String]) -> [ProjectChoice] {
        let at = Dictionary(order.enumerated().map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
        let kept = projects.filter { at[$0.dir] != nil }.sorted { at[$0.dir]! < at[$1.dir]! }
        return kept + projects.filter { at[$0.dir] == nil }
    }
}
```

- [ ] **Step 3: Check it by reading**

No Swift here. Walk each `#expect` through the code by hand: `"/"` splits to `["/"]`, prefix 2 is `"/"`; `"-tmp"` splits to `["tmp"]`; `"a--b"` splits to `["a", "b"]`. `ProjectChoice`'s memberwise init is internal, which `@testable import` allows. CI runs it in Task 7.

- [ ] **Step 4: Commit**

```bash
cd /Users/mbeato/blimp-strip && git add ios/BlimpKit/Sources/BlimpKit/Strip.swift ios/BlimpKit/Tests/BlimpKitTests/StripTests.swift && git commit -m "iPhone, BlimpKit: Strip gives each project two letters from its folder's name and holds the drawer's project order while it's open, for the drawer's project strip"
```

---

### Task 2: iPhone stops showing recaps

**Files:**
- Delete: `ios/BlimpKit/Sources/BlimpKit/RecapCard.swift`
- Modify: `ios/BlimpKit/Sources/BlimpKit/ChatRules.swift` (gets `LastShown`; loses `RecapText`)
- Modify: `ios/BlimpKit/Sources/BlimpKit/Models.swift:308-321` (the `Recap` struct goes)
- Modify: `ios/Blimp/Model/ChatModel.swift`, `ios/Blimp/Net/API.swift:79-84`, `ios/Blimp/Views/ChatExtras.swift`, `ios/Blimp/Views/SessionView.swift`, `ios/Blimp/Views/HomeView.swift`
- Test: `ios/BlimpKit/Tests/BlimpKitTests/ReplyTests.swift`, `ChatRulesTests.swift`, `SessionFieldsTests.swift`, `ios/BlimpUITests/BlimpUITests.swift`

**Interfaces:**
- Produces: `LastShown.markShown(_ last: [String: Double], _ shown: [String], now: Double) -> [String: Double]` (moved unchanged from `RecapCard.markShown`; `ChatModel.markShown` uses it for "since you left").
- `SessionView(name:onOpen:)` loses `onRecap` and `onModel`.

- [ ] **Step 1: Move the last-shown rule, then delete RecapCard.swift**

`RecapCard.markShown` keeps "when each chat was last on screen", which "since you left" still needs. Append to the end of `ios/BlimpKit/Sources/BlimpKit/ChatRules.swift`:

```swift

/// When each chat was last on screen on this phone, for "since you left" (ChatModel.lastShown).
public enum LastShown {
    /// A chat not on screen for this long is forgotten.
    static let keep: Double = 30 * 24 * 60 * 60_000

    /// last, with `shown` on screen until now; ones not on screen for a month are dropped.
    public static func markShown(_ last: [String: Double], _ shown: [String], now: Double) -> [String: Double] {
        var out = last.filter { now - $0.value < keep }
        for k in shown { out[k] = now }
        return out
    }
}
```

In the same file delete the whole `public enum RecapText { … }` (lines 96-102), and in the header comment (lines 1-4) delete `, and the words when a recap didn't come through` so the sentence ends after `(feature 2: … then can type its result back to Claude)`. Then: `git rm ios/BlimpKit/Sources/BlimpKit/RecapCard.swift` (it also holds `RecapSection` and `Recap.sections`, both going).

- [ ] **Step 2: Remove the Recap model**

In `ios/BlimpKit/Sources/BlimpKit/Models.swift` delete the doc comment and struct from `/// The return card ("where was I?"), GET /sessions/<name>/recap.` through the closing `}` of `public struct Recap` (lines 308-321).

- [ ] **Step 3: Update the BlimpKit tests**

- `ReplyTests.swift`: delete `theReturnCardShowsAfterAnHourAwayOrForAChatNeverShown` and `aSwipeLeftFromAnywherePullsTheRecapDrawerAndScrollingNever`. In `markingChatsShownKeepsAMonthAndSetsTheOnesOnScreenToNow`, change `RecapCard.markShown(` to `LastShown.markShown(`.
- `ChatRulesTests.swift`: delete `// MARK: - Recaps` and `anOlderBlimpdsNotFoundSaysToUpdateItForRecaps`.
- `SessionFieldsTests.swift`: delete `decodesARecap`, `aRecapFromABlimpdBefore031ShowsDoneAndOpen` and `aRecapLeavesOutAnEmptySection`.
- Then `grep -rn "Recap" ios/BlimpKit` must print nothing.

- [ ] **Step 4: ChatModel and API**

In `ios/Blimp/Model/ChatModel.swift`:
- Delete `recapLoad` and `recapNew` with their doc comments (lines 49-52), and `recapAsk` with its comment (lines 63-64).
- In `visitFrom`'s doc comment, change `for "since you left" and the return card.` to `for "since you left".`
- In `markShown`, change `RecapCard.markShown(` to `LastShown.markShown(`.
- Delete `recap(auto:)`, `canRecap`, `loadRecap(auto:)` and `recapOpened()` with their doc comments (from `/// The return card. auto:` through the end of `recapOpened`, about lines 365-401).

In `ios/Blimp/Net/API.swift` delete `func recap(name:min:)` and its two-line doc comment (lines 79-84).

- [ ] **Step 5: ChatExtras**

In `ios/Blimp/Views/ChatExtras.swift`:
- Header (lines 1-4) becomes:

```swift
// The parts of a chat beyond its messages: Run under a command Claude handed over (with a sheet that shows
// the whole command before it runs, then "Send result to Claude" once it ended), the context gauge, the "since
// you left" line and the chip to the next session waiting. The rules are in BlimpKit (ChatRules, ContextText).
```

- Delete from `// MARK: - Recap drawer` through the closing `}` of `struct RecapDrawer` (the `enum RecapLoad`, `struct RecapDrawer` and its `symbol`), stopping before `// MARK: - Small parts`.

- [ ] **Step 6: SessionView**

In `ios/Blimp/Views/SessionView.swift`:
- Header (lines 1-7) becomes:

```swift
// A session as a chat: the messages, what Claude is waiting on as buttons, and a box to type into.
// Voice: the mic types (or answers the prompt), the speaker toggle reads new replies and prompts aloud,
// and a banner says when another session starts waiting or finishes. While Claude works, Stop (and Stop and
// send, with text in the box) is pinned above the box. Opened (or come back to) after time away: a "since you
// left" line. The toolbar has the context gauge (from half full), then the speaker; Run is under the commands of
// Claude's latest reply (ChatExtras.swift).
```

- `SessionView` becomes:

```swift
struct SessionView: View {
    let name: String
    /// Shows another session in this one's place: the one Resume started, or a banner's.
    let onOpen: (String) -> Void

    var body: some View {
        ChatScreen(name: name, onResumed: onOpen)
            .id(name)
    }
}
```

- In `ChatScreen` delete `let onRecap` and `let onModel`, change `ChatContent(model: model, onResumed: onResumed, onRecap: onRecap)` to `ChatContent(model: model, onResumed: onResumed)`, and delete the `onModel(m)` line in `onAppear`.
- In `ChatContent` delete `let onRecap: () -> Void`.
- In the toolbar, change the comment `// The context gauge, the speaker, then Recap at the far right.` to `// The context gauge, then the speaker.` and delete the whole `if model.canRecap { Button(action: onRecap) { … } … .accessibilityIdentifier("recapButton") }` block.
- `cameBack()`: delete its last line `recapIfDue(last)` and, in its doc comment, delete `, and the return card waits in the recap drawer if it's been an hour` (end the sentence with `("since you left").`).
- Delete `recapIfDue(_:)` with its two-line doc comment.
- In `appeared()` delete the line `recapIfDue(model.visitFrom)`.

- [ ] **Step 7: HomeView**

In `ios/Blimp/Views/HomeView.swift`:
- Header: delete the sentence `In a Claude session's chat, a drawer from the right (a swipe left anywhere, or Recap) has its recap.`
- Delete the state `chatModel`, `recapOpen`, `recapPull`, `pullingRecap` with their doc comments (lines 33-39).
- Replace the swipe comment and `.simultaneousGesture(…)` (lines 73-111) with:

```swift
        // A swipe right anywhere pulls the drawer out, following the finger: one that starts mostly sideways, so
        // scrolling the chat never does. Let go past 120 points, or flung right: it opens; else back closed. While
        // the drawer is open this does nothing: a swipe on it closes it (DrawerView). Nor does one that starts in
        // something that scrolls sideways (a code box, the reply chips): it scrolls that instead, as this runs
        // while a scroll view in the chat scrolls too.
        .simultaneousGesture(
            DragGesture(minimumDistance: 10, coordinateSpace: .global)
                .onChanged { v in
                    if drawer { return }
                    if pulling == nil {
                        let free = !sideScrollers.contain(v.startLocation)
                        pulling = free && v.translation.width > 0 && abs(v.translation.width) > abs(v.translation.height) * 1.5
                    }
                    if pulling == true { pull = max(0, v.translation.width) }
                }
                .onEnded { v in
                    defer { pulling = nil }
                    guard pulling == true, !drawer else { return }
                    let open = v.translation.width > 120 || v.predictedEndTranslation.width > 260
                    withAnimation(.snappy) {
                        if open { drawer = true }
                        pull = nil
                    }
                }
        )
```

- Delete the overlay `.overlay { if let recapChat { RecapDrawer(…) } }` and the two `.onChange` lines after the browser overlay (`// The chat went …` and `// A card came by itself …`, each with its comment).
- `case .session(let name):` becomes `SessionView(name: name, onOpen: { show(.session($0)) })`.
- Delete `recapChat` and `openRecap()` with their doc comments.
- In `show(_:)` delete `recapOpen = false`.
- Then `grep -n -i "recap" ios/Blimp ios/BlimpKit -r` must print nothing.

- [ ] **Step 8: UI tests**

In `ios/BlimpUITests/BlimpUITests.swift`:
- Header line 7: delete ` the recap drawer from the right;`.
- Delete `// MARK: - The recap drawer` and the whole `testRecapDrawer` with its doc comment.
- In `testServerBrowserTab`'s doc comment change `(By name after the recap drawer.)` to `(By name after New session.)`.
- In `testInbox`'s doc comment, change `the speaker, then Recap at the far right, and no Inbox or ••• menu` to `then the speaker, and no Recap, Inbox or ••• menu`.
- In `testInbox`, replace from `// The top right: the gauge (from half full), the speaker, then Recap at the far right` through the `if element("inboxButton").exists …` line with:

```swift
        // The top right: the gauge (from half full), then the speaker; no Recap, Inbox or ••• menu
        let speaker = app.buttons.matching(NSPredicate(format: "label == 'Read aloud' OR label == 'Stop reading aloud'")).firstMatch
        try wait(speaker, "the speaker at the top right")
        let gauge = element("contextGauge")
        if gauge.exists, gauge.frame.minX >= speaker.frame.minX { throw failed("the context gauge left of the speaker") }
        if element("recapButton").exists || element("inboxButton").exists || element("chatMenu").exists {
            throw failed("no Recap, Inbox or ••• menu in the top bar")
        }
```

- [ ] **Step 9: Check by reading, then commit**

`grep -rn -i "recap" ios --include=*.swift` prints nothing. Re-read HomeView's body: every `@State` left is still used.

```bash
cd /Users/mbeato/blimp-strip && git add -A ios && git commit -m "iPhone: no recaps, so no Recap button or dot in a chat's top bar, no drawer from the right and no swipe left, since Max never opened them; the server still answers a recap ask; the last-shown times that 'since you left' needs move to BlimpKit's LastShown"
```

---

### Task 3: iPhone stops showing the project summary

**Files:**
- Delete: `ios/BlimpKit/Sources/BlimpKit/Digest.swift`
- Modify: `ios/BlimpKit/Sources/BlimpKit/Inbox.swift:134-147` (`asOf`, `stale` go), `ios/Blimp/Views/InboxView.swift`, `ios/Blimp/Model/Store.swift:17-18,85`, `ios/Blimp/Views/HomeView.swift` (InboxView call)
- Test: `ios/BlimpKit/Tests/BlimpKitTests/InboxTests.swift:99-113`, `InboxRowsTests.swift`, `ios/BlimpUITests/BlimpUITests.swift` (`testInbox`)

**Interfaces:**
- `InboxView` loses its `digest: Digest?` parameter. `Store.digests` goes. The session list's `digests` field is now ignored by the phone's decoder (it never required it).

- [ ] **Step 1: BlimpKit**

- `git rm ios/BlimpKit/Sources/BlimpKit/Digest.swift` (the `Digest` type and `EventsMessage.digests`).
- In `Inbox.swift`'s `InboxText`, delete `asOf(_:now:)` with its doc comment and `stale(_:sessions:)` with its doc comment.
- `InboxTests.swift`: delete `aDigestsLinksNameItsSessions` and `theSessionsEventCarriesEachFoldersDigest`.
- `InboxRowsTests.swift`: delete the line `#expect(InboxText.asOf(now - 2 * minute, now: now) == "as of 2m ago")` and the test `theParagraphIsStaleOnceASessionItLinksChangedStateAfterIt`.

- [ ] **Step 2: Store**

In `ios/Blimp/Model/Store.swift` delete `var digests: [String: Digest] = [:]` with its doc comment, and the line `self.digests = EventsMessage.digests(data)`.

- [ ] **Step 3: InboxView**

In `ios/Blimp/Views/InboxView.swift`:
- Header (lines 1-7) becomes:

```swift
// A project's inbox, what opening a project shows, above the box that starts a new chat (StartView). In a fixed
// order: after a while away, one line on what changed since (a tap shows only that); Needs you, the project's
// sessions waiting on you, oldest first, with its answers in the row (Allow and Deny, a question's choices, or a
// button into the chat; another project's are in its own inbox); then the project's sessions finished and not
// read yet, those working (how long, a clock after 30 minutes), and the rest folded as "+3 other". A tap opens
// one; a swipe left or press and hold has its actions (RowMenu).
```

- Delete `let digest: Digest?`. Change the doc comment of `sessions` to `/// Every running session: the rows' parents.`
- In `list(now:)` delete `if let digest { Section { paragraphSection(digest, now: now) } }`, and change the overlay's condition to `if inbox.isEmpty && needs.isEmpty {`.
- Delete `paragraphSection(_:now:)`, `private static let scheme` and `paragraph(_:)` with their doc comments.

- [ ] **Step 4: HomeView**

In the `InboxView(…)` call delete `digest: store.digests[dir], `.

- [ ] **Step 5: UI test**

In `testInbox`, right after `try until(line, "label CONTAINS 'follow the system setting'", "demo-chat's note", timeout: 60)`, add:

```swift
        if element("inbox-digest").exists { throw failed("no paragraph on top of the inbox") }
```

- [ ] **Step 6: Check by reading, then commit**

`grep -rn "Digest\|digest\|asOf\|InboxText.stale" ios --include=*.swift` prints only the new `inbox-digest` line in the UI test.

```bash
cd /Users/mbeato/blimp-strip && git add -A ios && git commit -m "iPhone: a project's inbox starts with Needs you, with no summary paragraph on top, since it repeated the lists under it as a wall of text; blimpd still writes and sends the paragraphs"
```

---

### Task 4: iPhone project strip in the drawer, back arrow in a chat

**Files:**
- Modify: `ios/Blimp/Views/DrawerView.swift` (header comment, parameters, `panel`; `picker` goes)
- Modify: `ios/Blimp/Views/HomeView.swift` (DrawerView call, `pickProject`, toolbar, title)
- Test: `ios/BlimpUITests/BlimpUITests.swift`

**Interfaces:**
- Consumes: `Strip.letters`, `Strip.held` (Task 1); `MarkView(mark:)` (`ios/Blimp/Views/SessionRows.swift:8`); `Drawer.badge` (unchanged).
- `DrawerView` loses `onInbox` and `needs`; `onProject` now keeps the drawer open.

- [ ] **Step 1: DrawerView**

In `ios/Blimp/Views/DrawerView.swift`:

Header (lines 1-8) becomes:

```swift
// The drawer from the left: a strip of the projects down its left side (two letters each, with the mark of the
// session there that needs you most; a tap shows that project's inbox behind the drawer and its sessions in it,
// and the drawer stays open; Settings at its foot), and beside it the project's name with + (New session: the
// inbox's box, ready to type into), its running sessions, the project's browser tabs (a dot on ones a session
// opened; a tap opens one full screen, New Tab opens one, a swipe right closes one), then its past conversations
// folded under Earlier (each newest activity first, with its mark, and under its title its branch, jobs and
// handoff). A tap opens one; a swipe right on a row or press and hold has its actions (Stop, Mark read, End;
// Resume a past one). It follows the finger: a swipe right in the chat pulls it out (HomeView's `pull`), a swipe
// left on it or beside it pushes it back, and letting go settles it open or closed by where it is and how fast
// it went. A tap beside it closes it too.
```

Parameters: change the doc comment of `dir`/`projects` to `/// The project shown, and the ones the strip lists.`; add `/// Shows a project's inbox behind the drawer, which stays open with its sessions.` above `let onProject`; delete `let onInbox: () -> Void`, and `let needs: Int` with its doc comment. Add after `@State private var sideways`:

```swift
    /// The strip's order, read as the drawer comes out (Strip.held), so an icon never moves under a finger.
    @State private var order: [String] = []
```

Replace `private var panel: some View { … }` (lines 93-163) with:

```swift
    private var panel: some View {
        HStack(spacing: 0) {
            strip
            Divider()
            VStack(alignment: .leading, spacing: 0) {
                header.padding(.horizontal).padding(.top, 12).padding(.bottom, 4)
                List {
                    if rows.isEmpty {
                        Text("No sessions here yet.").foregroundStyle(.secondary).listRowSeparator(.hidden)
                    }
                    if !active.isEmpty {
                        Section("Active") { ForEach(active) { rowButton($0) } }
                    }
                    // After the running sessions, so they stay in sight when the keyboard leaves the drawer short.
                    Section("Browser") {
                        ForEach(tabs) { tabRow($0) }
                        Button(action: onNewTab) {
                            Label("New Tab", systemImage: "plus").frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("drawerNewTab")
                    }
                    if !past.isEmpty {
                        Section {
                            // A row, not the section's header: a header doesn't reliably take taps.
                            Button { earlierOpen.toggle() } label: {
                                HStack(spacing: 4) {
                                    Image(systemName: "chevron.right").font(.caption2.weight(.bold)).rotationEffect(.degrees(earlierOpen ? 90 : 0))
                                    Text("Earlier")
                                    Text("\(past.count)").foregroundStyle(.tertiary)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .foregroundStyle(.secondary)
                            .listRowSeparator(.hidden)
                            .accessibilityLabel(earlierOpen ? "Earlier, \(past.count), open" : "Earlier, \(past.count), folded")
                            .accessibilityIdentifier("drawerEarlier")
                            if earlierOpen { ForEach(past) { rowButton($0) } }
                        }
                    }
                }
                .listStyle(.plain)
            }
        }
        .onAppear { order = projects.map(\.dir) }
        .accessibilityAddTraits(.isModal)
    }

    /// The projects, two letters each with their mark, the one shown lit; Settings at the foot.
    private var strip: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 10) {
                    ForEach(Strip.held(projects, order: order)) { stripIcon($0) }
                }
                .padding(.vertical, 12)
            }
            .scrollIndicators(.hidden)
            Button(action: onSettings) {
                Image(systemName: "gearshape").font(.title3).frame(width: 44, height: 44)
            }
            .foregroundStyle(.secondary)
            .accessibilityLabel("Settings")
            .accessibilityIdentifier("settingsButton")
            .padding(.bottom, 8)
        }
        .frame(width: 60)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("drawerStrip")
    }

    private func stripIcon(_ p: ProjectChoice) -> some View {
        Button { onProject(p.dir) } label: {
            Text(Strip.letters(p.name))
                .font(.subheadline.weight(.semibold))
                .frame(width: 40, height: 40)
                .background(p.dir == dir ? Color.accentColor.opacity(0.25) : Color.secondary.opacity(0.12),
                            in: RoundedRectangle(cornerRadius: 10))
                .overlay(alignment: .topTrailing) { MarkView(mark: p.mark).offset(x: 4, y: -4) }
        }
        .foregroundStyle(.primary)
        .accessibilityLabel(Self.label(p))
        .accessibilityAddTraits(p.dir == dir ? .isSelected : [])
        .accessibilityIdentifier("strip-" + p.name)
    }

    /// "blimp, asking you something", "mbeato, new reply", "api-server".
    private static func label(_ p: ProjectChoice) -> String {
        switch p.mark {
        case .asking: "\(p.name), asking you something"
        case .unread: "\(p.name), new reply"
        case .working, .none: p.name
        }
    }

    /// The project's name, and + for New session.
    private var header: some View {
        HStack {
            Text(dir.map(Drawer.name(of:)) ?? "Projects")
                .font(.title3.bold())
                .lineLimit(1)
                .accessibilityIdentifier("drawerProject")
            Spacer(minLength: 8)
            Button(action: onNewSession) {
                Image(systemName: "plus").font(.title3.weight(.semibold)).frame(width: 36, height: 36)
            }
            .accessibilityLabel("New session")
            .accessibilityIdentifier("drawerNewSession")
            .disabled(dir == nil)
        }
    }
```

Delete `private var picker: some View { … }` with its doc comment (lines 201-224).

- [ ] **Step 2: HomeView**

In `ios/Blimp/Views/HomeView.swift`:

- Header lines 1-4 become (the recap sentence already went in Task 2):

```swift
// The app's one screen, as chat apps have it: a project's inbox or a chat, and a drawer from the left (a swipe right
// anywhere, or ☰ on the inbox) with the project strip, New session and the project's sessions, running and past. A
// chat's top left goes back to its project's inbox. A project opens to its inbox, where the box at the bottom starts
// a session; the drawer's New session opens it with the keyboard up.
```

- The `DrawerView(…)` call becomes:

```swift
            DrawerView(open: $drawer, pull: pull, dir: store.dir, projects: projects, onProject: pickProject, rows: rows, selected: selected,
                       onPick: pick, onNewSession: startNew,
                       onSettings: { drawer = false; showSettings = true },
                       actions: actions, onOpen: { show(.session($0)) },
                       tabs: store.dir.map { BrowserTab.inFolder(store.browserTabs, $0) } ?? [],
                       onTab: { browserTab = $0.id; drawer = false }, onNewTab: newTab, onCloseTab: closeTab)
```

- Replace `toolbar` and `title` with:

```swift
    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            if opened == .inbox {
                Button { drawer = true } label: {
                    Image(systemName: "line.3.horizontal")
                        .overlay(alignment: .topTrailing) { badge.offset(x: 5, y: -3) }
                }
                .accessibilityLabel(badgeLabel.map { "Sessions, \($0)" } ?? "Sessions")
                .accessibilityIdentifier("drawerButton")
                .accessibilityHidden(covered)
            } else {
                // In a chat: back to the project's inbox, with the same mark. A swipe right opens the drawer.
                Button { show(.inbox) } label: {
                    HStack(spacing: 2) {
                        Image(systemName: "chevron.left").font(.body.weight(.semibold))
                        Text(projectName).lineLimit(1).frame(maxWidth: 120, alignment: .leading)
                    }
                    .overlay(alignment: .topTrailing) { badge.offset(x: 8, y: -3) }
                }
                .accessibilityLabel(badgeLabel.map { "Back to \(projectName), \($0)" } ?? "Back to \(projectName)")
                .accessibilityIdentifier("backButton")
                .accessibilityHidden(covered)
            }
        }
        ToolbarItem(placement: .principal) { title }
    }

    /// What the screen shows; on the inbox the project's name under it (in a chat the back arrow has it).
    private var title: some View {
        VStack(spacing: 0) {
            // A long name (blimpd's go up to 40 characters) gets a little smaller to fit, rather than cut off.
            Text(subtitle).font(.headline).lineLimit(1).minimumScaleFactor(0.75)
            if opened == .inbox {
                Text(projectName).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("screenTitle")
        .accessibilityHidden(covered)
    }

    private var projectName: String { store.dir.map(Drawer.name(of:)) ?? "blimp" }
```

- Replace `pickProject(_:)` with:

```swift
    /// A project from the strip: its inbox, behind the drawer, which stays open with its sessions.
    private func pickProject(_ dir: String) {
        store.dir = dir
        opened = .inbox
    }
```

- Change the doc comment of `needs` to `/// The project's sessions waiting on you, oldest first: the inbox's top, and the top-left button's mark.`

- [ ] **Step 3: UI test helpers**

In `ios/BlimpUITests/BlimpUITests.swift`, add next to `element(_:)`:

```swift
    /// Home's top-left button: ☰ on a project's inbox, ‹ in a chat (a launch can reopen the last chat).
    private func homeButton() -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier IN %@", ["drawerButton", "backButton"])).firstMatch
    }
```

Replace `element("drawerButton")` with `homeButton()` in `test1PairChatAndAnswer` (`try wait(element("drawerButton"), "Home")`), `test2FaceIDLock` (`let home = element("drawerButton")`), `launchPaired` and `unlockWithFace`.

Replace `pickProject`, `openDrawer` and `closeDrawer` with:

```swift
    /// Picks a project from the drawer's strip; its inbox shows behind the drawer, which stays open with its
    /// sessions, and is closed after.
    private func pickProject(_ name: String) throws {
        try openDrawer()
        let icon = element("strip-" + name)
        try wait(icon, "\(name) in the project strip")
        icon.tap()
        try until(element("drawerProject"), "label == '\(name)'", "the drawer to show \(name)'s sessions")
        try closeDrawer()
        try until(element("screenTitle"), "label CONTAINS '\(name)'", "the title to show \(name)")
    }

    private func openDrawer() throws {
        let strip = element("drawerStrip")
        if strip.exists { return }
        try wait(homeButton(), "Home's top-left button")
        if element("drawerButton").exists {
            element("drawerButton").tap()
        } else {
            // In a chat there's no ☰: a swipe right from the middle opens the drawer.
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.5))
                .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)))
        }
        try wait(strip, "the drawer")
    }

    /// A tap beside the open drawer closes it.
    private func closeDrawer() throws {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        try until(element("drawerStrip"), "exists == false", "the drawer to close")
    }
```

- [ ] **Step 4: UI tests that used the drawer's Inbox row**

- `test4StartAndEnd`: replace `element("drawerInbox").tap()` with `try closeDrawer()`.
- `test9DrawerFromASwipe`: `let new = element("drawerInbox")` becomes `let new = element("drawerStrip")`.
- `testInbox`: replace the opening

```swift
        try pickProject("blimp-demo")
        try openDrawer()
        element("drawerInbox").tap()
        try until(element("screenTitle"), "label BEGINSWITH 'Inbox'", "the inbox")
```

with

```swift
        try pickProject("blimp-demo")
        try until(element("screenTitle"), "label BEGINSWITH 'Inbox'", "the inbox")
```

and replace its ending, from `// The drawer's Inbox goes back` to the end of the function body, with:

```swift
        // ‹ at the top left, naming the project, goes back to its inbox; there's no ☰ in a chat
        let back = element("backButton")
        try wait(back, "the back arrow at the top left")
        if element("drawerButton").exists { throw failed("no ☰ in a chat") }
        try until(back, "label CONTAINS 'blimp-demo'", "the back arrow to name the project")
        back.tap()
        try until(element("screenTitle"), "label BEGINSWITH 'Inbox'", "the inbox again from the chat")
```

  In its doc comment, change `The drawer's Inbox goes back.` to `‹ goes back.`
- `testNewSessionFromTheDrawer`: `try until(element("drawerInbox"), "exists == false", …)` uses `element("drawerStrip")`. In its doc comment, change `The drawer's New session` to `The drawer's +`.
- Then `grep -n "drawerInbox\|projectPicker" ios/BlimpUITests/BlimpUITests.swift` prints nothing.

- [ ] **Step 5: A new UI test for the strip**

Add after `testServerBrowserTab` (tests run in name order and share the simulator; `testSwitch…` comes last):

```swift
    // MARK: - The project strip

    /// From a chat in blimp-demo, api-server's icon in the drawer's strip: the drawer stays open with
    /// api-server's sessions, and behind it is api-server's inbox. (By name after the server browser.)
    func testSwitchProjectFromTheStrip() throws {
        try launchPaired()
        try openSession("demo-chat", in: "blimp-demo")
        try wait(message("message.user", "Add a dark mode toggle to settings"), "demo-chat's chat")
        try openDrawer()
        let icon = element("strip-api-server")
        try wait(icon, "api-server in the strip")
        icon.tap()
        try until(element("drawerProject"), "label == 'api-server'", "the drawer to show api-server")
        if !element("drawerStrip").exists { throw failed("the drawer to stay open on a project") }
        if element("session-demo-chat").exists { throw failed("blimp-demo's sessions to leave the drawer") }
        shot("39-strip")
        try closeDrawer()
        try until(element("screenTitle"), "label BEGINSWITH 'Inbox'", "an inbox behind the drawer, not the chat")
        try until(element("screenTitle"), "label CONTAINS 'api-server'", "api-server's inbox")
    }
```

In the file's header comment, after `the drawer's New session;` add ` a project from the drawer's strip;`.

- [ ] **Step 6: Check by reading, then commit**

Re-read `DrawerView`: `needs` and `onInbox` are gone everywhere; `store` is still used by `rowButton`. Re-read `HomeView`: `show(.inbox)` is still used (startNew, back arrow).

```bash
cd /Users/mbeato/blimp-strip && git add -A ios && git commit -m "iPhone: the drawer has a strip of project icons down its left side (two letters, the mark of what needs you, held in place while it's open; a tap shows that project's inbox and its sessions and the drawer stays open), a small + for New session and Settings at the strip's foot, and a chat's top left is ‹ and the project's name back to its inbox, since switching projects took three taps and the way back was always through the drawer"
```

---

### Task 5: Mac app stops showing recaps

**Files:**
- Delete: `app/src/components/RecapCard.tsx`, `app/src/lib/recap.ts`, `app/src/lib/recap.test.ts`, `app/e2e/recap.spec.ts`
- Modify: `app/src/components/TerminalPane.tsx:13,549-554,705,873-878,911-915`, `app/src/lib/api.ts:80-85,214-218`, `app/src/styles/app.css` (the return card block), `app/e2e/work.spec.ts:88`

- [ ] **Step 1: Install and see the tests pass first**

```bash
export PATH="$HOME/.bun/bin:$PATH" && cd /Users/mbeato/blimp-strip && bun install && cd app && bun install && bun test src && bunx tsc --noEmit
```

Expected: all pass. If something fails here, stop and report: it isn't this task's.

- [ ] **Step 2: Change the e2e expectation first**

In `app/e2e/work.spec.ts` replace line 88:

```ts
  for (const name of ["Recap", "Continue in New Session", "Give a Secret…"]) await expect(page.getByRole("menuitem", { name })).toBeVisible();
```

with

```ts
  for (const name of ["Continue in New Session", "Give a Secret…"]) await expect(page.getByRole("menuitem", { name })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Recap" })).toHaveCount(0);
```

Run: `BLIMP_E2E_PORT=5291 bun run e2e work.spec.ts` (in `app/`). Expected: FAIL on the `toHaveCount(0)` (Recap is still there).

- [ ] **Step 3: Remove the card**

- `git rm app/src/components/RecapCard.tsx app/src/lib/recap.ts app/src/lib/recap.test.ts app/e2e/recap.spec.ts`
- `TerminalPane.tsx`:
  - delete `import { RecapCard, useRecaps } from "./RecapCard";`
  - delete the six lines from `// Return cards, for the Claude sessions on screen here while this tab is in front.` through `const recap = recaps.card && …;` (this includes `isConversation`, used only by recaps)
  - delete `{!props.showList && recap?.name === name && <RecapCard card={recap.card} onClose={() => recaps.dismiss(name)} />}`
  - delete the comment `{/* Under the list, not in it: rows don't move when it comes and goes, and a drag between them (data-item) never sees it. */}` and the `{recap && ( <RecapCard … /> )}` block after it
  - delete the menu item `{isConversation(ctx.name) && ( <button role="menuitem" title="What this session is for, …" …> Recap </button> )}`
  - the file's header comment doesn't mention recaps; leave it
- `api.ts`: delete the `// The return card ("where was I?", …` comment and `export type Recap = …` (lines 80-85), and the `recap(name, min)` method with its two comment lines (lines 214-218).
- `app.css`: delete from `/* ---- return card ---- */` through the `.recap-part li + li { margin-top: 4px; }` rule.
- `grep -rn -i "recap" app/src app/e2e` must print nothing.

- [ ] **Step 4: Run everything**

```bash
export PATH="$HOME/.bun/bin:$PATH" && cd /Users/mbeato/blimp-strip/app && bun test src && bunx tsc --noEmit && BLIMP_E2E_PORT=5291 bun run e2e work.spec.ts
```

Expected: all pass, including the new `toHaveCount(0)`. Then run the whole e2e suite once: `BLIMP_E2E_PORT=5291 bun run e2e`. A timing-sensitive test that fails: run it alone before deciding it's yours.

- [ ] **Step 5: Commit**

```bash
cd /Users/mbeato/blimp-strip && git add -A app && git commit -m "Mac app: no return card in the session list or over the terminal, and no Recap in a session's right-click menu, since Max never read them; the server still answers a recap ask"
```

---

### Task 6: Docs

**Files:**
- Modify: `README.md:141`, `ios/README.md:7,9`, `docs/MAC-CHECKLIST.md:220-222`, `docs/PHONE-CHECKLIST.md` (lines 49-53, 67, then items found by their words), `docs/DESIGN.md:173,326,332`

- [ ] **Step 1: README.md**

Delete the bullet that starts `- **A card says where a session stands when you come back to it.**` (line 141).

- [ ] **Step 2: ios/README.md**

Line 7 becomes:

```markdown
The drawer on the left (swipe right, or ☰ at the top left of a project's inbox) has a strip of your projects down its left side: two letters each, with an amber question mark on one where a session asks you something and a blue dot on one with a new reply. Tap one: its inbox shows, and the drawer stays open with its sessions. Beside the strip: the project's name with + (New session, which opens the inbox's box ready to type into), and the project's sessions. Settings is at the foot of the strip. In a chat, ‹ and the project's name at the top left go back to its inbox. The inbox lists what needs you in that project at the top. Another project's sessions are in its own inbox; a banner still tells you when one starts waiting. You can answer a permission or a simple question right there, without opening the chat. Swipe a row to stop, end or mark it read. Press and hold a row to continue it in a new session. Each row shows its branch and background jobs.
```

In line 9, replace `The top right has, from the left, the context gauge, the speaker that reads replies aloud, and Recap. Recap, or a swipe left anywhere in the chat, opens a drawer that says what the session is for, then what's stuck, in progress, next and done. It never opens by itself: after an hour away, a dot on Recap says a new one is ready. ` with `The top right has the context gauge, then the speaker that reads replies aloud. `.

- [ ] **Step 3: docs/MAC-CHECKLIST.md**

Delete the item `- [ ] **Return card.**` with its `Do:` and `Expect:` lines (220-222).

- [ ] **Step 4: docs/PHONE-CHECKLIST.md**

Replace lines 49-53 (The inbox, A new chat, New session in the drawer, The project picker, The drawer) with:

```markdown
- [ ] The inbox. Open the app: the inbox of the project you used last. On top: Needs you (this project's only), then "Finished, not read yet" (a blue dot, Haiku's few words, "finished 3m ago"), Working ("working 14m") and "+3 other" for the rest, folded. No paragraph above them. There is no Sessions list: the drawer has it. Tap a line: its chat opens. A Finished line goes once you've opened that session.
- [ ] A new chat. The box at the bottom of the inbox. Type and send: Claude starts there with your message, and the chat becomes that session. In a chat, the top right has the context gauge (from half full), then the speaker, and no Recap, Inbox button or ••• menu.
- [ ] Back to the inbox. In a chat, the top left says ‹ and the project's name, with an amber question mark when another session needs you. Tap it: the project's inbox. There is no ☰ in a chat; ☰ is on the inbox.
- [ ] New session in the drawer. In a chat, open the drawer: + beside the project's name. Tap it: the drawer closes, the project's inbox shows, and its box has the keyboard up, ready to type. Nothing starts until you send (the Mac lists no new session). The same from the inbox.
- [ ] The project strip. Open the drawer: down its left side, an icon per project, two letters from its folder's name, newest activity on top. One where a session asks you something has an amber question mark; one with a new reply, a blue dot. Tap one: the drawer stays open with that project's sessions, its icon lit, and the inbox behind it is that project's. While the drawer is open, the icons don't move, even when another project gets newer activity.
- [ ] The drawer. Swipe right anywhere, in a chat too, or tap ☰ on the inbox: the strip, the project's name with +, the running sessions under Active, the Browser tabs, and the past ones under Earlier, folded until you tap it (it stays as you left it). The newest activity on top in each. A swipe left or a tap beside it closes it. Settings is the gear at the foot of the strip.
```

In line 67, replace `The drawer's Inbox says "2 need you". ` with nothing, and replace `the drawer button still shows the amber question mark for B's, and the picker says "Asking you something" under B.` with `the top-left button still shows the amber question mark for B's, and B's icon in the strip has one too.`

The replacement above adds a line, so find the rest by their words, not their numbers. Delete the items that start `- [ ] A stale paragraph dims.`, `- [ ] The recap drawer.`, `- [ ] The recap drawer from a swipe.`, `- [ ] The recap dot.`, `- [ ] The recap dot after the background.` and `- [ ] The recap dot after the lock.` In the item that starts `- [ ] Sideways scrolling moves no drawer.`, replace `only the code moves, neither drawer` with `only the code moves, not the drawer` and `still pulls a drawer` with `still pulls the drawer`.

- [ ] **Step 5: docs/DESIGN.md**

- In `### Recap`, replace the bullet that starts `- **How the apps show it:**` (line 173) with:

```markdown
- **The apps** don't show recaps (since 2026-10-23: nobody read them). The route stays, for later.
```

- Under `### Digests`, the line that starts `On the phone the inbox starts with a paragraph` (line 326) becomes:

```markdown
A paragraph on where each project's work stands (`src/digests.ts`), with the same model call as names. No app shows it now (since 2026-10-23); blimpd still writes it and sends it with the session list.
```

- Delete the bullet that starts `- **The phone** (` under `### Digests` (line 332).

- [ ] **Step 6: Check and commit**

`grep -n -i "recap\|paragraph\|project picker\|drawer's inbox" README.md ios/README.md docs/MAC-CHECKLIST.md docs/PHONE-CHECKLIST.md` prints nothing about the apps showing a recap, a paragraph, the picker or the drawer's Inbox.

```bash
cd /Users/mbeato/blimp-strip && git add README.md ios/README.md docs && git commit -m "Docs: the iPhone's project strip, its back arrow and its inbox with no paragraph, and no recaps in either app, in the READMEs, DESIGN and both checklists"
```

---

### Task 7: Push the branch and get CI green

Needs Max's yes before the first push (the plan's handoff asks).

- [ ] **Step 1: Push**

```bash
cd /Users/mbeato/blimp-strip && git push -u origin phone-strip
```

- [ ] **Step 2: Watch CI in the background**

```bash
cd /Users/mbeato/blimp-strip && gh run list --branch phone-strip --limit 5
```

Then watch each run to the end with `gh run watch <id> --exit-status` in the background (run_in_background), not a foreground sleep. Jobs that matter: CI (server and Mac), and iOS `kit-linux`, `app`, `app-e2e` (up to 30 minutes).

- [ ] **Step 3: Fix what fails**

For each failure: `gh run view <id> --log-failed`, fix in the worktree, commit (`iPhone: …` / `Mac app: …`, saying what the user sees), push, watch again. A Swift warning is an error: fix it, don't silence it. A UI test that fails on timing: read its screenshot in the `.xcresult` artifact before changing the test.

- [ ] **Step 4: Report**

Say which runs passed, with their links, and anything left for Max's hand check (`docs/PHONE-CHECKLIST.md`: The project strip, Back to the inbox, The drawer).
