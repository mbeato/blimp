// The phone's one screen, as chat apps have it: a project's sessions for the drawer (running and past,
// newest activity first), the projects for the picker, and the mark beside each.
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

    /// "/" has no last component, so it shows whole.
    public static func name(of dir: String) -> String {
        dir.split(separator: "/").last.map(String.init) ?? dir
    }
}
