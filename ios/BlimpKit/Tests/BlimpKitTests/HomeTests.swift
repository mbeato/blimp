import Testing
@testable import BlimpKit

func session(_ name: String, dir: String, created: Double, state: SessionState = .done, since: Double? = nil, updated: Double? = nil) -> Session {
    Session(name: name, created: created, dir: dir, kind: "claude", label: nil, sessionId: "s", title: name,
            updatedAt: updated, state: state, stateSince: since, prompt: nil)
}

@Test func waitingFirstOldestWaitFirstThenProjectsByActivity() {
    let list = HomeList.make([
        session("a1", dir: "/h/alpha", created: 100, state: .waiting, since: 900_000),
        session("a2", dir: "/h/alpha", created: 200),
        session("b1", dir: "/h/beta", created: 300, state: .waiting, since: 500_000),
        session("c1", dir: "/", created: 50, updated: 2_000_000),
    ])
    #expect(list.waiting.map(\.name) == ["b1", "a1"])
    #expect(list.projects.map(\.name) == ["/", "alpha", "beta"])
    #expect(list.projects[1].sessions.map(\.name) == ["a2", "a1"])
    #expect(list.projects[1].waiting && list.projects[2].waiting && !list.projects[0].waiting)
}
