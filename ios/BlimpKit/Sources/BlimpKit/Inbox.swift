// A project's inbox (docs/DESIGN.md, "Inbox"): its sessions and unread past conversations sorted under Waiting
// on you, In progress and Done, each with a few words from what it asks or Haiku's note on its last turn. The Mac
// builds the same (app/src/lib/inbox.ts), by the same rules.
import Foundation

public struct InboxLine: Equatable, Identifiable, Sendable {
    public let item: DrawerRow.Item
    public let title: String
    public let words: String?
    /// Milliseconds: its newest activity, which each heading sorts by.
    public let activity: Double

    public var id: String {
        switch item {
        case .running(let s): "session-" + s.name
        case .past(let c): "past-" + c.sessionId
        }
    }
}

public struct Inbox: Equatable, Sendable {
    public private(set) var waiting: [InboxLine] = []
    public private(set) var progress: [InboxLine] = []
    public private(set) var done: [InboxLine] = []

    public var isEmpty: Bool { waiting.isEmpty && progress.isEmpty && done.isEmpty }

    /// What a waiting session asks: a permission's summary, or its first question.
    public static func asked(_ p: Prompt?) -> String? {
        switch p?.kind {
        case .permission: p?.summary
        case .question: p?.questions?.first?.question
        default: nil
        }
    }

    /// dir's running sessions, and its past conversations that no running session has open.
    public init(dir: String, sessions: [Session], earlier: [Conversation]) {
        let running = sessions.filter { $0.dir == dir }
        for s in running {
            let n = s.note
            func line(_ words: String?) -> InboxLine { InboxLine(item: .running(s), title: s.title, words: words, activity: s.activity) }
            if s.state == .waiting { waiting.append(line(Self.asked(s.prompt) ?? n?.text)) }
            else if s.state == .done, n?.status == .question { waiting.append(line(n?.text)) }
            // A working session's note is about the turn before this one.
            else if s.state == .working { progress.append(line(nil)) }
            else if s.state == .done, n?.status == .progress { progress.append(line(n?.text)) }
            else if s.state == .done, s.unread == true { done.append(line(n?.text)) }
        }
        let open = Set(running.compactMap(\.sessionId))
        for c in earlier where c.unread == true && !open.contains(c.sessionId) {
            let line = InboxLine(item: .past(c), title: c.title, words: c.note?.text, activity: c.updatedAt)
            switch c.note?.status {
            case .question: waiting.append(line)
            case .progress: progress.append(line)
            default: done.append(line)
            }
        }
        // Newest first; ties keep the list's order.
        func sorted(_ l: [InboxLine]) -> [InboxLine] {
            l.enumerated().sorted { $0.element.activity != $1.element.activity ? $0.element.activity > $1.element.activity : $0.offset < $1.offset }.map(\.element)
        }
        waiting = sorted(waiting)
        progress = sorted(progress)
        done = sorted(done)
    }
}
