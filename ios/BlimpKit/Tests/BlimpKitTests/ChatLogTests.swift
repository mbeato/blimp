import Testing
@testable import BlimpKit

func msg(_ id: String, _ role: ChatRole = .user, text: String? = "t", output: String? = nil) -> ChatMessage {
    ChatMessage(id: id, at: 0, role: role, text: text, name: nil, summary: nil, input: nil, output: output, error: nil)
}

@Test func historyReplacesAppendMergesResetEmpties() {
    var log = ChatLog()
    log.apply(.history([msg("1"), msg("2", .tool, text: nil)]))
    log.apply(.append([msg("2", .tool, text: nil, output: "ok"), msg("3")]))
    #expect(log.messages.map(\.id) == ["1", "2", "3"])
    #expect(log.messages[1].output == "ok")
    log.apply(.reset)
    #expect(log.messages.isEmpty)
    log.apply(.unreadable)
    #expect(!log.readable)
    log.apply(.history([]))
    #expect(log.readable)
    log.apply(.ack(id: "x"))
    #expect(log.messages.isEmpty)
}

@Test func shownLeavesOutToolStepsAndLatestStepIsTheNewestSinceYourMessage() {
    var log = ChatLog()
    log.apply(.history([msg("1"), msg("2", .tool, text: nil), msg("3", .assistant)]))
    #expect(log.shown.map(\.id) == ["1", "3"])
    #expect(log.latestStep?.id == "2")
    log.apply(.append([msg("4", .tool, text: nil), msg("5", .tool, text: nil)]))
    #expect(log.latestStep?.id == "5")
    // a new message of yours: nothing done for it yet
    log.apply(.append([msg("6")]))
    #expect(log.latestStep == nil)
    #expect(log.shown.map(\.id) == ["1", "3", "6"])
}
