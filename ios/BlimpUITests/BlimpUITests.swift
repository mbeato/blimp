// The app end to end, in the simulator, against a real blimpd with stand-in Claude sessions (the
// app-e2e job in .github/workflows/ios.yml; ios/e2e/setup.ts makes the sessions and the texts looked
// for here). Pair, see the session list, read a chat, hide the keyboard, send a message, answer a permission
// prompt; Stop and a folded long reply; start, end and resume sessions; blimpd restarting; the Face ID
// lock; two questions at once; a start that's stuck. What reached the sessions is checked by the job
// afterwards. Screenshots stay in the .xcresult.
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

        // Home: the stand-in's project, and its session by title
        try wait(element("project-blimp-demo"), "the blimp-demo project")
        let chatRow = element("session-demo-chat")
        try wait(chatRow, "the demo-chat row")
        try until(chatRow, "label CONTAINS 'Add a dark mode toggle to settings'", "the demo-chat row's title")
        try wait(element("session-demo-ask"), "the demo-ask row")
        shot("1-home")

        // The chat: the transcript's prompt and reply
        chatRow.tap()
        try wait(message("message.user", "Add a dark mode toggle to settings"), "the user message")
        try wait(message("message.assistant", "under Appearance"), "the assistant reply")
        // The tool call as one line, its command without the summary's backticks
        try wait(labeled("Ran swift test"), "the tool line")
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

        // The waiting session: its permission prompt as buttons
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let askRow = element("session-demo-ask")
        try wait(askRow, "the demo-ask row")
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
        let home = element("project-blimp-demo")
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
        let row = element("session-demo-busy")
        try wait(row, "the demo-busy row")
        row.tap()
        // A long chat opens at its newest message
        let newest = message("message.assistant", "Working through the routes now.")
        try wait(newest, "demo-busy's newest message")
        try until(newest, "isHittable == true", "the chat to open at its newest message")
        // Working, and the box is empty: Stop on the working row, the mic in the box
        let stop = app.buttons["Stop"]
        let working = labeled("working…")
        try wait(stop, "the Stop button")
        try wait(working, "the working row")
        try wait(app.buttons["Talk"], "the mic in the empty box")
        if app.buttons["sendButton"].exists { throw failed("no Send while working with an empty box") }
        // The long reply above the newest is folded
        let more = app.buttons["Show more"]
        try wait(more, "Show more on the long reply")
        shot("8-stop")
        stop.tap()
        // The stand-in stops working on Esc, as Claude does: the working row and its Stop go
        try until(stop, "exists == false", "the session to stop working")
        try until(working, "exists == false", "the working row to go")
        try wait(app.buttons["Talk"], "the mic after stopping")
        if labeled("Not sent").exists { throw failed("Stop was not sent") }
        shot("9-stopped")
        more.tap()
        try wait(app.buttons["Show less"], "Show less on the opened reply")
        shot("9a-unfolded")
    }

    // MARK: - Start and end a session

    func test4StartAndEnd() throws {
        try launchPaired()
        let before = Set(newRows().map(\.identifier))
        element("project-blimp-demo").tap()
        let plus = app.buttons["New session"]
        try wait(plus, "the + button")
        shot("10-project")
        plus.tap()
        // The app opens the new session: a chat with nothing in it yet, ready to type into
        try wait(labeled("No messages yet"), "the new session's empty chat", timeout: 40)
        try wait(element("messageField"), "the new session's message field")
        shot("11-started")
        back()
        back()
        // Home lists it in its project
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'session-blimp-demo-' AND NOT (identifier IN %@)", Array(before) as NSArray)).firstMatch
        try wait(row, "the new session on Home")
        let id = row.identifier
        shot("12-home-started")

        // End it: swipe, End, confirm
        row.swipeLeft()
        let end = app.buttons["End"]
        try wait(end, "the swipe's End")
        end.tap()
        try wait(labeled("End this session?"), "the end question")
        shot("13-end-confirm")
        try confirmEnd()
        let gone = element(id)
        try until(gone, "exists == false", "the ended session to leave Home")
        shot("14-ended")
    }

    // MARK: - Resume

    func test5Resume() throws {
        try launchPaired()
        element("project-blimp-demo").tap()
        let earlier = labeled("Fix the login redirect")
        try wait(earlier, "the past conversation under Earlier")
        shot("15-earlier")
        earlier.tap()
        // The new session runs `claude --resume <id>` (checked by the job); its chat is that conversation
        try wait(message("message.assistant", "the page you came from"), "the resumed conversation's chat", timeout: 40)
        try wait(element("messageField"), "the resumed session's message field")
        shot("16-resumed")
    }

    // MARK: - blimpd restarts

    func test6Reconnect() throws {
        try launchPaired()
        let row = element("session-demo-chat")
        try wait(row, "the demo-chat row")
        row.tap()
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
        back()
        // Home: the list is back and online
        try wait(element("session-demo-ask"), "the session list after the restart")
        try until(labeled("Can't reach the server"), "exists == false", "Home to be online")
        try until(labeled("Reconnecting…"), "exists == false", "Home to be online")
        shot("19-home-after-restart")
    }

    // MARK: - Several questions at once

    /// demo-quiz asks two questions as Claude's dialog does: a pick, then ticks and a typed answer, a review,
    /// Submit. The job checks the keys the stand-in got are the ones real Claude needs.
    func test7AnswerQuestions() throws {
        try launchPaired()
        let row = element("session-demo-quiz")
        try wait(row, "the demo-quiz row")
        row.tap()
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
        lint.tap()
        app.buttons["choice-E2E"].tap()
        try until(lint, "isSelected == true", "Lint to be ticked")
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

    // MARK: - A start that's stuck

    /// demo-stuck is Claude Code that never says which conversation it is (as on its folder-trust screen):
    /// a spinner, then after 20 s a line that says to open it on the Mac.
    func test8StuckStart() throws {
        try launchPaired()
        let row = element("session-demo-stuck")
        try wait(row, "the demo-stuck row")
        row.tap()
        try wait(labeled("Claude hasn't started"), "the note that Claude hasn't started", timeout: 40)
        if element("messageField").exists { throw failed("no message box while Claude hasn't started") }
        shot("24-stuck-start")
    }

    // MARK: - Helpers

    /// Launches the app and waits for Home, pairing first if it isn't (test1 failed before pairing).
    private func launchPaired() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
        let home = element("project-blimp-demo")
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
        let home = element("project-blimp-demo")
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

    /// Rows of sessions the app started in blimp-demo (named blimp-demo-<time>).
    private func newRows() -> [XCUIElement] {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'session-blimp-demo-'")).allElementsBoundByIndex
    }

    private func back() {
        app.navigationBars.buttons.element(boundBy: 0).tap()
    }

    /// The question's own End (the swipe's End is a button too).
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
}

private struct Timeout: Error, CustomStringConvertible {
    let what: String
    var description: String { "timed out waiting for \(what)" }
}
