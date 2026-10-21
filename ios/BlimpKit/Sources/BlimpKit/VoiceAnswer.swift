import Foundation

public enum AnswerMatch: Equatable, Sendable {
    case clear(Int), guess(Int), none

    /// A risky command (push, deploy, delete) is never answered by voice alone: a clear match only marks
    /// the choice, which then waits for a tap like a guess.
    public func needingTap(risky: Bool) -> AnswerMatch {
        if risky, case .clear(let i) = self { return .guess(i) }
        return self
    }
}

/// Works out which button a spoken answer means. It never picks silently when unsure:
/// `.guess` waits for a tap, `.none` asks again.
public enum VoiceAnswer {
    public static func match(_ heard: String, choices: [String]) -> AnswerMatch {
        let h = words(heard)
        guard !h.isEmpty, !choices.isEmpty else { return .none }
        let c = choices.map(words)

        if let n = number(h) { return n >= 1 && n <= choices.count ? .clear(n - 1) : .none }

        if let i = c.firstIndex(of: h) { return .clear(i) }
        if h.count >= 2 {
            let prefixed = c.indices.filter { c[$0].count >= h.count && Array(c[$0].prefix(h.count)) == h }
            if prefixed.count >= 2 { return .none }
            if let i = prefixed.first { return .clear(i) }
        }
        let contained = c.indices.filter { !c[$0].isEmpty && contains(h, c[$0]) }
        if contained.count == 1 {
            let i = contained[0]
            if isSure(h, label: c[i]) { return .clear(i) }
            // "not red": the person said no to it, so highlight nothing.
            if let at = start(of: c[i], in: h), at > 0, negators.contains(h[at - 1]) { return .none }
            return .guess(i)
        }

        // A bare yes or no phrase (only politeness words may surround it).
        let core = h.filter { !polite.contains($0) }.joined(separator: " ")
        if yes.contains(core) {
            if let i = c.firstIndex(where: { $0.first == "yes" }) { return .clear(i) }
            return .none
        }
        if no.contains(core) {
            if let i = c.lastIndex(where: { $0.first == "no" }) { return .clear(i) }
            return .none
        }

        let heardSet = Set(h)
        let shares: [Double] = c.map { label in
            let real = label.filter { !stop.contains($0) }
            guard !real.isEmpty else { return 0 }
            return Double(real.filter { heardSet.contains($0) }.count) / Double(real.count)
        }
        let order = shares.indices.sorted { shares[$0] > shares[$1] }
        let best = order[0]
        let second = order.count > 1 ? shares[order[1]] : -1
        return shares[best] >= 0.6 && shares[best] > second ? .guess(best) : .none
    }

    // `.clear` is sent with no tap, so it needs more than a label match: every heard word must belong to
    // the label or be a small filler word, and nothing may negate or hedge ("not yes", "yes but wait",
    // "go ahead no"). Anything less sure is only a guess, which waits for a tap.
    private static let filler: Set<String> = ["please", "thanks", "thank", "you", "i", "think", "option", "the", "a",
                                              "ok", "okay", "sure", "go", "ahead"]
    private static let polite: Set<String> = ["please", "thanks", "thank", "you", "i", "think"]
    private static let hedges: Set<String> = ["not", "no", "nope", "dont", "never", "but", "except", "wait", "neither",
                                              "both", "nor", "instead", "actually"]
    private static let yesWords: Set<String> = ["yes", "yeah", "yep", "sure", "ok", "okay", "allow", "ahead"]
    private static let noWords: Set<String> = ["no", "nope", "dont", "deny", "stop", "cancel"]

    private static let negators: Set<String> = ["not", "never", "but", "except", "nope", "dont"]

    private static func start(of needle: [String], in hay: [String]) -> Int? {
        guard hay.count >= needle.count else { return nil }
        return (0...(hay.count - needle.count)).first { Array(hay[$0..<($0 + needle.count)]) == needle }
    }

    private static func isSure(_ h: [String], label: [String]) -> Bool {
        let own = Set(label)
        if !h.allSatisfy({ own.contains($0) || filler.contains($0) }) { return false }
        // "no" only counts as a negation when it isn't the word being matched.
        if h.contains(where: { hedges.contains($0) && !own.contains($0) }) { return false }
        return !(h.contains(where: yesWords.contains) && h.contains(where: noWords.contains))
    }

    private static let yes: Set<String> = ["yes", "yeah", "yep", "sure", "ok", "okay", "allow", "do it", "go ahead"]
    private static let no: Set<String> = ["no", "nope", "dont", "deny", "stop", "cancel"]
    private static let stop: Set<String> = ["the", "a", "an", "and", "for", "to", "of", "in"]
    private static let cardinals = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]
    private static let ordinals = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth"]

    static func words(_ s: String) -> [String] {
        var t = s.lowercased().replacingOccurrences(of: "'", with: "").replacingOccurrences(of: "\u{2019}", with: "")
        t = String(t.map { $0.isLetter || $0.isNumber ? $0 : " " })
        return t.split(separator: " ").map(String.init)
    }

    // "two", "option 3", "the second one": a lone number word or digit, with optional filler around it.
    private static func number(_ h: [String]) -> Int? {
        var w = ArraySlice(h)
        var lead: [String] = []
        while let f = w.first, ["option", "number", "the"].contains(f) { lead.append(f); w = w.dropFirst() }
        // "the second one" is a number; "two one" and "the one" are not.
        if w.count == 2, w.last == "one", lead.contains("the"), ordinals.contains(w.first!) { w = w.dropLast() }
        guard w.count == 1, let t = w.first else { return nil }
        if t == "one" && lead == ["the"] { return nil }
        if let d = Int(t), (1...9).contains(d), t.count == 1 { return d }
        if let i = cardinals.firstIndex(of: t) { return i + 1 }
        if let i = ordinals.firstIndex(of: t) { return i + 1 }
        return nil
    }

    private static func contains(_ hay: [String], _ needle: [String]) -> Bool {
        guard hay.count >= needle.count else { return false }
        return (0...(hay.count - needle.count)).contains { Array(hay[$0..<($0 + needle.count)]) == needle }
    }
}
