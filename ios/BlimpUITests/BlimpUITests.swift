// The app end to end, in the simulator, against a real blimpd with stand-in Claude sessions (the
// app-e2e job in .github/workflows/ios.yml; ios/e2e/setup.ts makes the sessions and the texts looked
// for here). Pair, see the session list, read a chat, send a message, answer a permission prompt.
// What reached the sessions is checked by the job afterwards. Screenshots stay in the .xcresult.
import XCTest

@MainActor
final class BlimpUITests: XCTestCase {
    private var app: XCUIApplication!

    func testPairChatAndAnswer() throws {
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
        shot("2-chat")

        // Send a message; the box clears once blimpd has it
        let input = element("messageField")
        try wait(input, "the message field")
        input.tap()
        input.typeText("Thanks, ship it")
        let send = app.buttons["sendButton"]
        try wait(send, "Send")
        try until(send, "isEnabled == true", "Send to be enabled")
        send.tap()
        try until(send, "exists == true AND isEnabled == false", "the message to be sent")
        shot("3-sent")

        // The waiting session: its permission prompt as buttons
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let askRow = element("session-demo-ask")
        try wait(askRow, "the demo-ask row")
        askRow.tap()
        let yes = app.buttons["choice-Yes"]
        try wait(yes, "the Yes button")
        try wait(app.buttons["choice-No"], "the No button")
        shot("4-prompt")
        yes.tap()
        // Acknowledged: the buttons stay off while the session still shows this prompt
        try until(yes, "isEnabled == false", "the answer to be acknowledged")
        shot("5-answered")
    }

    // MARK: - Helpers

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
        return Timeout(what: what)
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
