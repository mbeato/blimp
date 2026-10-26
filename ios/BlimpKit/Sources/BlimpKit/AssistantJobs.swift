// The assistant's jobs (docs/superpowers/specs/2026-10-26-assistant-design.md, sections 3 and 4): the sessions it
// started or messaged (Session.job), as the phone's jobs bar shows them, with the Mac's rules (app/src/lib/assistant.ts).
// A job is in one bucket: needs you (it waits, or its turn ended with a question), working (it works, or its turn ended
// saying it's still at it), or done (its turn ended with a reply you haven't seen); else it isn't shown.
import Foundation

public enum JobBucket: String, Equatable, Sendable {
    case needs, working, done
}

public struct AssistantJobRow: Equatable, Identifiable, Sendable {
    /// The job's session, by its zmx name.
    public let session: String
    /// The last part of its folder.
    public let project: String
    public let reason: String
    public let bucket: JobBucket
    /// For a wait, what it asks (else its note); none while it works (its note is the turn before's); else its note.
    public let words: String?
    public let mark: Mark
    public var id: String { session }
}

public enum AssistantJobs {
    /// The assistant's session's name (blimpd's ASSISTANT).
    public static let assistant = "assistant"

    /// Needs you, the oldest wait first; working, the longest first; done, the newest first.
    public static func rows(_ sessions: [Session]) -> [AssistantJobRow] {
        var needs: [Session] = [], working: [Session] = [], done: [Session] = []
        for s in sessions where s.job != nil {
            guard let b = bucket(s) else { continue }
            switch b {
            case .needs: needs.append(s)
            case .working: working.append(s)
            case .done: done.append(s)
            }
        }
        let since = { (s: Session) -> Double in s.stateSince ?? s.activity }
        let ordered = stable(needs, by: since, newest: false) + stable(working, by: since, newest: false) + stable(done, by: \.activity, newest: true)
        return ordered.compactMap(row)
    }

    /// "1 needs you · 2 working · 1 done", leaving out the empty ones; nil with no job to show.
    public static func counts(_ rows: [AssistantJobRow]) -> String? {
        var parts: [String] = []
        for (bucket, words) in [(JobBucket.needs, "needs you"), (JobBucket.working, "working"), (JobBucket.done, "done")] {
            let n = rows.filter { $0.bucket == bucket }.count
            if n > 0 { parts.append("\(n) \(words)") }
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private static func bucket(_ s: Session) -> JobBucket? {
        if s.state == .waiting || (s.state == .done && s.note?.status == .question) { return .needs }
        if s.state == .working || (s.state == .done && s.note?.status == .progress) { return .working }
        if s.state == .done && s.unread == true { return .done }
        return nil
    }

    private static func row(_ s: Session) -> AssistantJobRow? {
        guard let job = s.job, let b = bucket(s) else { return nil }
        let words: String?
        if s.state == .waiting { words = Inbox.asked(s.prompt) ?? s.note?.text }
        else if s.state == .working { words = nil }
        else { words = s.note?.text }
        return AssistantJobRow(session: s.name, project: Drawer.name(of: s.dir), reason: job.reason, bucket: b, words: words, mark: s.mark)
    }

    // Ties keep the list's order.
    private static func stable(_ l: [Session], by key: (Session) -> Double, newest: Bool) -> [Session] {
        l.enumerated().sorted {
            let a = key($0.element), b = key($1.element)
            return a != b ? (newest ? a > b : a < b) : $0.offset < $1.offset
        }.map(\.element)
    }
}
