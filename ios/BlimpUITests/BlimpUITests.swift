// The app end to end, in the simulator, against a real blimpd with stand-in Claude sessions (the
// app-e2e job in .github/workflows/ios.yml; ios/e2e/setup.ts makes the sessions and the texts looked
// for here). Pair, see the session list, read a chat, send a message, answer a permission prompt; Stop;
// start, end and resume sessions; blimpd restarting; the Face ID lock. What reached the sessions is
// checked by the job afterwards. Screenshots stay in the .xcresult.
//
// The tests run in name order and share the simulator: test1 pairs, the rest launch paired (the
// Keychain keeps the server), and test6 enrols Face ID, so it goes last. What the test can't do from
// inside the simulator (restart blimpd, Face ID) it asks ios/e2e/signals.sh for, with a file.
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
        shot("2-chat")

        // Send a message; the box clears once blimpd has it
        let input = element("messageField")
        try wait(input, "the message field")
        try type("Thanks, ship it", into: input)
        let send = app.buttons["sendButton"]
        try wait(send, "Send")
        try until(send, "isEnabled == true", "Send to be enabled")
        send.tap()
        try until(send, "exists == true AND isEnabled == false", "the message to be sent")
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

    // MARK: - Stop

    func test2Stop() throws {
        try launchPaired()
        let row = element("session-demo-busy")
        try wait(row, "the demo-busy row")
        row.tap()
        try wait(message("message.user", "Refactor the auth middleware"), "demo-busy's chat")
        // Working, and the box is empty: Stop in Send's place
        let stop = app.buttons["Stop"]
        try wait(stop, "the Stop button")
        if app.buttons["sendButton"].exists { throw failed("no Send while working with an empty box") }
        shot("6-stop")
        stop.tap()
        // The press is acknowledged (Stop turns back on) and nothing says it failed
        try until(stop, "isEnabled == true", "Stop to be acknowledged")
        if labeled("Not sent").exists { throw failed("Stop was not sent") }
        shot("7-stopped")
    }

    // MARK: - Start and end a session

    func test3StartAndEnd() throws {
        try launchPaired()
        let before = Set(newRows().map(\.identifier))
        element("project-blimp-demo").tap()
        let plus = app.buttons["New session"]
        try wait(plus, "the + button")
        shot("8-project")
        plus.tap()
        // The app opens the new session: a chat with nothing in it yet, ready to type into
        try wait(labeled("No messages yet"), "the new session's empty chat", timeout: 40)
        try wait(element("messageField"), "the new session's message field")
        shot("9-started")
        back()
        back()
        // Home lists it in its project
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'session-blimp-demo-' AND NOT (identifier IN %@)", Array(before) as NSArray)).firstMatch
        try wait(row, "the new session on Home")
        let id = row.identifier
        shot("10-home-started")

        // End it: swipe, End, confirm
        row.swipeLeft()
        let end = app.buttons["End"]
        try wait(end, "the swipe's End")
        end.tap()
        try wait(labeled("End this session?"), "the end question")
        shot("11-end-confirm")
        try confirmEnd()
        let gone = element(id)
        try until(gone, "exists == false", "the ended session to leave Home")
        shot("12-ended")
    }

    // MARK: - Resume

    func test4Resume() throws {
        try launchPaired()
        element("project-blimp-demo").tap()
        let earlier = labeled("Fix the login redirect")
        try wait(earlier, "the past conversation under Earlier")
        shot("13-earlier")
        earlier.tap()
        // The new session runs `claude --resume <id>` (checked by the job); its chat is that conversation
        try wait(message("message.assistant", "the page you came from"), "the resumed conversation's chat", timeout: 40)
        try wait(element("messageField"), "the resumed session's message field")
        shot("14-resumed")
    }

    // MARK: - blimpd restarts

    func test5Reconnect() throws {
        try launchPaired()
        let row = element("session-demo-chat")
        try wait(row, "the demo-chat row")
        row.tap()
        try wait(message("message.user", "Add a dark mode toggle to settings"), "demo-chat's chat")
        try signal("restart", wait: false)
        let bar = labeled("Reconnecting…")
        try wait(bar, "Reconnecting… in the chat", timeout: 20)
        shot("15-reconnecting")
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
        shot("16-reconnected")
        back()
        // Home: the list is back and online
        try wait(element("session-demo-ask"), "the session list after the restart")
        try until(labeled("Can't reach the server"), "exists == false", "Home to be online")
        try until(labeled("Reconnecting…"), "exists == false", "Home to be online")
        shot("17-home-after-restart")
    }

    // MARK: - Face ID

    func test6FaceIDLock() throws {
        try launchPaired()
        try signal("faceid-enrol")
        app.terminate()
        app.launch()
        allowFaceID()
        // Locked: no sessions, only Unlock
        let unlock = app.buttons["Unlock"].firstMatch
        try wait(unlock, "the lock screen")
        if element("project-blimp-demo").exists { throw failed("Home showing behind the lock") }
        screen("18-locked")
        try signal("faceid-match")
        if !element("project-blimp-demo").waitForExistence(timeout: 10) {
            // The ask may have ended before the face came: Unlock asks again
            screen("18b-still-locked")
            if unlock.exists && unlock.isHittable { unlock.tap() }
            allowFaceID()
            try signal("faceid-match")
        }
        try wait(element("project-blimp-demo"), "Home after Face ID")
        shot("19-unlocked")
    }

    // MARK: - Helpers

    /// Launches the app and waits for Home, pairing first if it isn't (test1 failed before pairing).
    private func launchPaired() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
        let home = element("project-blimp-demo")
        let field = element("pairField")
        let end = Date().addingTimeInterval(30)
        while Date() < end, !home.exists, !field.exists { _ = home.waitForExistence(timeout: 1) }
        if field.exists {
            field.tap()
            field.typeText(try pairLink())
            app.buttons["connectButton"].tap()
        }
        try wait(home, "Home")
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
    /// state comes in, and a tap on the old one gives nothing focus), then types.
    private func type(_ text: String, into field: XCUIElement) throws {
        for _ in 0..<5 {
            field.tap()
            let focused = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hasKeyboardFocus == true"), object: field)
            if XCTWaiter().wait(for: [focused], timeout: 3) == .completed {
                field.typeText(text)
                return
            }
        }
        throw failed("the keyboard in the message field")
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
