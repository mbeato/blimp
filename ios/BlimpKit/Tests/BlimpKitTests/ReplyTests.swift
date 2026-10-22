import Foundation
import Testing
@testable import BlimpKit

@Test func withoutAReplyOrANumberedListAtItsEndTheChipsAreTheUsualAnswers() {
    #expect(ReplyChips.chips(after: nil) == ["go", "continue", "yes go ahead", "status?"])
    #expect(ReplyChips.chips(after: "Done. The tests pass.") == ReplyChips.defaults)
    // A list in the middle, with more after it, isn't choices.
    #expect(ReplyChips.chips(after: "Steps:\n1. a\n2. b\n\nI did both. Then I ran the full suite, which took a while, and everything passed on the first try, so the release branch is ready whenever you are, and nothing else is waiting on it right now.") == ReplyChips.defaults)
}

@Test func aReplyThatEndsInANumberedListGivesItsNumbersAndAll() {
    #expect(ReplyChips.chips(after: "Three ways:\n\n1. Fix it here\n2. Revert\n3. Skip the test") == ["1", "2", "3", "all"])
    // A short question after the list still leaves it the reply's end.
    #expect(ReplyChips.chips(after: "Options:\n1. Ship it\n2. Wait\n\nWhich one?") == ["1", "2", "all"])
    // Numbered from where the list starts.
    #expect(ReplyChips.chips(after: "Left:\n4. d\n5. e") == ["4", "5", "all"])
}

@Test func aOneItemOrVeryLongListIsntChoices() {
    #expect(ReplyChips.chips(after: "Next:\n1. Release") == ReplyChips.defaults)
    let ten = (1...10).map { "\($0). step" }.joined(separator: "\n")
    #expect(ReplyChips.chips(after: ten) == ReplyChips.defaults)
    let nine = (1...9).map { "\($0). step" }.joined(separator: "\n")
    #expect(ReplyChips.chips(after: nine) == (1...9).map(String.init) + ["all"])
}

@Test func theReturnCardShowsAfterAnHourAwayOrForAChatNeverShown() {
    let hour: Double = 3_600_000
    #expect(RecapCard.due(lastShown: nil, now: 10 * hour))
    #expect(RecapCard.due(lastShown: 9 * hour, now: 10 * hour))
    #expect(!RecapCard.due(lastShown: 9 * hour + 1, now: 10 * hour))
    #expect(RecapCard.autoMin == 3)
}

@Test func aSwipeLeftFromAnywherePullsTheRecapDrawerAndScrollingNever() {
    // Going left, mostly sideways: wherever it starts (it isn't asked), as the left drawer's swipe right.
    #expect(RecapCard.pulls(dx: -20, dy: 4))
    #expect(RecapCard.pulls(dx: -40, dy: 0))
    #expect(RecapCard.pulls(dx: -16, dy: -10))
    // Not going right (the left drawer's), not a scroll, not one only a little more sideways than up or down.
    #expect(!RecapCard.pulls(dx: 20, dy: 0))
    #expect(!RecapCard.pulls(dx: 0, dy: -30))
    #expect(!RecapCard.pulls(dx: -20, dy: 20))
    #expect(!RecapCard.pulls(dx: -15, dy: 10))
    // Let go past 120 points, or flung: it opens; else back closed.
    #expect(RecapCard.opens(dx: -121, predicted: -121))
    #expect(RecapCard.opens(dx: -40, predicted: -300))
    #expect(!RecapCard.opens(dx: -100, predicted: -200))
}

@Test func markingChatsShownKeepsAMonthAndSetsTheOnesOnScreenToNow() {
    let day: Double = 24 * 3_600_000
    let last = ["old": 0, "recent": 20 * day, "open": 25 * day]
    #expect(RecapCard.markShown(last, ["open", "new"], now: 31 * day) == ["recent": 20 * day, "open": 31 * day, "new": 31 * day])
}

@Test func answersEncodeAsTheAnswerRouteReadsThem() throws {
    let enc = JSONEncoder()
    enc.outputFormatting = .sortedKeys
    let s = { (a: PromptAnswer) in String(decoding: try enc.encode(AnswerRequest(id: "r1", answer: a)), as: UTF8.self) }
    #expect(try s(.pick(at: 5, pick: 1, label: "No")) == #"{"at":5,"id":"r1","label":"No","pick":1}"#)
    #expect(try s(.answers(at: 5, answers: [QuestionAnswer(picks: [0, 2], text: nil), QuestionAnswer(picks: [], text: "blue")], labels: [["A", "C"], []]))
        == #"{"answers":[{"picks":[0,2]},{"picks":[],"text":"blue"}],"at":5,"id":"r1","labels":[["A","C"],[]]}"#)
    #expect(try s(.stop(at: nil)) == #"{"id":"r1","stop":true}"#)
    #expect(try s(.stop(at: 5)) == #"{"at":5,"id":"r1","stop":true}"#)
    #expect(try s(.deny(at: 5, text: "not on main")) == #"{"at":5,"deny":true,"id":"r1","text":"not on main"}"#)
    // Each request gets its own id unless given one, so a retry of the same one is typed once.
    #expect(AnswerRequest(answer: .stop(at: nil)).id != AnswerRequest(answer: .stop(at: nil)).id)
}
