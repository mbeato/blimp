// The phone's feed (docs/DESIGN.md, "Feed"): GET /feed's cards, the words a card and the caught-up card show, the
// threads Comments opens, the links the phone opens (http and https only), and when a card counts as seen.
import Foundation

public struct FeedSource: Codable, Sendable, Equatable {
    /// "hn", "reddit", "github" or "rss".
    public let kind: String
    /// "Hacker News", "r/programming", "GitHub", or a blog's name.
    public let name: String
    public let score: Int?
    public let comments: Int?
    /// The comments page (HN and Reddit).
    public let thread: String?
}

public struct FeedCard: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let url: String
    public let title: String
    public let sources: [FeedSource]
    /// When the run that found it started (ms).
    public let at: Double
    public let image: String?
    /// nil: two tries failed, so it shows its title only.
    public let summary: String?
    public let interest: Bool
}

public struct FeedRun: Codable, Sendable, Equatable {
    public let at: Double
    public let ok: Bool
    public let reason: String?
}

public struct Feed: Decodable, Sendable, Equatable {
    public let on: Bool
    /// The unseen cards that are ready, in order.
    public let cards: [FeedCard]
    /// Newest saved first.
    public let saved: [FeedCard]
    /// Each source's last run, by name.
    public let runs: [String: FeedRun]
    /// When the next run starts (ms).
    public let next: Double

    // One card this app can't read must not blank the feed, so each decodes on its own.
    private struct Lenient: Decodable {
        let value: FeedCard?
        init(from decoder: Decoder) throws { value = try? FeedCard(from: decoder) }
    }
    private enum Keys: String, CodingKey { case on, cards, saved, runs, next }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        on = try c.decode(Bool.self, forKey: .on)
        cards = try c.decode([Lenient].self, forKey: .cards).compactMap(\.value)
        saved = try c.decode([Lenient].self, forKey: .saved).compactMap(\.value)
        runs = (try? c.decode([String: FeedRun].self, forKey: .runs)) ?? [:]
        next = try c.decode(Double.self, forKey: .next)
    }
}

/// A comments page Comments can open.
public struct FeedThread: Sendable, Equatable {
    public let name: String
    public let url: URL
}

public enum FeedText {
    /// A link the phone opens: http and https only, with a host.
    public static func link(_ s: String) -> URL? {
        guard let u = URL(string: s), let scheme = u.scheme?.lowercased(), scheme == "http" || scheme == "https", u.host != nil else { return nil }
        return u
    }

    /// 1234 is "1,234", whatever the phone's language, as the spec writes it.
    static func grouped(_ n: Int) -> String {
        let digits = String(n.magnitude)
        var out = ""
        for (i, ch) in digits.enumerated() {
            if i > 0, (digits.count - i) % 3 == 0 { out += "," }
            out.append(ch)
        }
        return n < 0 ? "-" + out : out
    }

    /// A source's score in words: "412 points", "230 upvotes", "1,234 stars today"; nil without one, or for a blog.
    static func score(_ s: FeedSource) -> String? {
        guard let n = s.score else { return nil }
        switch s.kind {
        case "hn": return "\(grouped(n)) points"
        case "reddit": return "\(grouped(n)) upvotes"
        case "github": return "\(grouped(n)) stars today"
        default: return nil
        }
    }

    /// How long ago it was found: "now" (under a minute), "45m", "2h", "3d".
    static func age(_ at: Double, now: Date) -> String {
        let s = max(0, now.timeIntervalSince1970 - at / 1000)
        if s < 60 { return "now" }
        if s < 3600 { return "\(Int(s / 60))m" }
        if s < 86400 { return "\(Int(s / 3600))h" }
        return "\(Int(s / 86400))d"
    }

    /// The line at a card's top: "Hacker News · 412 points · 2h". With two sources, each with its bare score:
    /// "Hacker News 412 · r/programming 230 · 2h".
    public static func sourceLine(_ c: FeedCard, now: Date) -> String {
        var parts: [String]
        if c.sources.count == 1, let s = c.sources.first {
            parts = [s.name]
            if let sc = score(s) { parts.append(sc) }
        } else {
            parts = c.sources.map { s in s.score.map { "\(s.name) \(FeedText.grouped($0))" } ?? s.name }
        }
        parts.append(age(c.at, now: now))
        return parts.joined(separator: " · ")
    }

    /// "Comments (330)", HN's and Reddit's counts added; "Comments" without any.
    public static func commentsLabel(_ c: FeedCard) -> String {
        let n = c.sources.compactMap(\.comments).reduce(0, +)
        return n > 0 ? "Comments (\(grouped(n)))" : "Comments"
    }

    /// The threads Comments opens, HN's and Reddit's. None: no Comments button. Two: it asks which.
    public static func threads(_ c: FeedCard) -> [FeedThread] {
        c.sources.compactMap { s in s.thread.flatMap { FeedText.link($0) }.map { FeedThread(name: s.name, url: $0) } }
    }

    /// The caught-up card's line on the next update: "Next update around 3:00 PM".
    public static func nextLine(_ next: Double, time: (Date) -> String) -> String {
        "Next update around " + time(Date(timeIntervalSince1970: next / 1000))
    }

    /// A line for each source whose last run failed, by name: "Reddit didn't load at 2:00 PM: no key".
    public static func failures(_ runs: [String: FeedRun], time: (Date) -> String) -> [String] {
        var lines: [String] = []
        for name in runs.keys.sorted() {
            guard let run = runs[name], !run.ok else { continue }
            let when = time(Date(timeIntervalSince1970: run.at / 1000))
            let why = run.reason.map { ": \($0)" } ?? ""
            lines.append("\(name) didn't load at \(when)\(why)")
        }
        return lines
    }
}

/// When a card counts as seen: it was on screen for 1 s or more, then the screen moved to another card or the feed
/// closed.
public struct FeedSeen: Sendable {
    private var id: String?
    private var since = Date.distantPast

    public init() {}

    /// What's on screen now (nil: the caught-up card). Returns the card on screen before, if it counts as seen.
    public mutating func show(_ card: String?, at time: Date) -> String? {
        let before = leave(at: time)
        id = card
        since = time
        return before
    }

    /// The feed closed: the card on screen, if it counts as seen.
    public mutating func leave(at time: Date) -> String? {
        defer { self.id = nil }
        guard let id, time.timeIntervalSince(since) >= 1 else { return nil }
        return id
    }
}
