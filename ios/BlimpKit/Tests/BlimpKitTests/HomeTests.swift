import Testing
@testable import BlimpKit

func session(_ name: String, dir: String, created: Double, state: SessionState = .done, since: Double? = nil,
             updated: Double? = nil, id: String? = "s", unread: Bool? = nil) -> Session {
    Session(name: name, created: created, dir: dir, kind: "claude", label: nil, sessionId: id, title: name,
            updatedAt: updated, state: state, stateSince: since, prompt: nil, unread: unread)
}

func conversation(_ id: String, updated: Double, unread: Bool? = nil) -> Conversation {
    Conversation(sessionId: id, title: "past \(id)", updatedAt: updated, unread: unread)
}

@Test func askingBeatsUnreadBeatsWorking() {
    #expect(session("a", dir: "/", created: 1, state: .waiting, unread: true).mark == .asking)
    #expect(session("a", dir: "/", created: 1, state: .working, unread: true).mark == .unread)
    #expect(session("a", dir: "/", created: 1, state: .working).mark == .working)
    #expect(session("a", dir: "/", created: 1, unread: false).mark == .none)
    #expect(Mark.top([.working, .unread, .none]) == .unread)
    #expect(Mark.top([.unread, .asking]) == .asking)
    #expect(Mark.top([.working]) == .none)
}

@Test func drawerIsTheProjectsRunningAndPastNewestActivityFirst() {
    let sessions = [
        session("a1", dir: "/h/alpha", created: 1, updated: 5_000, id: "c1"),
        session("a2", dir: "/h/alpha", created: 2, updated: 1_000, id: "c2"),
        session("b1", dir: "/h/beta", created: 3, updated: 9_000, id: "c3"),
    ]
    // c1 is open in a1, so it's listed once, as running
    let earlier = [conversation("c1", updated: 5_000), conversation("p1", updated: 3_000, unread: true), conversation("p2", updated: 500)]
    let rows = Drawer.rows(dir: "/h/alpha", sessions: sessions, earlier: earlier)
    #expect(rows.map(\.id) == ["session-a1", "past-p1", "session-a2", "past-p2"])
    #expect(rows.map(\.mark) == [.none, .unread, .none, .none])
}

@Test func pickerHasRunningProjectsAndRecentFoldersNewestFirstWithTheirTopMark() {
    let sessions = [
        session("a1", dir: "/h/alpha", created: 1, updated: 5_000, unread: true),
        session("a2", dir: "/h/alpha", created: 2, state: .working, updated: 1_000),
        session("b1", dir: "/h/beta", created: 3, updated: 2_000),
    ]
    let recent = [RecentFolder(dir: "/h/alpha", lastUsed: 99_000), RecentFolder(dir: "/h/gamma", lastUsed: 4_000)]
    let projects = Drawer.projects(sessions: sessions, recent: recent)
    #expect(projects.map(\.name) == ["alpha", "gamma", "beta"])
    #expect(projects.map(\.mark) == [.unread, .none, .none])
    #expect(Drawer.name(of: "/") == "/")
}

@Test func drawerButtonShowsWhatNeedsYouOutsideTheChatOnScreen() {
    let sessions = [
        session("a1", dir: "/h/alpha", created: 1, state: .waiting),
        session("b1", dir: "/h/beta", created: 2, unread: true),
    ]
    #expect(Drawer.others(sessions, onScreen: nil) == .asking)
    #expect(Drawer.others(sessions, onScreen: "a1") == .unread)
    #expect(Drawer.others(Array(sessions.prefix(1)), onScreen: "a1") == .none)
}
