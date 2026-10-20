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

@Test func sameNamedProjectsKeepAStableOrder() {
    for input in [[session("x", dir: "/a/app", created: 1), session("y", dir: "/b/app", created: 1)],
                  [session("y", dir: "/b/app", created: 1), session("x", dir: "/a/app", created: 1)]] {
        #expect(HomeList.make(input).projects.map(\.dir) == ["/a/app", "/b/app"])
    }
}

@Test func pagesAreTheProjectsSessionsInHomeOrder() {
    let home = HomeList.make([
        session("a1", dir: "/h/alpha", created: 100),
        session("a2", dir: "/h/alpha", created: 200),
        session("b1", dir: "/h/beta", created: 300),
    ])
    #expect(home.pages(dir: "/h/alpha", current: "a1", previous: []) == ["a2", "a1"])
    // not known yet where it runs: only itself
    #expect(home.pages(dir: nil, current: "a1", previous: []) == ["a1"])
}

@Test func aSessionNotListedKeepsItsPlace() {
    let home = HomeList.make([
        session("a1", dir: "/h/alpha", created: 100),
        session("a3", dir: "/h/alpha", created: 300),
    ])
    // a2 ended while on screen: it stays between the two it was between
    #expect(home.pages(dir: "/h/alpha", current: "a2", previous: ["a3", "a2", "a1"]) == ["a3", "a2", "a1"])
    // one that ended and isn't on screen goes
    #expect(home.pages(dir: "/h/alpha", current: "a1", previous: ["a3", "a2", "a1"]) == ["a3", "a1"])
    // just started and not listed yet: first, where Home will put it
    #expect(home.pages(dir: "/h/alpha", current: "a4", previous: []) == ["a4", "a3", "a1"])
}
