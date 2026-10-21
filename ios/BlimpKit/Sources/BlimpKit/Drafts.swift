// What you were writing, kept: the box's text per chat (it survives switching chats, the lock and a cold
// launch), how dictated words join what's typed, what the box keeps once blimpd took a message, and the
// chat a cold launch reopens. Times are milliseconds since 1970, as blimpd's are.
import Foundation

public enum DraftText {
    /// Words heard go after what's in the box, with one space between.
    public static func joined(_ base: String, _ heard: String) -> String {
        guard let last = base.last, !heard.isEmpty else { return base + heard }
        return last.isWhitespace ? base + heard : base + " " + heard
    }

    /// The box once blimpd took `sent`: that text goes, anything typed after it stays. A box changed in
    /// other ways while it sent is left alone, so nothing is cut or glued to the next message.
    public static func afterSend(_ draft: String, sent: String) -> String {
        draft.hasPrefix(sent) ? String(draft.dropFirst(sent.count)) : draft
    }
}

public struct Drafts: Codable, Equatable, Sendable {
    public struct Entry: Codable, Equatable, Sendable {
        public var text: String
        public var at: Double
    }

    public private(set) var entries: [String: Entry] = [:]

    static let keepFor: Double = 30 * 86_400_000
    static let most = 50

    public init() {}

    public func text(for key: String) -> String { entries[key]?.text ?? "" }

    /// A box with only spaces in it has no draft.
    public mutating func set(_ text: String, for key: String, now: Double) {
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            entries[key] = nil
        } else {
            entries[key] = Entry(text: text, at: now)
        }
    }

    /// Without drafts older than a month, and only the newest `most`.
    public func pruned(now: Double) -> Drafts {
        var out = Drafts()
        let fresh = entries.filter { now - $0.value.at <= Self.keepFor }.sorted { $0.value.at > $1.value.at }.prefix(Self.most)
        for (key, entry) in fresh { out.entries[key] = entry }
        return out
    }
}

/// The chat that was open, and when it was last used.
public struct LastChat: Codable, Equatable, Sendable {
    public let name: String
    public let at: Double

    public static let within: Double = 3_600_000

    public init(name: String, at: Double) {
        self.name = name
        self.at = at
    }

    /// The chat a cold launch opens: this one if it was used in the last hour and still runs.
    public func reopen(listed: [String], now: Double) -> String? {
        now - at <= Self.within && listed.contains(name) ? name : nil
    }
}
