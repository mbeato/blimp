import Foundation
import Testing
@testable import BlimpKit

// Needs you across projects, the inbox's ages, a row's caption, the banner's arrivals and following a handoff.

private func live(_ name: String, dir: String = "/p", state: SessionState = .done, since: Double? = nil, prompt: Prompt? = nil,
                  note: Note? = nil) -> Session {
    var x = Session(name: name, created: 1, dir: dir, kind: "claude", label: nil, sessionId: name + "-id", title: name.uppercased(),
                    updatedAt: since, state: state, stateSince: since, prompt: prompt)
    x.note = note
    return x
}

private let yesNo = Prompt(kind: .permission, at: 1, answerable: true, tool: "Bash", summary: "Ran `ls`", options: ["Yes", "No"], questions: nil)
private let minute = 60_000.0

@Test func needsYouIsEveryProjectsWaitingSessionsOldestFirstWithThisProjectsPastQuestions() {
    let sessions = [
        live("new", dir: "/p", state: .waiting, since: 9000, prompt: yesNo),
        live("far", dir: "/q", state: .waiting, since: 2000, prompt: yesNo),
        live("asks", dir: "/q", since: 5000, note: Note(status: .question, text: "ship it?", at: 1)),
        live("busy", dir: "/p", state: .working, since: 1000),
    ]
    let earlier = [Conversation(sessionId: "c1", title: "OLD Q", updatedAt: 4000, unread: true, note: Note(status: .question, text: "which?", at: 1)),
                   Conversation(sessionId: "c2", title: "DONE", updatedAt: 3000, unread: true, note: Note(status: .done, text: "x", at: 1))]
    let band = Inbox.needsYou(sessions: sessions, dir: "/p", earlier: earlier)
    #expect(band.map(\.id) == ["session-far", "past-c1", "session-asks", "session-new"])
    #expect(band.map(\.dir) == ["/q", "/p", "/q", "/p"])
    #expect(band.map(\.words) == ["Ran `ls`", "which?", "ship it?", "Ran `ls`"])
    #expect(Inbox.needsYou(sessions: sessions, dir: nil, earlier: earlier).count == 3)
}

@Test func comingBackShowsOnlyWhatChangedSinceButEveryWait() {
    let sessions = [live("w", state: .waiting, since: 2000, prompt: yesNo), live("old", since: 2000), live("new", since: 9000),
                    live("run", state: .working, since: 9500)]
    var withUnread = sessions
    withUnread[1].unread = true
    withUnread[2].unread = true
    let i = Inbox(dir: "/p", sessions: withUnread, earlier: []).changed(since: 5000)
    #expect(i.waiting.map(\.id) == ["session-w"])
    #expect(i.done.map(\.id) == ["session-new"])
    #expect(i.working.map(\.id) == ["session-run"])
    #expect(InboxText.since(5000, sessions: sessions) == "1 finished, 1 asking, 1 working")
    #expect(InboxText.since(5000, sessions: [live("old", since: 2000)]) == nil)
}

@Test func agesReadShortAndJustNowUnderAMinute() {
    let now = 10_000_000.0
    #expect(InboxText.asked(since: now - 30_000, now: now) == "asked just now")
    #expect(InboxText.asked(since: now - 6 * minute, now: now) == "asked 6m ago")
    #expect(InboxText.finished(since: now - 65 * minute, now: now) == "finished 1h 5m ago")
    #expect(InboxText.working(since: now - 14 * minute, now: now) == "working 14m")
    #expect(InboxText.working(since: now - 10_000, now: now) == "working <1m")
    #expect(InboxText.asOf(now - 2 * minute, now: now) == "as of 2m ago")
    // the phone's clock a little behind the server's
    #expect(InboxText.ago(now + 5000, now: now) == "just now")
}

@Test func theParagraphIsStaleOnceASessionItLinksChangedStateAfterIt() {
    let d = Digest(text: "[A](1) is going.", sessions: ["a"], at: 5000)
    #expect(!InboxText.stale(d, sessions: [live("a", since: 4000), live("b", since: 9000)]))
    #expect(InboxText.stale(d, sessions: [live("a", since: 6000)]))
}

@Test func aRowsCaptionHasTheHandoffTheBranchAndTheJobsAndItsClashesAndParent() throws {
    guard case .sessions(let list) = EventsMessage.decode(Data(sessions03.utf8)) else { throw Failed() }
    let now = 1792624236489.0
    let web1 = RowCaption(list[0], all: list, now: now)
    // waiting: the handoff's words give way; 1 job running for 18m (a running one beats the failed one)
    #expect(web1.text == "feat-x · 1 job · 18m")
    #expect(web1.clash == ["Also on branch feat-x: Tidy the README", "Both edited app/src/lib/browser.ts with Tidy the README"])
    #expect(web1.continued == nil)
    #expect(web1.branch == "On branch feat-x")
    #expect(RowCaption(list[1], all: list, now: now).branch == "On branch feat-x (worktree)")
    let child = RowCaption(list[3], all: list, now: now)
    #expect(child.continued == "Continued from Fix the phone login")
    #expect(child.text == nil && child.clash.isEmpty)
    #expect(RowCaption(list[3], all: [], now: now).continued == "Continued from web-1")
    var writing = list[1]
    writing.handoff = Handoff(state: .writing)
    #expect(RowCaption(writing, all: list, now: now).text == "Writing handoff · feat-x")
}

@Test func aBannerIsForASessionThatStartedWaitingOrFinishedWorkingNotTheOneOnScreen() {
    let before = Arrivals.states([live("a", state: .working), live("b", state: .working), live("c", state: .done), live("d", state: .waiting),
                                  live("e", state: .working)])
    let now = [live("a", state: .waiting), live("b", state: .done), live("c", state: .done), live("d", state: .done), live("e", state: .waiting),
               live("new", state: .waiting)]
    let news = Arrivals.news(before: before, sessions: now, onScreen: "e")
    #expect(news.map(\.session.name) == ["a", "b"])
    #expect(news.map(\.waiting) == [true, false])
}

@Test func aHandoffAskedForHereIsFollowedUntilItStartsOrFails() {
    var watch = HandoffWatch()
    watch.watch("p")
    watch.watch("q")
    // an older handoff's result, before this one was seen being written, says nothing
    #expect(watch.news([live("p").with(Handoff(state: .started, child: "old")), live("q")]).isEmpty)
    #expect(watch.news([live("p").with(Handoff(state: .writing)), live("q").with(Handoff(state: .writing))]).isEmpty)
    #expect(watch.news([live("p").with(Handoff(state: .started, child: "k", file: "/w/h.md")),
                        live("q").with(Handoff(state: .failed, error: "No handoff file came back"))]) == [
        .init(parent: "p", child: "k", error: nil), .init(parent: "q", child: nil, error: "No handoff file came back"),
    ])
    #expect(watch.isEmpty)
    // a session that ended while writing is no longer followed, and says nothing
    watch.watch("r")
    #expect(watch.news([]).isEmpty)
    #expect(watch.isEmpty)
}

private struct Failed: Error {}

extension Session {
    fileprivate func with(_ h: Handoff) -> Session {
        var s = self
        s.handoff = h
        return s
    }
}
