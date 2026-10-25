// The app end to end, in the simulator, against a real blimpd with stand-in Claude sessions (the
// app-e2e job in .github/workflows/ios.yml; ios/e2e/setup.ts makes the sessions and the texts looked
// for here). Pair, pick a project, open sessions from the drawer, read a chat, hide the keyboard, send a
// message, answer a permission prompt; Stop and a folded long reply; start a session from the inbox and
// end it; read a past conversation and resume it by sending; blimpd restarting; the Face ID lock, and a draft kept
// through it; two questions at once; unread and asking marks; a project's inbox and the chat's top bar; Allow from
// Needs you, in its own project's inbox only; the drawer's New session; a project from the drawer's strip; a server
// browser tab from the drawer, tapped and typed into; a start that's stuck. What reached the sessions is checked by
// the job afterwards. Screenshots stay in the .xcresult.
//
// The job runs them on three Macs at once (ios.yml lists which on each), in name order, sharing each Mac's
// simulator and stand-ins: the first pairs (test1, or launchPaired), the rest launch paired (the Keychain
// keeps the server) and so locked: the job enrols Face ID first, and each unlocks with a matching face. What
// reached the stand-ins is checked per test (ios/e2e/check.sh). What the test can't do from inside the
// simulator (restart blimpd, a face) it asks ios/e2e/signals.sh for, with a file.
import XCTest

@MainActor
final class BlimpUITests: XCTestCase {
    private var app: XCUIApplication!

