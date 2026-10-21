// The app end to end, in the simulator, against a real blimpd with stand-in Claude sessions (the
// app-e2e job in .github/workflows/ios.yml; ios/e2e/setup.ts makes the sessions and the texts looked
// for here). Pair, pick a project, open sessions from the drawer, read a chat, hide the keyboard, send a
// message, answer a permission prompt; Stop and a folded long reply; start a session from a blank chat and
// end it; read a past conversation and resume it by sending; blimpd restarting; the Face ID lock; two questions
// at once; unread and asking marks; a project's inbox. What reached the sessions is checked by the job afterwards. Screenshots
// stay in the .xcresult.
//
// The tests run in name order and share the simulator: test1 pairs, the rest launch paired (the
// Keychain keeps the server) and so locked: the job enrols Face ID first, and each unlocks with a
// matching face. What the test can't do from inside the simulator (restart blimpd, a face) it asks
// ios/e2e/signals.sh for, with a file.
import XCTest

@MainActor
final class BlimpUITests: XCTestCase {
    private var app: XCUIApplication!

    func test1PairChatAndAnswer() throws {
        continueAfterFailure = false
        let link = try pairLink()
        app = XCUIApplication()
        app.launch()

        // Pair
        let field = element("pairField")
        try wait(field, "the pairing field")
        field.tap()
        field.typeText(link)
        let connect = app.buttons["connectButton"]
        try wait(connect, "Connect")
        connect.tap()

        // A project's inbox; the drawer lists blimp-demo's session by title, with a reply not seen yet
        // (the stand-ins' replies came after blimpd started)
        try wait(element("projectPicker"), "the project picker")
        shot("1-inbox")
        try pickProject("blimp-demo")
        try openDrawer()
        let chatRow = element("session-demo-chat")
        try wait(chatRow, "the demo-chat row")
        try until(chatRow, "label CONTAINS 'Add a dark mode toggle to settings'", "the demo-chat row's title")
        try until(chatRow, "label CONTAINS 'New reply'", "demo-chat's reply to be unread")
        try wait(labeled("Fix the login redirect"), "the past conversation in the drawer")
        shot("1-drawer")

        // The chat: the transcript's prompt and reply
        chatRow.tap()
        try wait(message("message.user", "Add a dark mode toggle to settings"), "the user message")
        try wait(message("message.assistant", "under Appearance"), "the assistant reply")
        // Tool steps aren't shown: the reply before the tool call is, the tool call isn't
        try wait(message("message.assistant", "then run the tests"), "the reply before the tool call")
        if labeled("Ran swift test").exists { throw failed("no tool line in the chat") }
        // The empty box: the mic inside it, no Send
        let mic = app.buttons["Talk"]
        try wait(mic, "the mic in the empty box")
        if app.buttons["sendButton"].exists { throw failed("no Send while the box is empty") }
        shot("2-chat")

        // The keyboard goes as in Messages: a drag down the chat, or a tap on it
        let input = element("messageField")
        try wait(input, "the message field")
        let keyboard = app.keyboards.firstMatch
        try focus(input)
        try wait(keyboard, "the keyboard after tapping the message field")
        try above(input, keyboard)
        shot("2a-keyboard")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
            .press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)))
        try until(keyboard, "exists == false", "a drag down the chat to hide the keyboard")
        if app.keyboards.count != 0 { throw failed("no keyboard after the drag") }
        try focus(input)
        try wait(keyboard, "the keyboard again")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)).tap()
        try until(keyboard, "exists == false", "a tap on the chat to hide the keyboard")

        // Send a message; the box clears once blimpd has it, and the mic is back
        try type("Thanks, ship it", into: input)
        let send = app.buttons["sendButton"]
        try wait(send, "Send")
        try until(send, "isEnabled == true", "Send to be enabled")
        if mic.exists { throw failed("no mic once there's text") }
        shot("2b-typing")
        send.tap()
        try wait(mic, "the box to clear once the message is sent")
        // The stand-in writes what it read and a reply to the transcript: both arrive in the open chat
        try wait(message("message.user", "Thanks, ship it"), "the sent message in the chat")
        try wait(message("message.assistant", "Shipped: Thanks, ship it"), "the reply to it")
        shot("3-sent")

        // Read now: its row has no blue dot any more
        try openDrawer()
        try until(chatRow, "NOT (label CONTAINS 'New reply')", "demo-chat to be read once open")

        // The waiting session, marked as asking: its permission prompt as buttons
        try pickProject("api-server")
        try openDrawer()
        let askRow = element("session-demo-ask")
        try wait(askRow, "the demo-ask row")
        try until(askRow, "label CONTAINS 'Asking you something'", "demo-ask's asking mark")
        askRow.tap()
        let yes = app.buttons["choice-Yes"]
        try wait(yes, "the Yes button")
        try wait(app.buttons["choice-No"], "the No button")
        try wait(labeled("Ran npm test"), "the prompt's summary")
        shot("4-prompt")
        yes.tap()
        // Acknowledged: the buttons stay off while the session still shows this prompt
        try until(yes, "isEnabled == false", "the answer to be acknowledged")
        shot("5-answered")
    }

    // MARK: - Face ID

    /// The first launch with a server saved: locked until Face ID (enrolled by the job before the tests)
    /// sees a matching face. The simulator counts as having a passcode, so without Face ID it would ask for that.
    func test2FaceIDLock() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
        let unlock = app.buttons["Unlock"].firstMatch
        let home = element("projectPicker")
        try wait(unlock, "the lock screen")
        if home.exists { throw failed("Home showing behind the lock") }
        allowFaceID()
        screen("6-locked")
        try unlockWithFace()
        shot("7-unlocked")
    }

    // MARK: - Stop

    func test3Stop() throws {
        try launchPaired()
        try openSession("demo-busy", in: "api-server")
        // A long chat opens at its newest message
        let newest = message("message.assistant", "Working through the routes now.")
        try wait(newest, "demo-busy's newest message")
        try until(newest, "isHittable == true", "the chat to open at its newest message")
        // Working, and the box is empty: Stop on the working row, the mic in the box
        let stop = app.buttons["Stop"]
        let working = labeled("working…")
        try wait(stop, "the Stop button")
        try wait(working, "the working row")
        // with Claude's latest step, its command without the summary's backticks
        try wait(labeled("Ran npm run lint"), "the latest step on the working row")
        try wait(app.buttons["Talk"], "the mic in the empty box")
        if app.buttons["sendButton"].exists { throw failed("no Send while working with an empty box") }
        // The long reply above the newest is folded
        let more = app.buttons["Show more"]
        try wait(more, "Show more on the long reply")
        shot("8-stop")
        // The stand-in stops working on Esc, as Claude does: the working row and its Stop go. Again only
        // if the session read nothing (stop.in), so the job still sees exactly one Esc.
        try tap(stop, until: "exists == false", "the session to stop working") {
            stop.exists && stop.isEnabled && self.hostFile("stop.in").isEmpty && !self.labeled("Not sent").exists
        }
        try until(working, "exists == false", "the working row to go")
        try wait(app.buttons["Talk"], "the mic after stopping")
        if labeled("Not sent").exists { throw failed("Stop was not sent") }
        shot("9-stopped")
        more.tap()
        try wait(app.buttons["Show less"], "Show less on the opened reply")
        shot("9a-unfolded")
    }

    // MARK: - Start and end a session

    /// A blank chat: Send starts Claude in the project with the message as its first prompt (the job checks
    /// its arguments). Press and hold its row in the drawer to end it.
    func test4StartAndEnd() throws {
        try launchPaired()
        try pickProject("blimp-demo")
        try openDrawer()
        let before = Set(newRows().map(\.identifier))
        element("drawerNewChat").tap()
        try wait(labeled("What should Claude do here?"), "the blank chat")
        if app.buttons["Talk"].exists { throw failed("no mic in a blank chat") }
        shot("10-blank")
        let input = element("messageField")
        try type("Write the changelog", into: input)
        let send = app.buttons["sendButton"]
        try until(send, "isEnabled == true", "Send to be enabled")
        send.tap()
        // The chat becomes the new session: nothing in it yet, ready to type into
        try wait(labeled("No messages yet"), "the new session's chat", timeout: 40)
        try wait(app.buttons["Talk"], "the new session's mic")
        shot("11-started")
        // The drawer lists it
        try openDrawer()
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'session-blimp-demo-' AND NOT (identifier IN %@)", Array(before) as NSArray)).firstMatch
        try wait(row, "the new session in the drawer")
        let id = row.identifier
        shot("12-drawer-started")

        // End it: press and hold, End session, confirm
        row.press(forDuration: 1.2)
        let end = app.buttons["End session"]
        try wait(end, "End session on the row's menu")
        end.tap()
        try wait(labeled("End this session?"), "the end question")
        shot("13-end-confirm")
        try confirmEnd()
        try until(element(id), "exists == false", "the ended session to leave the drawer")
        shot("14-ended")
    }

    // MARK: - Resume

    /// A past conversation opens to read with nothing started; Send resumes it with the message (the job checks
    /// `--resume <id> -- <message>`).
    func test5Resume() throws {
        try launchPaired()
        try pickProject("blimp-demo")
        try openDrawer()
        let past = element("past-e2e00000-0000-0000-0000-000000000004")
        try wait(past, "the past conversation in the drawer")
        shot("15-drawer-past")
        past.tap()
        try wait(message("message.assistant", "the page you came from"), "the past conversation's messages")
        if hostFile("claude.args").contains("--resume") { throw failed("nothing started before Send") }
        shot("16-past")
        try type("Pick it up again", into: element("messageField"))
        let send = app.buttons["sendButton"]
        try until(send, "isEnabled == true", "Send to be enabled")
        send.tap()
        // The chat is the resumed session now: its mic, and the conversation's history
        try wait(app.buttons["Talk"], "the resumed session's chat", timeout: 40)
        try wait(message("message.assistant", "the page you came from"), "the resumed conversation's history")
        shot("16a-resumed")
    }

    // MARK: - blimpd restarts

    func test6Reconnect() throws {
        try launchPaired()
        try openSession("demo-chat", in: "blimp-demo")
        try wait(message("message.user", "Add a dark mode toggle to settings"), "demo-chat's chat")
        try signal("restart", wait: false)
        let bar = labeled("Reconnecting…")
        try wait(bar, "Reconnecting… in the chat", timeout: 20)
        shot("17-reconnecting")
        try waitDone("restart")
        try until(bar, "exists == false", "the chat to reconnect", timeout: 40)
        try wait(message("message.user", "Add a dark mode toggle to settings"), "the chat's history again")
        // A message sent now reaches the session
        let input = element("messageField")
        try type("After the restart", into: input)
        let send = app.buttons["sendButton"]
        try until(send, "isEnabled == true", "Send to be enabled")
        send.tap()
        try wait(message("message.assistant", "Shipped: After the restart"), "the reply after the restart")
        shot("18-reconnected")
        // The drawer: the list is back and online
        try openDrawer()
        try wait(element("session-demo-chat"), "the session list after the restart")
        try until(labeled("Can't reach the server"), "exists == false", "the app to be online")
        try until(labeled("Reconnecting…"), "exists == false", "the app to be online")
        shot("19-drawer-after-restart")
    }

    // MARK: - Several questions at once

    /// demo-quiz asks two questions as Claude's dialog does: a pick, then ticks and a typed answer, a review,
    /// Submit. The job checks the keys the stand-in got are the ones real Claude needs.
    func test7AnswerQuestions() throws {
        try launchPaired()
        try openSession("demo-quiz", in: "api-server")
        try wait(labeled("1 of 2"), "the first of two questions")
        try wait(labeled("Which database should the tests use?"), "the first question")
        let sqlite = app.buttons["choice-SQLite"]
        try wait(sqlite, "the SQLite option")
        shot("20-question-1")
        sqlite.tap()
        // A single-choice pick moves on; the multi-choice options tick and wait for Next
        try wait(labeled("2 of 2"), "the second question")
        let lint = app.buttons["choice-Lint"]
        try wait(lint, "the Lint option")
        // A tick is the phone's own state: again only while it isn't ticked
        try tap(lint, until: "isSelected == true", "Lint to be ticked", first: 3) { !lint.isSelected }
        let e2e = app.buttons["choice-E2E"]
        try tap(e2e, until: "isSelected == true", "E2E to be ticked", first: 3) { !e2e.isSelected }
        app.buttons["typeAnswer"].tap()
        let field = element("answerField")
        try wait(field, "the answer field")
        try type("smoke\n", into: field)
        shot("21-question-2")
        let next = app.buttons["nextButton"]
        try until(next, "isEnabled == true", "Review to be enabled")
        next.tap()
        // The review, then Submit sends both answers at once
        let submit = app.buttons["submitAnswers"]
        try wait(submit, "Submit on the review")
        try wait(labeled("Lint, E2E, smoke"), "the second answer on the review")
        try wait(labeled("SQLite"), "the first answer on the review")
        shot("22-review")
        submit.tap()
        // The stand-in took the answers and stopped waiting, as Claude does: the questions go
        try until(submit, "exists == false", "the questions to go once answered")
        if labeled("Not sent").exists || labeled("Stopped part way").exists { throw failed("the answers were not taken") }
        shot("23-answered")
    }

    // MARK: - Folder trust

    /// demo-trust is Claude Code asking whether to trust its folder, before anything else (no hook, no status
    /// file): blimpd reads it off the screen. It's marked as asking in the drawer; Yes in the chat, and Claude starts.
    func test8TrustFolder() throws {
        try launchPaired()
        try pickProject("api-server")
        try openDrawer()
        let row = element("session-demo-trust")
        try wait(row, "the demo-trust row")
        try until(row, "label CONTAINS 'Asking you something'", "demo-trust's asking mark")
        shot("24-drawer-trust")
        row.tap()
        let yes = app.buttons["choice-Yes, I trust this folder"]
        try wait(yes, "Yes, I trust this folder")
        try wait(app.buttons["choice-No, exit"], "No, exit")
        try wait(labeled("e2e-work/api-server"), "the folder")
        shot("25-trust")
        yes.tap()
        // Claude starts: the question goes, and its new conversation is ready to type into
        try until(yes, "exists == false", "the trust question to go once answered")
        try wait(labeled("No messages yet"), "the new conversation's empty chat")
        try wait(element("messageField"), "the message field")
        shot("26-trusted")
        // The names in the drawer (demo-quiz's is blimpd's, a long-ish one), and as its chat's title
        try openDrawer()
        let quiz = labeled("Configure Integration Test Pipeline Runs")
        try wait(quiz, "demo-quiz's name in the drawer")
        shot("27-drawer-names")
        quiz.tap()
        try wait(message("message.user", "Set up the test pipeline"), "demo-quiz's chat")
        try wait(labeled("Configure Integration Test Pipeline Runs"), "demo-quiz's name above its chat")
        shot("29-chat-name")
    }

    // MARK: - The drawer from the edge

    /// A swipe right from the left edge opens the drawer; a swipe left closes it.
    func test9DrawerFromTheEdge() throws {
        try launchPaired()
        let new = element("drawerNewChat")
        if new.exists { throw failed("the drawer closed at launch") }
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.5)))
        try wait(new, "the drawer after a swipe from the edge")
        shot("30-drawer-edge")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.5))
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5)))
        try until(new, "exists == false", "the drawer to close on a swipe left")
    }

    // MARK: - The inbox

    /// A project opens to its inbox: blimp-demo's demo-chat is in progress, in the words blimpd's note call got from
    /// the stand-in claude, and a tap opens its chat. The drawer's Inbox goes back to it. (Last: it runs after
    /// test1 has read demo-chat, which an in-progress note keeps listed.)
    func testInbox() throws {
        try launchPaired()
        try pickProject("blimp-demo")
        try openDrawer()
        element("drawerInbox").tap()
        try wait(element("inboxNewChat"), "the inbox")
        let line = element("inbox-session-demo-chat")
        try wait(line, "demo-chat in the inbox", timeout: 60)
        try until(line, "label CONTAINS 'dark mode toggle half done'", "demo-chat's note", timeout: 60)
        shot("31-inbox")
        line.tap()
        try wait(message("message.user", "Add a dark mode toggle to settings"), "demo-chat's chat from the inbox")
        try openDrawer()
        element("drawerInbox").tap()
        try wait(element("inboxNewChat"), "the inbox again from the drawer")
    }

    // MARK: - Helpers

    /// Picks a project from the picker above the chat, unless it's the one showing; it opens to its inbox.
    private func pickProject(_ name: String) throws {
        let picker = element("projectPicker")
        try wait(picker, "the project picker")
        if picker.label.hasPrefix(name) { return }
        // the open drawer covers the picker: close it (to a blank chat; picking a project then opens its inbox)
        let new = element("drawerNewChat")
        if new.exists {
            new.tap()
            try until(new, "exists == false", "the drawer to close")
        }
        picker.tap()
        let item = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
        try wait(item, "\(name) in the project picker")
        item.tap()
        try until(picker, "label BEGINSWITH '\(name)'", "the picker to show \(name)")
    }

    private func openDrawer() throws {
        let button = element("drawerButton")
        try wait(button, "the drawer button")
        button.tap()
        try wait(element("drawerNewChat"), "the drawer")
    }

    /// Opens a session from the drawer of its project.
    private func openSession(_ name: String, in project: String) throws {
        try pickProject(project)
        try openDrawer()
        let row = element("session-" + name)
        try wait(row, "the \(name) row in the drawer")
        row.tap()
    }

    /// The field stays in sight above the keyboard (once the keyboard has slid in).
    private func above(_ field: XCUIElement, _ keyboard: XCUIElement) throws {
        let end = Date().addingTimeInterval(5)
        while field.frame.maxY > keyboard.frame.minY + 1 {
            if Date() > end { throw failed("the message field above the keyboard") }
            _ = field.waitForExistence(timeout: 0.2)
        }
    }

    /// Launches the app and waits for Home, pairing first if it isn't (test1 failed before pairing).
    private func launchPaired() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
        let home = element("projectPicker")
        let field = element("pairField")
        let unlock = app.buttons["Unlock"].firstMatch
        let end = Date().addingTimeInterval(30)
        while Date() < end, !home.exists, !field.exists, !unlock.exists { _ = home.waitForExistence(timeout: 1) }
        if field.exists {
            field.tap()
            field.typeText(try pairLink())
            app.buttons["connectButton"].tap()
        } else if !home.exists {
            try unlockWithFace()
        }
        try wait(home, "Home")
    }

    /// Locked: a matching face (signals.sh), again if the first came before Face ID was looking.
    private func unlockWithFace() throws {
        let home = element("projectPicker")
        let unlock = app.buttons["Unlock"].firstMatch
        for _ in 0..<3 {
            allowFaceID()
            try signal("faceid-match")
            if home.waitForExistence(timeout: 10) { return }
            screen("still-locked")
            // the ask ended (or never started): Unlock asks again
            if unlock.exists && unlock.isHittable { unlock.tap() }
        }
        try wait(home, "Home after Face ID")
    }

    /// Rows of sessions the app started in blimp-demo (named blimp-demo-<time>), in the open drawer.
    private func newRows() -> [XCUIElement] {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'session-blimp-demo-'")).allElementsBoundByIndex
    }

    /// The question's own End.
    private func confirmEnd() throws {
        let inSheet = app.sheets.buttons["End"]
        if inSheet.waitForExistence(timeout: 3) { inSheet.tap(); return }
        let all = app.buttons.matching(NSPredicate(format: "label == 'End'")).allElementsBoundByIndex.filter(\.isHittable)
        guard let last = all.last else { throw failed("the question's End") }
        last.tap()
    }

    /// The first Face ID use asks "Do you want to allow blimp to use Face ID?".
    private func allowFaceID() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for owner in [springboard, app!] {
            for label in ["OK", "Allow"] {
                let b = owner.alerts.buttons[label]
                if b.waitForExistence(timeout: 2) {
                    screen("faceid-permission")
                    b.tap()
                    return
                }
            }
        }
    }

    private var signals: String {
        (ProcessInfo.processInfo.environment["E2E_DIR"] ?? "/tmp/be") + "/sig/"
    }

    /// Asks ios/e2e/signals.sh to do `name`, and (unless told not to) waits until it has.
    private func signal(_ name: String, wait: Bool = true) throws {
        try? FileManager.default.removeItem(atPath: signals + name + ".done")
        guard FileManager.default.createFile(atPath: signals + name, contents: Data()) else {
            throw failed("writing the signal " + name + " to " + signals)
        }
        if wait { try waitDone(name) }
    }

    private func waitDone(_ name: String, timeout: TimeInterval = 40) throws {
        let end = Date().addingTimeInterval(timeout)
        while !FileManager.default.fileExists(atPath: signals + name + ".done") {
            if Date() > end { throw failed("signals.sh to do " + name) }
            Thread.sleep(forTimeInterval: 0.3)
        }
    }

    /// The whole screen, system sheets included (Face ID).
    private func screen(_ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }

    /// The link the job made: from the environment (TEST_RUNNER_BLIMP_LINK), else the file setup.ts wrote.
    private func pairLink() throws -> String {
        if let l = ProcessInfo.processInfo.environment["BLIMP_LINK"], !l.isEmpty { return l }
        let dir = ProcessInfo.processInfo.environment["E2E_DIR"] ?? "/tmp/be"
        return try String(contentsOfFile: dir + "/link", encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func element(_ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    private func message(_ id: String, _ text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND label CONTAINS %@", id, text)).firstMatch
    }

    private func labeled(_ text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    private func shot(_ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }

    /// On a timeout: a screenshot and the element tree, so the run says what was on screen.
    private func failed(_ what: String) -> Error {
        shot("failed-" + what.replacingOccurrences(of: " ", with: "-"))
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = "tree"
        tree.lifetime = .keepAlways
        add(tree)
        // and the texts on screen in the log, for when the artifact doesn't say
        let texts = app.debugDescription.split(separator: "\n").filter { $0.contains("label:") || $0.contains("identifier:") }
        print("SCREEN at \(what):\n" + texts.prefix(80).joined(separator: "\n"))
        print("BLIMPD LOG at \(what):\n" + hostFile("blimpd.log").split(separator: "\n").suffix(30).joined(separator: "\n"))
        return Timeout(what: what)
    }

    /// Taps the field until it has the keyboard (the chat's input bar can be redrawn as the session's
    /// state comes in, and a tap on the old one gives nothing focus).
    private func focus(_ field: XCUIElement) throws {
        for _ in 0..<5 {
            field.tap()
            let focused = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hasKeyboardFocus == true"), object: field)
            if XCTWaiter().wait(for: [focused], timeout: 3) == .completed { return }
        }
        throw failed("the keyboard in the message field")
    }

    private func type(_ text: String, into field: XCUIElement) throws {
        try focus(field)
        field.typeText(text)
    }

    private func wait(_ e: XCUIElement, _ what: String, timeout: TimeInterval = 30) throws {
        if !e.waitForExistence(timeout: timeout) { throw failed(what) }
    }

    private func until(_ e: XCUIElement, _ predicate: String, _ what: String, timeout: TimeInterval = 30) throws {
        let x = XCTNSPredicateExpectation(predicate: NSPredicate(format: predicate), object: e)
        if XCTWaiter().wait(for: [x], timeout: timeout) != .completed { throw failed(what) }
    }

    /// Taps `e` until `predicate` holds on `target` (`e` itself by default). In the simulator a tap now
    /// and then shows the press but the button's action never runs: the recordings of runs 39438229858
    /// (Earlier's row), 39465937373 (Lint) and 39491150251 (Stop) show the press, then nothing, and
    /// blimpd got nothing. A person taps again; so does this, at most twice more, only when `again` says
    /// the first did nothing, with a screenshot and a line in the log each time.
    private func tap(_ e: XCUIElement, until predicate: String, on target: XCUIElement? = nil, _ what: String,
                     first: TimeInterval = 10, timeout: TimeInterval = 30, again: () -> Bool) throws {
        let x = { XCTNSPredicateExpectation(predicate: NSPredicate(format: predicate), object: target ?? e) }
        for n in 1...3 {
            e.tap()
            if XCTWaiter().wait(for: [x()], timeout: first) == .completed { return }
            guard n < 3, again() else { break }
            shot("tap-\(n)-didnt-take-" + what.replacingOccurrences(of: " ", with: "-"))
            print("TAP \(n) on \(e.identifier.isEmpty ? e.label : e.identifier) didn't take (waiting for \(what)); tapping again")
        }
        if XCTWaiter().wait(for: [x()], timeout: max(timeout - first, 0)) != .completed { throw failed(what) }
    }

    /// A file the job keeps in $E2E_DIR on the Mac (the simulator's test runner reads host paths), or "".
    private func hostFile(_ name: String) -> String {
        let dir = ProcessInfo.processInfo.environment["E2E_DIR"] ?? "/tmp/be"
        return (try? String(contentsOfFile: dir + "/" + name, encoding: .utf8)) ?? ""
    }
}

private struct Timeout: Error, CustomStringConvertible {
    let what: String
    var description: String { "timed out waiting for \(what)" }
}
