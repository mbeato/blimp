import Foundation
import Testing
@testable import BlimpKit

private func said(_ id: String, at: Double, _ role: ChatRole = .assistant, text: String? = "t") -> ChatMessage {
    ChatMessage(id: id, at: at, role: role, text: text, name: nil, summary: nil, input: nil, output: nil, error: nil)
}

private func sessions() throws -> [Session] {
    guard case .sessions(let list) = EventsMessage.decode(Data(sessions03.utf8)) else { throw NoSessions() }
    return list
}
private struct NoSessions: Error {}

// MARK: - The newest reply

@Test func claudesNewestReplyIsTheLastOneWithTextWhateverCameAfterIt() {
    let shown = [said("u1", at: 1, .user), said("a1", at: 2), said("a2", at: 3), said("u2", at: 4, .user), said("x", at: 5, .compacted, text: nil)]
    #expect(ChatFold.newest(shown) == "a2")
    #expect(ChatFold.newest([said("a1", at: 1), said("a2", at: 2, text: "")]) == "a1")
    #expect(ChatFold.newest([said("u1", at: 1, .user)]) == nil)
}

// MARK: - Since you left

@Test func theSinceYouLeftLineGoesAboveTheFirstMessageNewerThanTheLastVisit() {
    let shown = [said("u1", at: 10, .user), said("a1", at: 20), said("u2", at: 30, .user), said("a2", at: 40)]
    #expect(SinceYouLeft.first(shown, lastShown: 25, unread: true) == "u2")
    #expect(SinceYouLeft.first(shown, lastShown: 35, unread: true) == "a2")
}

@Test func noSinceYouLeftLineWhenItsBeenSeenNeverOpenedHereNothingNewOrAllOfItIsNew() {
    let shown = [said("u1", at: 10, .user), said("a1", at: 20), said("u2", at: 30, .user), said("a2", at: 40)]
    // Read on the Mac since: nothing is unread.
    #expect(SinceYouLeft.first(shown, lastShown: 25, unread: false) == nil)
    // Never on screen on this phone.
    #expect(SinceYouLeft.first(shown, lastShown: nil, unread: true) == nil)
    #expect(SinceYouLeft.first(shown, lastShown: 40, unread: true) == nil)
    // The whole chat is new: a line above all of it says nothing.
    #expect(SinceYouLeft.first(shown, lastShown: 5, unread: true) == nil)
    // Only your own messages are new (typed on the Mac): no reply to read.
    #expect(SinceYouLeft.first(shown + [said("u3", at: 50, .user)], lastShown: 45, unread: true) == nil)
}

// MARK: - Next waiting

@Test func nextWaitingIsTheOtherSessionNeedsYouListsFirstAcrossFolders() {
    var asked = session("asked", dir: "/c", created: 0, state: .done, since: 200)
    asked.note = Note(status: .question, text: "Which one?", at: 200)
    var finished = session("finished", dir: "/a", created: 0, state: .done, since: 400, unread: true)
    finished.note = Note(status: .done, text: "Done.", at: 400)
    let list = [
        session("here", dir: "/a", created: 0, state: .waiting, since: 500),
        session("old", dir: "/b", created: 0, state: .waiting, since: 100),
        session("new", dir: "/a", created: 0, state: .waiting, since: 300),
        asked,
        // Done and unread is the inbox's Done, not Waiting on you; working isn't listed.
        finished,
        session("busy", dir: "/a", created: 0, state: .working, since: 600),
        // Waiting, but no Claude in it to answer.
        session("shell", dir: "/a", created: 0, state: .waiting, since: 700, id: nil),
    ]
    // The oldest wait first, as Needs you sorts every project's waits.
    let next = NextWaiting.after("here", in: list)
    #expect(next?.session.name == "old")
    #expect(next?.count == 3)
    #expect(next?.words == "Next: old is waiting (3 left)")
    // Done with a question for you counts, as in the inbox.
    #expect(NextWaiting.after("old", in: list)?.session.name == "asked")
    #expect(NextWaiting.after("x", in: [asked])?.session.name == "asked")
    // The chip opens the session Needs you lists first.
    #expect(NextWaiting.after("here", in: list)?.session.name == Inbox.needsYou(sessions: list, dir: nil, earlier: []).first { $0.session?.name != "here" }?.session?.name)
    // Two that started waiting at once: the list's order.
    let tie = [session("b", dir: "/a", created: 0, state: .waiting, since: 5), session("a", dir: "/a", created: 0, state: .waiting, since: 5)]
    #expect(NextWaiting.after("x", in: tie)?.session.name == "b")
}

@Test func withOneOtherWaitingTheChipNamesItAloneAndWithNoneThereIsNoChip() {
    let one = [session("here", dir: "/a", created: 1, state: .done), session("other", dir: "/a", created: 1, state: .waiting, since: 5)]
    #expect(NextWaiting.after("here", in: one)?.words == "Next: other is waiting")
    #expect(NextWaiting.after("other", in: one) == nil)
}

