// The home screen's shape: what is waiting on you, then sessions grouped by project folder.
import Foundation

public struct ProjectGroup: Equatable, Identifiable, Sendable {
    public let dir: String
    public var id: String { dir }
    public let name: String
    public let sessions: [Session]
    public let waiting: Bool
    public let activity: Double
}

public struct HomeList: Equatable, Sendable {
    public let waiting: [Session]
    public let projects: [ProjectGroup]

    public static func make(_ sessions: [Session]) -> HomeList {
        let waiting = sessions.filter { $0.state == .waiting }
            .sorted { ($0.stateSince ?? 0) < ($1.stateSince ?? 0) }
        let groups = Dictionary(grouping: sessions, by: \.dir).map { dir, list in
            ProjectGroup(
                dir: dir,
                // "/" has no last component, so it shows whole
                name: dir.split(separator: "/").last.map(String.init) ?? dir,
                sessions: list.sorted { $0.created > $1.created },
                waiting: list.contains { $0.state == .waiting },
                activity: list.map(\.activity).max() ?? 0)
        }
        let projects = groups.sorted { $0.activity != $1.activity ? $0.activity > $1.activity : $0.name < $1.name }
        return HomeList(waiting: waiting, projects: projects)
    }
}
