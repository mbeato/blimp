import Foundation
import Testing
@testable import BlimpKit

// The phone's live panel: blimpd's content-state (src/live.ts, test/live.test.ts), its words and its link.

private let full = #"{"turn":{"session":"blimp-phone","dir":"/u/blimp","title":"Server update","state":"working","since":1800000000000,"steps":{"done":3,"total":7,"current":"Running the tests"}},"rows":[{"session":"a","dir":"/u/cq","title":"Linking Linear cards","state":"needs","since":1799999990000},{"session":"b","dir":"/u/blimp","title":"Fixing the Slack bot","state":"working","since":1799990000000}],"counts":{"needs":2,"new":1,"working":3}}"#

@Test func blimpdsContentStateDecodes() throws {
    let l = try JSONDecoder().decode(LiveState.self, from: Data(full.utf8))
    #expect(l.turn?.session == "blimp-phone")
    #expect(l.turn?.state == WidgetSummary.State.working)
    #expect(l.turn?.since == 1_800_000_000_000)
    #expect(l.turn?.steps == LiveState.Steps(done: 3, total: 7, current: "Running the tests"))
    #expect(l.rows.map(\.state) == [WidgetSummary.State.needs, WidgetSummary.State.working])
    #expect(l.counts == WidgetSummary.Counts(needs: 2, new: 1, working: 3))
    let bare = try JSONDecoder().decode(LiveState.self, from: Data(#"{"rows":[],"counts":{"needs":0,"new":0,"working":1}}"#.utf8))
    #expect(bare.turn == nil)
    let waiting = #"{"turn":{"session":"s","dir":"/u/x","title":"T","state":"needs","since":1},"rows":[],"counts":{"needs":1,"new":0,"working":0}}"#
    let noSteps = try JSONDecoder().decode(LiveState.self, from: Data(waiting.utf8))
    #expect(noSteps.turn?.state == WidgetSummary.State.needs)
    #expect(noSteps.turn?.steps == nil)
}

@Test func itComesBackFromJSONTheSame() throws {
    // iOS keeps a panel's content as JSON: what the app starts one with must decode to the same state.
    let l = try JSONDecoder().decode(LiveState.self, from: Data(full.utf8))
    let again = try JSONDecoder().decode(LiveState.self, from: JSONEncoder().encode(l))
    #expect(again == l)
    #expect(Set([l, again]).count == 1)
}

@Test func theStepIsTheOneAfterThoseDoneAndTheBarIsTheShareDone() {
    #expect(LiveText.step(LiveState.Steps(done: 3, total: 7, current: "Running the tests")) == "Step 4 of 7")
    #expect(LiveText.step(LiveState.Steps(done: 0, total: 2)) == "Step 1 of 2")
    #expect(LiveText.step(LiveState.Steps(done: 7, total: 7)) == "Step 7 of 7")
    #expect(LiveText.progress(LiveState.Steps(done: 1, total: 4)) == 0.25)
    #expect(LiveText.progress(LiveState.Steps(done: 0, total: 0)) == 0)
}

@Test func theIslandSaysWhatNeedsYouAndWhatWorks() {
    let c = LiveText.compact(WidgetSummary.Counts(needs: 2, new: 1, working: 3))
    #expect(c.leading == "?2")
    #expect(c.trailing == "●3")
    #expect(LiveText.minimal(WidgetSummary.Counts(needs: 1, new: 0, working: 3)) == "?")
    #expect(LiveText.minimal(WidgetSummary.Counts(needs: 0, new: 2, working: 3)) == "●")
}

@Test func aTapOpensTheTurnElseTheOldestThatNeedsYouElseTheApp() throws {
    let l = try JSONDecoder().decode(LiveState.self, from: Data(full.utf8))
    #expect(LiveText.link(l) == WidgetLink.url(session: "blimp-phone"))
    let work = WidgetSummary.Row(session: "w", dir: "/u/blimp", title: "W", state: .working, since: 1)
    let ask = WidgetSummary.Row(session: "ask", dir: "/u/blimp", title: "A", state: .needs, since: 2)
    #expect(LiveText.link(LiveState(rows: [work, ask], counts: WidgetSummary.Counts(needs: 1, new: 0, working: 1))) == WidgetLink.url(session: "ask"))
    #expect(LiveText.link(LiveState(rows: [work], counts: WidgetSummary.Counts(needs: 0, new: 0, working: 1))) == WidgetLink.app)
}