@Test func aFolderTrustQuestionCountsAsWaitingThoughClaudeHasNoConversationYet() throws {
    let prompt = try JSONDecoder().decode(Prompt.self, from: Data(#"{"kind":"trust","at":1,"answerable":true,"options":["Yes","No"]}"#.utf8))
    let trust = Session(name: "new", created: 1, dir: "/a", kind: "claude", label: nil, sessionId: nil, title: "new", updatedAt: nil,
                        state: .waiting, stateSince: 2, prompt: prompt)
    #expect(NextWaiting.after("here", in: [trust])?.session.name == "new")
}

// MARK: - Run

@Test func onlyClaudesLatestReplyOffersBlimpdsCommands() throws {
    let list = try sessions()
    let web1 = try #require(list.first { $0.name == "web-1" })
    let at = try #require(web1.runnableAt)
    #expect(RunStatus.offers(said("a", at: at), in: web1) == ["npm run e2e", "bun test ./test"])
    #expect(RunStatus.offers(said("b", at: at + 5000), in: web1) == ["npm run e2e", "bun test ./test"])
    // An older reply, your message, no session, a session with nothing to run.
    #expect(RunStatus.offers(said("c", at: at - 1), in: web1) == nil)
    #expect(RunStatus.offers(said("d", at: at, .user), in: web1) == nil)
    #expect(RunStatus.offers(said("e", at: at), in: nil) == nil)
    let web2 = try #require(list.first { $0.name == "web-2" })
    #expect(RunStatus.offers(said("f", at: at), in: web2) == nil)
}

@Test func aCommandsRunGoesFromRunToStartingRunningEndedAndSent() throws {
    let list = try sessions()
    let web1 = try #require(list.first { $0.name == "web-1" })
    // Not run yet; being started; running (no exit yet); ended with exit 1; its result being sent; sent.
    #expect(RunStatus.of("npm run e2e", for: web1, in: list) == .ready)
    #expect(RunStatus.of("npm run e2e", for: web1, in: list, starting: ["npm run e2e"]) == .starting)
    #expect(RunStatus.of("bun test ./test", for: web1, in: list) == .ended("web-run", exit: 1))
    #expect(RunStatus.of("bun test ./test", for: web1, in: list, sending: ["web-run"]) == .sending("web-run"))
    #expect(RunStatus.of("bun test ./test", for: web1, in: list, sending: ["web-run"], sent: ["web-run"]) == .sent("web-run"))
    let running = list.map { s -> Session in
        var s = s
        if s.name == "web-run" { s.run?.exit = nil; s.run?.endedAt = nil }
        return s
    }
    #expect(RunStatus.of("bun test ./test", for: web1, in: running) == .running("web-run"))
}

@Test func whatARunSaysUnderItsCommand() {
    #expect(RunStatus.ready.words == nil)
    #expect(RunStatus.starting.words == "Starting…")
    #expect(RunStatus.running("r").words == "Running…")
    #expect(RunStatus.ended("r", exit: 0).words == "Finished · exit 0")
    #expect(RunStatus.ended("r", exit: 2).words == "Failed · exit 2")
    #expect(RunStatus.sending("r").words == "Sending…")
    #expect(RunStatus.sent("r").words == "Result sent to Claude")
    #expect(RunStatus.ended("r", exit: 0).canSend && !RunStatus.running("r").canSend && !RunStatus.sent("r").canSend)
}

// MARK: - Secrets and recaps

@Test func aKeyThatLostItsLineBreaksIsRefusedAndOneThatKeptThemOrAnyOtherValueIsNot() {
    #expect(SecretText.lostLineBreaks("-----BEGIN OPENSSH PRIVATE KEY----- b3BlbnNzaC1rZXk -----END OPENSSH PRIVATE KEY-----"))
    #expect(!SecretText.lostLineBreaks("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\n"))
    #expect(!SecretText.lostLineBreaks("-----BEGIN RSA PRIVATE KEY-----\r\nMIIE\r\n-----END RSA PRIVATE KEY-----"))
    #expect(!SecretText.lostLineBreaks("sk-proj-abc123"))
}

@Test func anOlderBlimpdsNotFoundSaysToUpdateItForSecretsAndRecaps() {
    #expect(SecretText.notSaved("not found") == "This server's blimpd is too old for secrets. Update it first.")
    #expect(SecretText.notSaved("a secret is 1 to 16384 characters") == "Not saved: a secret is 1 to 16384 characters")
    #expect(RecapText.failure("not found") == "This server's blimpd is too old for recaps. Update it first.")
    #expect(RecapText.failure("no session named web-1") == "no session named web-1")
    #expect(RecapText.failure("Recaps are off") == "Recaps are off")
}
