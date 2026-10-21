import Foundation
import Testing
@testable import BlimpKit

// What the prompt bar and a Needs you row show for a prompt, and when.

private func permission(_ options: [String], at: Double = 10_000, tool: String = "Bash") -> Prompt {
    Prompt(kind: .permission, at: at, answerable: true, tool: tool, summary: "Ran `git push`", options: options, questions: nil)
}

private func q(_ text: String, multi: Bool = false) -> Question {
    Question(question: text, header: nil, multiSelect: multi, options: [QuestionOption(label: "A", description: nil), QuestionOption(label: "B", description: nil)])
}

private func question(_ qs: [Question]) -> Prompt {
    Prompt(kind: .question, at: 1, answerable: true, tool: nil, summary: nil, options: nil, questions: qs)
}

@Test func theButtonsWaitForTheRealOptionsUntilBlimpdStopsLooking() {
    let fallback = permission(["Yes", "No"])
    #expect(PromptReady.wait(fallback, now: 10_000) == 2500)
    #expect(PromptReady.wait(fallback, now: 11_000) == 1500)
    #expect(PromptReady.wait(fallback, now: 13_000) == 0)
    // the phone's clock behind the server's: never longer than blimpd looks
    #expect(PromptReady.wait(fallback, now: 1000) == 2500)
    // the screen's options are in, or nothing to read: no wait
    #expect(PromptReady.wait(permission(["Yes", "Yes, and don't ask again for git commands", "No"]), now: 10_000) == 0)
    #expect(PromptReady.wait(question([q("Which?")]), now: 0) == 0)
}

@Test func dontAskAgainIsALinkOfItsOwn() {
    let p = permission(["Yes", "Yes, and don\u{2019}t ask again for git push commands in /w", "No"])
    #expect(PromptChoices.split(p).buttons == [0, 2])
    #expect(PromptChoices.split(p).links == [1])
    #expect(PromptChoices.isLink("Yes, and DON'T ASK AGAIN this session"))
    #expect(!PromptChoices.isLink("Yes, and use auto mode"))
}

@Test func aPlanAndAPermissionCanBeDeniedWithAReasonAQuestionCant() {
    let plan = permission(["Yes, and use auto mode", "Yes, manually approve edits", "No, keep planning"], tool: "ExitPlanMode")
    #expect(PromptChoices.isPlan(plan))
    #expect(!PromptChoices.isPlan(permission(["Yes", "No"])))
    #expect(PromptChoices.deniable(plan) && PromptChoices.deniable(permission(["Yes", "No"])))
    #expect(!PromptChoices.deniable(question([q("Which?")])))
}

@Test func aNeedsYouRowAnswersWhatFitsInARowAndOpensTheChatForTheRest() {
    #expect(RowAnswer.of(permission(["Yes", "No"])) == .allowDeny(allow: 0, deny: 1))
    #expect(RowAnswer.of(permission(["Yes", "Yes, and don't ask again", "No, and tell Claude what to do differently"])) == .allowDeny(allow: 0, deny: 2))
    #expect(RowAnswer.of(permission(["Yes", "Maybe"])) == .allowDeny(allow: 0, deny: nil))
    #expect(RowAnswer.of(permission(["Yes", "No"], tool: "ExitPlanMode")) == .open("Review plan"))
    #expect(RowAnswer.of(question([q("Which?")])) == .chips(["A", "B"]))
    #expect(RowAnswer.of(question([q("Which?"), q("And?")])) == .open("Answer (2)"))
    #expect(RowAnswer.of(question([q("Which?", multi: true)])) == .open("Answer"))
    #expect(RowAnswer.of(Prompt(kind: .trust, at: 1, answerable: true, tool: nil, summary: nil, options: ["Yes, I trust this folder", "No, exit"],
                                questions: nil)) == .open("Answer"))
    #expect(RowAnswer.of(Prompt(kind: .other, at: 1, answerable: false, tool: nil, summary: nil, options: nil, questions: nil)) == .none)
    #expect(RowAnswer.of(nil) == .none)
}

@Test func blimpdsRefusalsReadAsWhatToDo() {
    #expect(PromptChoices.failure("the question changed") == "The question changed. Open it to answer.")
    #expect(PromptChoices.failure("stopped: Claude's screen didn't show the review. Finish it on the Mac.") == "Stopped part way. Open it to answer again.")
    #expect(PromptChoices.failure("Claude is asking something. Answer it first.") == "Not sent: Claude is asking something. Answer it first.")
}
