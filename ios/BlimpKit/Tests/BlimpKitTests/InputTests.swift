import Foundation
import Testing
@testable import BlimpKit

private func message(_ id: String, _ role: ChatRole, _ text: String?) -> ChatMessage {
    ChatMessage(id: id, at: 0, role: role, text: text, name: nil, summary: nil, input: nil, output: nil, error: nil)
}

@Test func wordsHeardGoAfterWhatIsAlreadyInTheBoxWithOneSpace() {
    #expect(DraftText.joined("", "hello") == "hello")
    #expect(DraftText.joined("fix the", "login page") == "fix the login page")
    #expect(DraftText.joined("fix the ", "login page") == "fix the login page")
    #expect(DraftText.joined("fix the", "") == "fix the")
}

@Test func theBoxClearsOnlyTheTextBlimpdTookAndKeepsAnythingTypedSince() {
    #expect(DraftText.afterSend("run the tests", sent: "run the tests") == "")
    #expect(DraftText.afterSend("run the tests and then", sent: "run the tests") == " and then")
    // Changed while it was sending: nothing is cut, so no words are lost or glued together.
    #expect(DraftText.afterSend("get rid of this", sent: "okay then") == "get rid of this")
}

@Test func draftsAreKeptPerChatAndAnEmptyOneIsForgotten() {
    var drafts = Drafts()
    drafts.set("half a thought", for: "web-1", now: 1)
    drafts.set("other", for: "inbox:/home/u/web", now: 2)
    #expect(drafts.text(for: "web-1") == "half a thought")
    #expect(drafts.text(for: "web-2") == "")
    drafts.set("  \n", for: "web-1", now: 3)
    #expect(drafts.text(for: "web-1") == "")
    #expect(drafts.entries.count == 1)
}

@Test func draftsOlderThanAMonthAreDroppedAndOnlyTheNewestFiftyKept() {
    let day: Double = 86_400_000
    var drafts = Drafts()
    drafts.set("old", for: "a", now: 0)
    drafts.set("new", for: "b", now: 40 * day)
    #expect(drafts.pruned(now: 40 * day).entries.keys.sorted() == ["b"])
    var many = Drafts()
    for i in 0..<60 { many.set("t\(i)", for: "s\(i)", now: Double(i)) }
    let kept = many.pruned(now: 60)
    #expect(kept.entries.count == 50)
    #expect(kept.text(for: "s59") == "t59")
    #expect(kept.text(for: "s9") == "")
}

@Test func draftsSurviveBeingSavedAndReadBack() throws {
    var drafts = Drafts()
    drafts.set("line one\nline two", for: "web-1", now: 5)
    let back = try JSONDecoder().decode(Drafts.self, from: JSONEncoder().encode(drafts))
    #expect(back == drafts)
}

@Test func aColdLaunchReopensTheLastChatOnlyWithinAnHourAndWhileItStillRuns() {
    let hour: Double = 3_600_000
    let last = LastChat(name: "web-1", at: 10 * hour)
    #expect(last.reopen(listed: ["web-1", "web-2"], now: 10 * hour + 59 * 60_000) == "web-1")
    #expect(last.reopen(listed: ["web-1"], now: 11 * hour + 1) == nil)
    #expect(last.reopen(listed: ["web-2"], now: 10 * hour) == nil)
}

@Test func chipsShowOnlyWhileTheBoxIsEmptyAndNothingIsAsked() {
    let reply = [message("a1", .assistant, "Done.")]
    #expect(ReplyChips.row(after: reply, draft: "", asking: false) == ReplyChips.defaults)
    #expect(ReplyChips.row(after: reply, draft: " \n", asking: false) == ReplyChips.defaults)
    #expect(ReplyChips.row(after: reply, draft: "go on", asking: false) == [])
    #expect(ReplyChips.row(after: reply, draft: "", asking: true) == [])
}

@Test func numberChipsComeFromClaudesLastReplyOnlyWhenItIsTheNewestMessage() {
    let list = "Two ways:\n1. Fix it\n2. Revert"
    // Tool steps after the reply don't count.
    #expect(ReplyChips.row(after: [message("u1", .user, "what now"), message("a1", .assistant, list), message("t1", .tool, nil)],
                           draft: "", asking: false) == ["1", "2", "all"])
    // Your message after it: Claude is on that one now, so the usual chips.
    #expect(ReplyChips.row(after: [message("a1", .assistant, list), message("u2", .user, "1")], draft: "", asking: false) == ReplyChips.defaults)
    #expect(ReplyChips.lastReply(in: []) == nil)
}
