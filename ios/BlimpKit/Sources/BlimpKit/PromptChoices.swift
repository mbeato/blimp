// How the phone shows what Claude asks so that a tap is never a surprise: the buttons wait until blimpd has read
// the real options, "don't ask again" is a small link of its own, a plan to approve and a deny with a reason are
// told apart, and an inbox row answers only what fits in a row (the rest opens the chat). Times are ms.
import Foundation

public enum PromptReady {
    /// blimpd reads a permission's real options off Claude's screen for 2 s after the hook (sessions.ts); until
    /// then the prompt has the hook's Yes and No, and a tap on one could mean another choice.
    public static let settle: Double = 2500

    /// The hook's stand-in options, before Claude's screen was read.
    public static func fallback(_ p: Prompt) -> Bool { p.kind == .permission && p.options == ["Yes", "No"] }

    /// How long to wait, from now, before the buttons show (the prompt seen now): none once the real options
    /// are in or blimpd has stopped looking, and never more than `settle` (the phone's clock may be behind).
    public static func wait(_ p: Prompt, now: Double) -> Double {
        guard fallback(p) else { return 0 }
        return min(settle, max(0, p.at + settle - now))
    }
}

public enum PromptChoices {
    /// "Yes, and don't ask again for git push commands": a small link, so a tap meant for Yes never lands on it.
    public static func isLink(_ label: String) -> Bool {
        let l = label.lowercased().replacingOccurrences(of: "\u{2019}", with: "'")
        return l.contains("don't ask again")
    }

    /// The choices as buttons and as small links, each by its index in `p.choices`.
    public static func split(_ p: Prompt) -> (buttons: [Int], links: [Int]) {
        let all = Array(p.choices.indices)
        return (all.filter { !isLink(p.choices[$0]) }, all.filter { isLink(p.choices[$0]) })
    }

    /// A plan to approve (ExitPlanMode): its text shows, and "tell Claude what to change" is a deny with a reason.
    public static func isPlan(_ p: Prompt) -> Bool { p.kind == .permission && p.tool == "ExitPlanMode" }

    /// "No, and tell Claude why" fits: Esc declines it, then the reason is typed (a permission or a plan).
    public static func deniable(_ p: Prompt) -> Bool { p.kind == .permission && p.answerable }

    /// blimpd's refusal of an answer, in the words to show.
    public static func failure(_ message: String) -> String {
        switch message {
        case "the question changed": "The question changed. Open it to answer."
        case "the session ended": "That session ended."
        default: message.hasPrefix("stopped:") ? "Stopped part way. Open it to answer again." : "Not sent: \(message)"
        }
    }
}

/// What a Needs you row offers for a prompt.
public enum RowAnswer: Equatable, Sendable {
    /// Allow picks the choice at `allow`; Deny the one at `deny`, or Esc on the prompt when it has no "No".
    case allowDeny(allow: Int, deny: Int?)
    /// One single-choice question: a chip per option.
    case chips([String])
    /// Answered in the chat only, with this button: "Review plan", "Answer (3)", "Answer".
    case open(String)
    /// Nothing the phone can answer (or nothing asked): the row opens the chat.
    case none

    public static func of(_ p: Prompt?) -> RowAnswer {
        guard let p, p.answerable else { return .none }
        switch p.kind {
        case .permission:
            if PromptChoices.isPlan(p) { return .open("Review plan") }
            if p.choices.isEmpty { return .open("Answer") }
            return .allowDeny(allow: 0, deny: p.choices.indices.last { p.choices[$0].hasPrefix("No") })
        case .question:
            if p.singleChoice { return .chips(p.choices) }
            let n = p.questions?.count ?? 0
            return .open(n > 1 ? "Answer (\(n))" : "Answer")
        case .trust:
            return .open("Answer")
        case .other:
            return .none
        }
    }
}
