// A project's inbox (docs/DESIGN.md, "Inbox"): its sessions and unread past conversations sorted under Waiting
// on you, Done (finished, not read yet) and Working, each with a few words from what it asks or Haiku's note on
// its last turn, and the rest folded as "other". Across every project, Needs you: each waiting session, oldest
// first, which the phone shows on top with its answers. The Mac builds the same (app/src/lib/inbox.ts), by the
// same rules.
import Foundation

public struct InboxLine: Equatable, Identifiable, Sendable {
    public let item: DrawerRow.Item
    public let title: String
    public let words: String?
    /// Milliseconds: its newest activity, which Done and the folded rest sort by.
    public let activity: Double
    /// Milliseconds: when it started waiting or working (its state's start), else its activity.
    public let since: Double
    /// The project it's in.
    public let dir: String

    public var id: String {
        switch item {
        case .running(let s): "session-" + s.name
        case .past(let c): "past-" + c.sessionId
        }
    }

    public var session: Session? {
        if case .running(let s) = item { return s }
        return nil
    }

    init(_ s: Session, words: String?) {
        item = .running(s)
        title = s.title
        self.words = words
        activity = s.activity
        since = s.stateSince ?? s.activity
        dir = s.dir
    }

    init(_ c: Conversation, dir: String) {
        item = .past(c)
        title = c.title
        words = c.note?.text
        activity = c.updatedAt
        since = c.updatedAt
        self.dir = dir
    }
}

public struct Inbox: Equatable, Sendable {
    public private(set) var waiting: [InboxLine] = []
    public private(set) var done: [InboxLine] = []
    /// Claude working on it now, the longest-running first.
    public private(set) var working: [InboxLine] = []
    /// The project's other running sessions (shells, runs, ones read or done mid-way), newest first: folded.
    public private(set) var other: [InboxLine] = []

    public var isEmpty: Bool { waiting.isEmpty && done.isEmpty && working.isEmpty && other.isEmpty }

    /// What a waiting session asks: a permission's summary, or its first question.
    public static func asked(_ p: Prompt?) -> String? {
        switch p?.kind {
        case .permission: p?.summary
        case .question: p?.questions?.first?.question
        default: nil
        }
    }

    /// A running session that waits on you: what it asks, or a question in its note. nil: it doesn't.
    static func waitingLine(_ s: Session) -> InboxLine? {
        if s.state == .waiting { return InboxLine(s, words: asked(s.prompt) ?? s.note?.text) }
        if s.state == .done, s.note?.status == .question { return InboxLine(s, words: s.note?.text) }
        return nil
    }

    /// dir's running sessions, and its past conversations that no running session has open.
    public init(dir: String, sessions: [Session], earlier: [Conversation]) {
        for s in sessions where s.dir == dir {
            let n = s.note
            if let w = Self.waitingLine(s) { waiting.append(w) }
            else if s.state == .done, s.unread == true, n?.status != .progress { done.append(InboxLine(s, words: n?.text)) }
            else if s.state == .working { working.append(InboxLine(s, words: nil)) }
            else { other.append(InboxLine(s, words: nil)) }
        }
        for c in Self.unreadPast(dir: dir, sessions: sessions, earlier: earlier) {
            if c.note?.status == .question { waiting.append(InboxLine(c, dir: dir)) } else { done.append(InboxLine(c, dir: dir)) }
        }
        waiting = Self.newestFirst(waiting)
        done = Self.newestFirst(done)
        other = Self.newestFirst(other)
        working = Self.oldestFirst(working)
    }

    /// Needs you, across every project: each running session that waits on you (as Waiting on you has them),
    /// and dir's unread past conversations with a question, the oldest wait first.
    public static func needsYou(sessions: [Session], dir: String?, earlier: [Conversation]) -> [InboxLine] {
        let past = dir.map { d in
            unreadPast(dir: d, sessions: sessions, earlier: earlier).filter { $0.note?.status == .question }.map { InboxLine($0, dir: d) }
        } ?? []
        return oldestFirst(sessions.compactMap(waitingLine) + past)
    }

    /// Only what changed since `since` (ms): the lines with activity from then on. Waiting on you stays whole.
    public func changed(since: Double) -> Inbox {
        var i = self
        i.done = done.filter { $0.activity >= since }
        i.working = working.filter { $0.activity >= since }
        i.other = other.filter { $0.activity >= since }
        return i
    }

    // dir's unread past conversations that no running session has open, and not still in progress.
    private static func unreadPast(dir: String, sessions: [Session], earlier: [Conversation]) -> [Conversation] {
        let open = Set(sessions.filter { $0.dir == dir }.compactMap(\.sessionId))
        return earlier.filter { $0.unread == true && !open.contains($0.sessionId) && $0.note?.status != .progress }
    }

    // Ties keep the list's order.
    private static func newestFirst(_ l: [InboxLine]) -> [InboxLine] {
        l.enumerated().sorted { $0.element.activity != $1.element.activity ? $0.element.activity > $1.element.activity : $0.offset < $1.offset }.map(\.element)
    }

    private static func oldestFirst(_ l: [InboxLine]) -> [InboxLine] {
        l.enumerated().sorted { $0.element.since != $1.element.since ? $0.element.since < $1.element.since : $0.offset < $1.offset }.map(\.element)
    }
}

/// The inbox's ages and its line for coming back, in short words. Times are ms.
public enum InboxText {
    /// Working this long, a session gets a clock: "how long has the deploy been running".
    public static let long: Double = 30 * 60_000
    /// Away this long (the app in the background), the inbox says what changed since.
    public static let away: Double = 30 * 60_000

    /// "asked just now", "asked 6m ago".
    public static func asked(since: Double, now: Double) -> String { "asked " + ago(since, now: now) }
    /// "finished just now", "finished 3m ago".
    public static func finished(since: Double, now: Double) -> String { "finished " + ago(since, now: now) }
    /// "working <1m", "working 14m".
    public static func working(since: Double, now: Double) -> String { "working " + JobsText.duration(now - since) }
    /// "as of just now", "as of 2m ago": when the project's paragraph was written.
    public static func asOf(_ at: Double, now: Double) -> String { "as of " + ago(at, now: now) }

    /// "just now" under a minute, else "6m ago", "1h 5m ago", "2d ago".
    public static func ago(_ at: Double, now: Double) -> String {
        now - at < 60_000 ? "just now" : JobsText.duration(now - at) + " ago"
    }

    /// The paragraph is older than what it tells: a session it links to has changed state since it was written.
    public static func stale(_ d: Digest, sessions: [Session]) -> Bool {
        sessions.contains { s in d.sessions.contains(s.name) && (s.stateSince ?? 0) > d.at }
    }

    /// Coming back after a while: "4 finished, 1 asking, 2 working", leaving out a count of none. The rows that
    /// "Show these" shows (inbox.changed(since:)): the project's finished and working since then, and Needs you
    /// (every project's), so the counts and the list agree. nil: nothing to say.
    public static func since(_ since: Double, inbox: Inbox, needs: [InboxLine]) -> String? {
        let shown = inbox.changed(since: since)
        let finished = shown.done.count
        let asking = needs.count
        let working = shown.working.count
        let parts = [(finished, "finished"), (asking, "asking"), (working, "working")].filter { $0.0 > 0 }.map { "\($0.0) \($0.1)" }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }
}
