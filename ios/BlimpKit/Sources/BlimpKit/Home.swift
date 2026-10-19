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
            .sorted { (a: Session, b: Session) -> Bool in
                let x = a.stateSince ?? 0, y = b.stateSince ?? 0
                return x != y ? x < y : a.name < b.name
            }
        let groups: [ProjectGroup] = Dictionary(grouping: sessions, by: \.dir).map { (dir: String, list: [Session]) -> ProjectGroup in
            let byNewest: [Session] = list.sorted { (a: Session, b: Session) -> Bool in
                a.created != b.created ? a.created > b.created : a.name < b.name
            }
            return ProjectGroup(
                dir: dir,
                // "/" has no last component, so it shows whole
                name: dir.split(separator: "/").last.map(String.init) ?? dir,
                sessions: byNewest,
                waiting: list.contains { $0.state == .waiting },
                activity: list.map(\.activity).max() ?? 0)
        }
        let projects = groups.sorted { (a: ProjectGroup, b: ProjectGroup) -> Bool in
            if a.activity != b.activity { return a.activity > b.activity }
            return a.name != b.name ? a.name < b.name : a.dir < b.dir
        }
        return HomeList(waiting: waiting, projects: projects)
    }
}
