// The phone's answers to a Claude question dialog while they're being picked, one question at a time
// like Claude's own: a single-choice pick moves on, multi-choice ticks wait for Next, a typed answer can
// stand in for the options, and several questions end on a review before anything is sent. Nothing
// reaches Claude until `command` is sent, all at once (blimpd types it step by step).
import Foundation

public struct QuestionDraft: Sendable, Equatable {
    public let questions: [Question]
    /// The question showing; `questions.count` once every one is answered (the review, or sending).
    public private(set) var step = 0
    /// Per question: the options picked (one for single-choice), in the order they were picked.
    public private(set) var picks: [[Int]]
    /// Per question: the typed answer, "" for none.
    public private(set) var texts: [String]

    public init(questions: [Question]) {
        self.questions = questions
        picks = questions.map { _ in [] }
        texts = questions.map { _ in "" }
    }

    public var current: Question? { questions.indices.contains(step) ? questions[step] : nil }
    /// Every question answered. With more than one question the review shows; with one, it's sent.
    public var done: Bool { step >= questions.count }
    public var reviews: Bool { questions.count > 1 }
    /// "2 of 3", only when there's more than one.
    public var position: String? { reviews && !done ? "\(step + 1) of \(questions.count)" : nil }

    public func isPicked(_ option: Int) -> Bool { picks.indices.contains(step) && picks[step].contains(option) }
    public func isAnswered(_ q: Int) -> Bool {
        questions.indices.contains(q) && (!picks[q].isEmpty || !Self.clean(texts[q]).isEmpty)
    }

    /// Single-choice: picks it and moves on. Multi-choice: ticks or unticks it.
    public mutating func pick(_ option: Int) {
        guard let q = current, q.options.indices.contains(option) else { return }
        if q.multiSelect {
            if let i = picks[step].firstIndex(of: option) { picks[step].remove(at: i) } else { picks[step].append(option) }
        } else {
            picks[step] = [option]
            texts[step] = ""
            step += 1
        }
    }

    /// A typed answer. Single-choice: it replaces the pick and moves on. Multi-choice: it goes with the ticks.
    public mutating func type(_ text: String) {
        guard let q = current else { return }
        texts[step] = text
        if !q.multiSelect, !Self.clean(text).isEmpty {
            picks[step] = []
            step += 1
        }
    }

    /// Multi-choice Next (or a typed single-choice answer kept): on, once the question has an answer.
    public mutating func next() {
        guard !done, isAnswered(step) else { return }
        step += 1
    }

    public mutating func back() {
        if step > 0 { step -= 1 }
    }

    /// Back to one question from the review.
    public mutating func edit(_ q: Int) {
        if questions.indices.contains(q) { step = q }
    }

    /// What the review shows for question q: its picks' labels, then the typed answer.
    public func answer(_ q: Int) -> String {
        guard questions.indices.contains(q) else { return "" }
        let labels = picks[q].map { questions[q].options[$0].label }
        let typed = Self.clean(texts[q])
        return (labels + (typed.isEmpty ? [] : [typed])).joined(separator: ", ")
    }

    /// The answer for blimpd, once every question has one.
    public func command(id: String, at: Double) -> ChatCommand? {
        guard done, questions.indices.allSatisfy(isAnswered) else { return nil }
        let answers = questions.indices.map { q in
            QuestionAnswer(picks: picks[q], text: Self.clean(texts[q]).isEmpty ? nil : Self.clean(texts[q]))
        }
        let labels = questions.indices.map { q in picks[q].map { questions[q].options[$0].label } }
        return .answers(id: id, at: at, answers: answers, labels: labels)
    }

    /// Claude's text row is one line: blimpd sends it so, and the review shows it so.
    static func clean(_ s: String) -> String {
        s.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
}

/// One question's answer as blimpd takes it: the options picked, and the typed answer if any.
public struct QuestionAnswer: Encodable, Sendable, Equatable {
    public let picks: [Int]
    public let text: String?

    public init(picks: [Int], text: String?) {
        self.picks = picks
        self.text = text
    }

    private enum Key: String, CodingKey { case picks, text }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        try c.encode(picks, forKey: .picks)
        try c.encodeIfPresent(text, forKey: .text)
    }
}
