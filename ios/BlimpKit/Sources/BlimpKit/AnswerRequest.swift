// What POST /sessions/<name>/answer takes (blimpd's server.ts and answer.ts): the chat socket's answers
// without a chat open, for answering from the inbox. blimpd types it only while the prompt that waited
// since `at` is still up with the same choice under `pick`; otherwise it answers 409 with why, in words
// to show ("the question changed", "Claude is asking something. Answer it first.", …). The id makes a
// retry safe: blimpd types each id once.
import Foundation

public enum PromptAnswer: Sendable, Equatable {
    /// One choice of a permission or a single-choice question; `label` is that choice as shown.
    case pick(at: Double, pick: Int, label: String)
    /// Every question of a dialog at once; `labels` are each question's picked options as shown.
    case answers(at: Double, answers: [QuestionAnswer], labels: [[String]])
    /// Esc. With `at`, only while that prompt is still up (otherwise the Esc would stop Claude's work).
    case stop(at: Double?)
    /// No, and why: Esc, then `text` typed as a message once Claude stops asking.
    case deny(at: Double, text: String)
}

public struct AnswerRequest: Encodable, Sendable, Equatable {
    public let id: String
    public let answer: PromptAnswer

    public init(id: String = UUID().uuidString, answer: PromptAnswer) {
        self.id = id
        self.answer = answer
    }

    private enum Key: String, CodingKey { case id, at, pick, label, answers, labels, stop, deny, text }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        try c.encode(id, forKey: .id)
        switch answer {
        case let .pick(at, pick, label):
            try c.encode(at, forKey: .at); try c.encode(pick, forKey: .pick); try c.encode(label, forKey: .label)
        case let .answers(at, answers, labels):
            try c.encode(at, forKey: .at); try c.encode(answers, forKey: .answers); try c.encode(labels, forKey: .labels)
        case let .stop(at):
            try c.encode(true, forKey: .stop); try c.encodeIfPresent(at, forKey: .at)
        case let .deny(at, text):
            try c.encode(true, forKey: .deny); try c.encode(at, forKey: .at); try c.encode(text, forKey: .text)
        }
    }
}

/// A secret for a session (PUT /secrets/<NAME>): what blimpd takes, so the sheet can say so before sending.
public enum SecretRule {
    /// A letter, then letters, digits or _, at most 64 in all: OPENAI_API_KEY.
    public static func validName(_ name: String) -> Bool {
        guard let f = name.first, f.isASCII, f.isLetter, name.count <= 64 else { return false }
        return name.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_") }
    }

    /// 1 to 16384 characters, no NUL.
    public static func validValue(_ value: String) -> Bool {
        (1...16384).contains(value.utf16.count) && !value.contains("\u{0}")
    }
}
