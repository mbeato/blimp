// The phone's one screen, as chat apps have it: a project's sessions for the drawer (running and past,
// newest activity first), the projects for the picker, and the mark beside each; what a row says under its
// title; which sessions just started waiting or finished (the banner); and handoffs asked for from the phone.
import Foundation

/// What a row shows beside its name. Claude asking beats a reply you haven't seen, which beats working.
public enum Mark: Equatable, Sendable {
    case asking, unread, working, none

    /// The one that needs you most among several (a project's, or the drawer button's): asking, else unread.
    public static func top(_ marks: [Mark]) -> Mark {
        marks.contains(.asking) ? .asking : marks.contains(.unread) ? .unread : .none
    }
}

extension Session {
    public var mark: Mark {
        if state == .waiting { return .asking }
        if unread == true { return .unread }
        return state == .working ? .working : .none
    }
}

public struct DrawerRow: Equatable, Identifiable, Sendable {
    public enum Item: Equatable, Sendable { case running(Session), past(Conversation) }
    public let item: Item
    public let title: String
    /// Milliseconds: its newest activity, which the drawer sorts by.
    public let activity: Double
    public let mark: Mark

    public var id: String {
        switch item {
        case .running(let s): "session-" + s.name
        case .past(let c): "past-" + c.sessionId
        }
    }
}

public struct ProjectChoice: Equatable, Identifiable, Sendable {
    public let dir: String
    public var id: String { dir }
    public let name: String
    public let mark: Mark
    public let activity: Double
}

public enum Drawer {
    /// dir's running sessions and its past conversations, except those a running session has open, newest activity first.
    public static func rows(dir: String, sessions: [Session], earlier: [Conversation]) -> [DrawerRow] {
        let running = sessions.filter { $0.dir == dir }
        let open = Set(running.compactMap(\.sessionId))
        let rows = running.map { DrawerRow(item: .running($0), title: $0.title, activity: $0.activity, mark: $0.mark) }
            + earlier.filter { !open.contains($0.sessionId) }.map {
                DrawerRow(item: .past($0), title: $0.title, activity: $0.updatedAt, mark: $0.unread == true ? .unread : .none)
            }
        return rows.sorted { $0.activity != $1.activity ? $0.activity > $1.activity : $0.id < $1.id }
    }

    /// The picker's projects: folders with sessions running and recent folders, newest activity first, each with
    /// the top mark of its sessions.
    public static func projects(sessions: [Session], recent: [RecentFolder]) -> [ProjectChoice] {
        let running = Dictionary(grouping: sessions, by: \.dir).map { dir, list in
            ProjectChoice(dir: dir, name: name(of: dir), mark: Mark.top(list.map(\.mark)), activity: list.map(\.activity).max() ?? 0)
        }
        let dirs = Set(running.map(\.dir))
        let idle = recent.filter { !dirs.contains($0.dir) }.map {
            ProjectChoice(dir: $0.dir, name: name(of: $0.dir), mark: .none, activity: $0.lastUsed)
        }
        return (running + idle).sorted { $0.activity != $1.activity ? $0.activity > $1.activity : $0.dir < $1.dir }
    }

    /// The drawer button's mark: the top one of every session but the one on screen.
    public static func others(_ sessions: [Session], onScreen: String?) -> Mark {
        Mark.top(sessions.filter { $0.name != onScreen }.map(\.mark))
    }

    /// The drawer button's badge, by Needs you's rule so the two agree: asking while Needs you has a line that
    /// isn't the session on screen (a past question, or a finished turn that ends in a question, counts), else
    /// a reply you haven't seen.
    public static func badge(_ sessions: [Session], needs: [InboxLine], onScreen: String?) -> Mark {
        if needs.contains(where: { $0.session.map { $0.name != onScreen } ?? true }) { return .asking }
        return others(sessions, onScreen: onScreen)
    }

    /// "/" has no last component, so it shows whole.
    public static func name(of dir: String) -> String {
        dir.split(separator: "/").last.map(String.init) ?? dir
    }
}

/// What a running session's row says under its title, beside its age: a handoff, the branch, the jobs (the
/// Mac's words, JobsText, WorkText, HandoffText); and a session a handoff started says which one it continues.
public struct RowCaption: Equatable, Sendable {
    /// "Writing handoff · feat-x · 2 jobs · 14m"; nil: nothing to say.
    public let text: String?
    /// "Continued from Fix the login": its parent's title, or its zmx name once that's gone.
    public let continued: String?
    /// "On branch feat-x (worktree)", for its menu.
    public let branch: String?

    /// all: the server's sessions, for the parent's title. now: ms.
    public init(_ s: Session, all: [Session], now: Double) {
        let parts = [HandoffText.words(s), WorkText.branch(s), JobsText.caption(s.jobs, now: now)].compactMap { $0 }
        text = parts.isEmpty ? nil : parts.joined(separator: " · ")
        continued = s.parent.map { p in "Continued from " + (all.first { $0.name == p }?.title ?? p) }
        branch = WorkText.branchLine(s)
    }
}

/// A session that started waiting on you, or finished a turn, while the app was open: a banner and a haptic.
public struct Arrival: Equatable, Sendable {
    public let session: Session
    /// Waiting on you (a banner and a double haptic); else it finished (a light tick, no banner).
    public let waiting: Bool
}

public enum Arrivals {
    /// Each session's state, by name: what the next list is compared with.
    public static func states(_ sessions: [Session]) -> [String: SessionState] {
        Dictionary(sessions.map { ($0.name, $0.state) }, uniquingKeysWith: { a, _ in a })
    }

    /// The sessions that started waiting since `before`, or went from working to done. One new to the list
    /// says nothing (it's what the screen showed on opening), nor does the one on screen.
    public static func news(before: [String: SessionState], sessions: [Session], onScreen: String?) -> [Arrival] {
        sessions.compactMap { s in
            guard s.name != onScreen, let was = before[s.name], was != s.state else { return nil }
            if s.state == .waiting { return Arrival(session: s, waiting: true) }
            if s.state == .done, was == .working { return Arrival(session: s, waiting: false) }
            return nil
        }
    }
}

/// Continue in new session, asked for from this phone: which handoffs to follow until they start (to open the
/// new session) or fail (to say why). The same as the Mac's (app/src/lib/handoff.ts, handoffNews).
public struct HandoffWatch: Equatable, Sendable {
    public struct News: Equatable, Sendable {
        public let parent: String
        /// Started: the new session. Failed: why.
        public let child: String?
        public let error: String?
    }

    /// By parent: whether its handoff was seen being written yet (until then, a result in the list is an older one's).
    private var watching: [String: Bool] = [:]

    public init() {}

    public var isEmpty: Bool { watching.isEmpty }

    public mutating func watch(_ parent: String) { watching[parent] = false }
    public mutating func forget(_ parent: String) { watching[parent] = nil }

    /// The handoffs that just started or failed, which are no longer watched; and any whose session ended,
    /// which say nothing.
    public mutating func news(_ sessions: [Session]) -> [News] {
        var out: [News] = []
        for (parent, written) in watching.sorted(by: { $0.key < $1.key }) {
            guard let s = sessions.first(where: { $0.name == parent }) else { watching[parent] = nil; continue }
            let h = s.handoff
            if h?.state == .writing { watching[parent] = true }
            else if written, h?.state == .started, let child = h?.child { out.append(News(parent: parent, child: child, error: nil)) }
            else if written, h?.state == .failed { out.append(News(parent: parent, child: nil, error: h?.error ?? "The handoff failed")) }
        }
        for n in out { watching[n.parent] = nil }
        return out
    }
}