    func test1PairChatAndAnswer() throws {
        continueAfterFailure = false
        let link = try pairLink()
        app = launchable()
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
        try wait(homeButton(), "Home")
        shot("1-inbox")
        try pickProject("blimp-demo")
        try openDrawer()
        let chatRow = element("session-demo-chat")
        try wait(chatRow, "the demo-chat row")
        try until(chatRow, "label CONTAINS 'Add a dark mode toggle to settings'", "the demo-chat row's title")
        try until(chatRow, "label CONTAINS 'New reply'", "demo-chat's reply to be unread")
        try showEarlier()
        try wait(labeled("Fix the login redirect"), "the past conversation in the drawer")
        shot("1-drawer")

        // The chat: the transcript's prompt and reply
        chatRow.tap()
        try wait(message("message.user", "Add a dark mode toggle to settings"), "the user message")
        try wait(message("message.assistant", "under Appearance"), "the assistant reply")
        // Tool steps aren't shown: the reply before the tool call is, the tool call isn't
        try wait(message("message.assistant", "then run the tests"), "the reply before the tool call")
        if labeled("Ran swift test").exists { throw failed("no tool line in the chat") }
        // The empty box: the mic inside it, no Send, and one-tap replies above it
        let mic = app.buttons["Talk"]
        try wait(mic, "the mic in the empty box")
        if app.buttons["sendButton"].exists { throw failed("no Send while the box is empty") }
        try wait(element("chip-go"), "the one-tap replies above the empty box")
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

        // Send a message; the mic stays beside Send (to talk more onto it), and Send goes once blimpd has it
        try type("Thanks, ship it", into: input)
        let send = app.buttons["sendButton"]
        try wait(send, "Send")
        try until(send, "isEnabled == true", "Send to be enabled")
        if !mic.exists { throw failed("the mic beside Send once there's text") }
        if element("chip-go").exists { throw failed("no one-tap replies once there's text") }
        shot("2b-typing")
        send.tap()
        try until(input, "NOT (value CONTAINS 'Thanks, ship it')", "the box to clear once the message is sent")
        try until(send, "exists == false", "no Send once the box is empty")
        // The stand-in writes what it read and a reply to the transcript: both arrive in the open chat
        try wait(message("message.user", "Thanks, ship it"), "the sent message in the chat")
        try wait(message("message.assistant", "Shipped: Thanks, ship it"), "the reply to it")
        shot("3-sent")

        // Read now: its row has no blue dot any more. The keyboard goes as the drawer comes out.
        try focus(input)
        try openDrawer()
        try until(app.keyboards.firstMatch, "exists == false", "the keyboard to go as the drawer opens")
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
        app = launchable()
        app.launch()
        let unlock = app.buttons["Unlock"].firstMatch
        let home = homeButton()
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

    /// The inbox's box: Send starts Claude in the project with the message as its first prompt (the job checks
    /// its arguments). Press and hold its row in the drawer to end it.
    func test4StartAndEnd() throws {
        try launchPaired()
        try pickProject("blimp-demo")
        try openDrawer()
        let before = Set(newRows().map(\.identifier))
        try closeDrawer()
        try until(element("screenTitle"), "label BEGINSWITH 'Inbox'", "the inbox")
        try wait(app.buttons["Talk"], "the mic in the inbox's box")
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
        try showEarlier()
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
        // The chat is the resumed session now (its speaker button: the past one has a mic too), and the
        // conversation's history
        let speaker = app.buttons.matching(NSPredicate(format: "label == 'Read aloud' OR label == 'Stop reading aloud'")).firstMatch
        try wait(speaker, "the resumed session's chat", timeout: 40)
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

    // MARK: - The drawer from a swipe

    /// A swipe right, from the middle of the screen too, opens the drawer; a swipe left closes it.
    func test9DrawerFromASwipe() throws {
        try launchPaired()
        let new = element("drawerStrip")
        if new.exists { throw failed("the drawer closed at launch") }
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.5))
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)))
        try wait(new, "the drawer after a swipe right")
        shot("30-drawer-edge")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.5))
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5)))
        try until(new, "exists == false", "the drawer to close on a swipe left")
    }

    // MARK: - The lock keeps your place

    /// Words in the box and the open chat stay through the lock: the chat lives on under the cover. A long press
    /// on a one-tap reply puts its words in the box and sends nothing. Here the lock comes after 2 s away
    /// (-lockGrace) instead of 5 minutes.
    func testDraftKeptThroughRelock() throws {
        try launchPaired(arguments: ["-lockGrace", "2"])
        try openSession("demo-chat", in: "blimp-demo")
        let chat = message("message.user", "Add a dark mode toggle to settings")
        try wait(chat, "demo-chat's chat")
        let chip = element("chip-continue")
        try wait(chip, "the one-tap replies above the empty box")
        chip.press(forDuration: 1)
        let input = element("messageField")
        try until(input, "value == 'continue'", "the chip's words in the box")
        shot("33-draft")
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 4)
        app.activate()
        try wait(app.buttons["Unlock"].firstMatch, "the lock after the grace time")
        try unlockWithFace()
        try wait(chat, "the same chat after unlocking")
        try until(input, "value == 'continue'", "the words still in the box after unlocking")
        if hostFile("chat.in").contains("continue") { throw failed("nothing sent by the long press or the lock") }
        shot("34-draft-after-lock")
        // Empty again, so no later test finds words in it
        try focus(input)
        input.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 12))
        try until(app.buttons["sendButton"], "exists == false", "the box to be empty again")
    }

    // MARK: - The inbox

    /// A project opens to its inbox: blimp-demo's demo-chat waits on you, in the words blimpd's note call got from
    /// the stand-in claude (a question), and a tap opens its chat. Its top right is the context gauge (when it shows),
    /// then the speaker, and no Recap, Inbox or ••• menu. ‹ goes back. (Last: it
    /// runs after test1 has read demo-chat, which a question note keeps listed.)
    func testInbox() throws {
        try launchPaired()
        try pickProject("blimp-demo")
        try until(element("screenTitle"), "label BEGINSWITH 'Inbox'", "the inbox")
        let line = element("inbox-session-demo-chat")
        try wait(line, "demo-chat in the inbox", timeout: 60)
        try until(line, "label CONTAINS 'follow the system setting'", "demo-chat's note", timeout: 60)
        if element("inbox-digest").exists { throw failed("no paragraph on top of the inbox") }
        shot("31-inbox")
        line.tap()
        try wait(message("message.user", "Add a dark mode toggle to settings"), "demo-chat's chat from the inbox")
        // The top right: the gauge (from half full), then the speaker; no Recap, Inbox or ••• menu
        let speaker = app.buttons.matching(NSPredicate(format: "label == 'Read aloud' OR label == 'Stop reading aloud'")).firstMatch
        try wait(speaker, "the speaker at the top right")
        let gauge = element("contextGauge")
        if gauge.exists, gauge.frame.minX >= speaker.frame.minX { throw failed("the context gauge left of the speaker") }
        if element("recapButton").exists || element("inboxButton").exists || element("chatMenu").exists {
            throw failed("no Recap, Inbox or ••• menu in the top bar")
        }
        shot("32-chat-top-right")
        // ‹ at the top left, naming the project, goes back to its inbox; there's no ☰ in a chat
        let back = element("inboxBack")
        try wait(back, "the back arrow at the top left")
        if element("drawerButton").exists { throw failed("no ☰ in a chat") }
        try until(back, "label CONTAINS 'blimp-demo'", "the back arrow to name the project")
        if back.frame.maxX > element("screenTitle").frame.minX { throw failed("the back arrow left of the title") }
        back.tap()
        try until(element("screenTitle"), "label BEGINSWITH 'Inbox'", "the inbox again from the chat")
    }

    // MARK: - Needs you

    /// blimp-demo's inbox lists its demo-perm under Needs you, with its command, and api-server's doesn't; Allow
    /// answers it from the row (blimpd's answer route, no chat opened), and the row says Answered. The job checks
    /// demo-perm got 1. (After testInbox, by name: nothing else reads demo-perm.)
    func testNeedsYouAllowFromTheInbox() throws {
        try launchPaired()
        try pickProject("api-server")
        let line = element("inbox-session-demo-perm")
        // pickProject waited for api-server's inbox; the sessions were listed before that
        if line.waitForExistence(timeout: 3) { throw failed("no blimp-demo session in api-server's inbox") }
        try pickProject("blimp-demo")
        try wait(line, "demo-perm under Needs you in its project's inbox")
        try until(line, "label CONTAINS 'npm run build'", "demo-perm's command on its row")
        let allow = element("inbox-allow-demo-perm")
        try wait(allow, "Allow on demo-perm's row")
        try wait(element("inbox-deny-demo-perm"), "Deny on demo-perm's row")
        shot("35-needs-you")
        try tap(allow, until: "exists == true", on: labeled("Answered"), "the answer from the row to be typed") {
            allow.isEnabled && self.hostFile("perm.in").isEmpty && !self.labeled("Not sent").exists
        }
        try until(allow, "isEnabled == false", "Allow to stay off once answered")
        shot("36-needs-you-answered")
    }

    // MARK: - New session

    /// The drawer's +, from a chat: the drawer closes and the project's inbox shows with its box ready to
    /// type into (the keyboard up). Nothing starts until Send, so the job's count of sessions started holds. (By name
    /// after Needs you.)
    func testNewSessionFromTheDrawer() throws {
        try launchPaired()
        try openSession("demo-chat", in: "blimp-demo")
        try wait(message("message.user", "Add a dark mode toggle to settings"), "demo-chat's chat")
        let started = hostFile("claude.args")
        try openDrawer()
        let new = element("drawerNewSession")
        try wait(new, "New session in the drawer")
        shot("36a-drawer-new-session")
        new.tap()
        try until(element("drawerStrip"), "exists == false", "the drawer to close on New session")
        try until(element("screenTitle"), "label BEGINSWITH 'Inbox'", "the inbox from New session")
        try until(element("messageField"), "hasKeyboardFocus == true", "the inbox's box to take the keyboard")
        shot("36b-new-session-box")
        if hostFile("claude.args") != started { throw failed("nothing started by New session") }
    }

    // MARK: - The server browser

    /// blimp-demo's browser tab (setup.ts opens it on a page of its own): the drawer lists it by its title; it opens
    /// full screen with the live page, laid out for the phone (a point here is a pixel there). A tap on the page's
    /// button reaches it; a tap on its field brings the keyboard up by itself, and what's typed reaches the page.
    /// × goes back, and the drawer's row has the title the page set from both. (By name after New session.)
    func testServerBrowserTab() throws {
        try launchPaired()
        try pickProject("blimp-demo")
        try openDrawer()
        let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'tab-'")).firstMatch
        try wait(row, "the browser tab in the drawer")
        try until(row, "label CONTAINS 'e2e page'", "the tab's title in the drawer")
        shot("38a-drawer-browser")
        row.tap()
        let page = element("browserPage")
        try wait(page, "the browser page")
        try until(page, "value == 'drawn'", "a frame of the page", timeout: 60)
        shot("38b-browser")
        let origin = page.coordinate(withNormalizedOffset: .zero)
        origin.withOffset(CGVector(dx: 150, dy: 75)).tap()
        origin.withOffset(CGVector(dx: 150, dy: 225)).tap()
        try wait(app.keyboards.firstMatch, "the keyboard for the page's field")
        page.typeText("hi")
        shot("38c-browser-typed")
        element("browserClose").tap()
        try until(page, "exists == false", "the chat after ×")
        try openDrawer()
        try until(row, "label CONTAINS 'tapped typed:hi'", "the tap and the typing to reach the page")
    }

    // MARK: - A start that's stuck

    /// demo-stuck is Claude Code that never says which conversation it is and shows no question blimpd reads (as
    /// when it waits on signing in): a spinner, then after 20 s a line that says to open it on the Mac, and no box.
    func testStuckStart() throws {
        try launchPaired()
        try openSession("demo-stuck", in: "api-server")
        try wait(labeled("Claude hasn't started"), "the note that Claude hasn't started", timeout: 40)
        if element("messageField").exists { throw failed("no message box while Claude hasn't started") }
        shot("40-stuck-start")
    }

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

    /// + at the foot of the drawer's column: the folder browser opens at home, and goes through to the job's work
    /// folder. New Folder makes a folder and goes into it, and Open shows it as a project, first in the column.
    /// Hidden, it comes back when opened again.
    func testOpenFolder() throws {
        try launchPaired()
        let steps = hostFile("work-under-home").split(separator: "/").map(String.init)
        if steps.isEmpty || steps.first == ".." { throw failed("setup.ts to write the work folder's path under home") }
        let name = "opened-\(Int(Date().timeIntervalSince1970))"

        try openDrawer()
        try browse(to: steps)
        let newFolder = element("folderBrowserNewFolder")
        try wait(newFolder, "New Folder")
        newFolder.tap()
        let field = app.alerts.textFields.firstMatch
        try wait(field, "the new folder's name")
        try type(name, into: field)
        app.alerts.buttons["Make"].tap()
        try wait(element("folderBrowserEmpty"), "the browser in the new folder")
        shot("40-folder-browser")
        element("folderBrowserOpen").tap()
        try until(element("folderBrowserOpen"), "exists == false", "the browser to close on Open")
        try until(element("drawerProject"), "label == '\(name)'", "the drawer to show \(name)")
        try wait(element("strip-" + name), "\(name) in the column")
        shot("41-opened-folder")

        // Hide it, then open it again from the browser: it's back.
        element("strip-" + name).press(forDuration: 1.2)
        let hide = app.buttons["Hide \(name)"]
        try wait(hide, "Hide in the icon's menu")
        hide.tap()
        try until(element("strip-" + name), "exists == false", "\(name) to leave the column")
        try browse(to: steps + [name])
        element("folderBrowserOpen").tap()
        try wait(element("strip-" + name), "\(name) back in the column")
    }

    // MARK: - Notifications

    /// Notifications on: iOS asks once (Allow), and the phone signs up with blimpd, whose push.json then lists a
    /// development phone (no push key here, so blimpd sends nothing itself). With the app in the background (after Home, the test waits until it has left the front), a
    /// notification for demo-chat (signals.sh pushes it to the simulator, as Apple would) opens its chat when tapped: the banner, or the notification in Notification Center if the banner is gone.
    /// (In shard b, after the tests that read demo-chat; it changes nothing later tests see: they launch with notifications off.)
    func testPushOpensTheChat() throws {
        try launchPaired(push: true)
        allowNotifications()
        let end = Date().addingTimeInterval(30)
        while !hostFile("b/push.json").contains("\"development\"") {
            if Date() > end { throw failed("the phone to sign up for notifications (b/push.json: \(hostFile("b/push.json")))") }
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCUIDevice.shared.press(.home)
        // A push while blimp is still in front (on its way out) shows nothing, by design (Push.swift willPresent):
        // wait until it's in the background.
        let gone = Date().addingTimeInterval(10)
        while app.state == .runningForeground && Date() < gone { Thread.sleep(forTimeInterval: 0.2) }
        Thread.sleep(forTimeInterval: 1)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        try signal("push-demo-chat")
        Thread.sleep(forTimeInterval: 2)
        screen("41-push-sent")
        print("SPRINGBOARD after the push:\n" + springboard.debugDescription)
        let byLabel = NSPredicate(format: "label CONTAINS %@", "is waiting")
        var note = springboard.descendants(matching: .any).matching(byLabel).firstMatch
        if !note.waitForExistence(timeout: 8) {
            // The banner is gone or out of the test's reach, and Notification Center lists it too: pull it down
            // from the very top of the screen.
            let top = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.005))
            top.press(forDuration: 0.1, thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.6)))
            screen("41-notification-center")
            print("SPRINGBOARD in Notification Center:\n" + springboard.debugDescription)
            note = springboard.descendants(matching: .any).matching(byLabel).firstMatch
            try wait(note, "the notification in Notification Center", timeout: 10)
        }
        note.tap()
        try wait(message("message.user", "Add a dark mode toggle to settings"), "demo-chat's chat from the notification", timeout: 30)
        shot("42-push-opened")
    }

    // MARK: - Helpers

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
            // In a chat there's no ☰: a swipe right opens the drawer. It starts high (dy 0.3), above the keyboard
            // and the reply chips, which scroll sideways and would take the swipe.
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.3))
                .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.3)))
        }
        try wait(strip, "the drawer")
    }

    /// A tap beside the open drawer closes it.
    private func closeDrawer() throws {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        try until(element("drawerStrip"), "exists == false", "the drawer to close")
    }

    /// Opens the folder browser from the open drawer's + and goes into each folder of `steps`, from home.
    private func browse(to steps: [String]) throws {
        let plus = element("drawerOpenFolder")
        try wait(plus, "+ at the foot of the drawer's column")
        plus.tap()
        for step in steps {
            let row = element("folder-" + step)
            // The list is lazy: a row below the screen isn't there until it's scrolled to. A slow drag that holds
            // before lifting doesn't fling, so no row goes past unseen between the checks.
            if !row.waitForExistence(timeout: 5) {
                let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
                let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35))
                for _ in 0..<30 where !row.exists {
                    from.press(forDuration: 0.05, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.2)
                }
            }
            try wait(row, "\(step) in the folder browser", timeout: 10)
            row.tap()
        }
    }

    /// Unfolds Earlier in the open drawer (folded at first, and kept as it was left).
    private func showEarlier() throws {
        let earlier = element("drawerEarlier")
        try wait(earlier, "Earlier in the drawer")
        if earlier.label.contains("folded") { earlier.tap() }
        try until(earlier, "label CONTAINS 'open'", "Earlier to unfold")
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

    /// The app, with its animations off (BlimpApp: `noAnimations`): each tap settles without waiting out a transition.
    /// Notifications off (Push: `pushOff`), so iOS's question never covers a test's screen, unless `push`.
    private func launchable(push: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["-noAnimations", "YES"]
        if !push { app.launchArguments += ["-pushOff", "YES"] }
        return app
    }

    /// Launches the app and waits for Home, pairing first if it isn't (test1 failed before pairing).
    private func launchPaired(arguments: [String] = [], push: Bool = false) throws {
        continueAfterFailure = false
        app = launchable(push: push)
        app.launchArguments += arguments
        app.launch()
        let home = homeButton()
        let field = element("pairField")
        let unlock = app.buttons["Unlock"].firstMatch
        let end = Date().addingTimeInterval(30)
        while Date() < end, !home.exists, !field.exists, !unlock.exists { _ = home.waitForExistence(timeout: 1) }
        if field.exists {
            field.tap()
            field.typeText(try pairLink())
            app.buttons["connectButton"].tap()
        } else if unlock.exists || !home.exists {
            // Home lives on under the lock cover, so the lock is what says whether to unlock
            try unlockWithFace()
        }
        try wait(home, "Home")
    }

    /// Locked: a matching face (signals.sh), again if the first came before Face ID was looking. Unlocked
    /// means the cover went: Home is there under it all along.
    private func unlockWithFace() throws {
        let home = homeButton()
        let unlock = app.buttons["Unlock"].firstMatch
        for _ in 0..<3 {
            allowFaceID()
            try signal("faceid-match")
            if unlock.waitForNonExistence(timeout: 10), home.waitForExistence(timeout: 5) {
                Self.faceIDAllowed = true
                return
            }
            screen("still-locked")
            // the ask ended (or never started): Unlock asks again
            if unlock.exists && unlock.isHittable { unlock.tap() }
        }
        try until(unlock, "exists == false", "the lock to go after Face ID")
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

    /// iOS asks once whether blimp may send notifications.
    private func allowNotifications() {
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.buttons["Allow"]
        if allow.waitForExistence(timeout: 8) {
            screen("push-permission")
            allow.tap()
        }
    }

    /// The first Face ID use asks "Do you want to allow blimp to use Face ID?", once: after it's answered, or
    /// Face ID unlocked without it, it isn't looked for again (4 looks of 2 s each, on every unlock).
    private static var faceIDAllowed = false
    private func allowFaceID() {
        if Self.faceIDAllowed { return }
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for owner in [springboard, app!] {
            for label in ["OK", "Allow"] {
                let b = owner.alerts.buttons[label]
                if b.waitForExistence(timeout: 2) {
                    screen("faceid-permission")
                    b.tap()
                    Self.faceIDAllowed = true
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

    /// Home's top-left button: ☰ on a project's inbox, ‹ in a chat (a launch can reopen the last chat).
    private func homeButton() -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier IN %@", ["drawerButton", "inboxBack"])).firstMatch
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
            // Near the trailing end, past the words, as a person taps to carry on typing, so the caret goes
            // after them. A plain tap() lands on the field's activation point, 5 pt in from its leading edge,
            // which puts the caret in front of any text (run 39701047535: 12 deletes in front of "continue").
            field.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
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
