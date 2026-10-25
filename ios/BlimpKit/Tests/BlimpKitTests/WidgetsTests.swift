import Foundation
import Testing
@testable import BlimpKit

// The phone's widgets: GET /widget's summary, the words they show, the link a row opens, and the App Group's files.

private let counts = WidgetSummary.Counts(needs: 1, new: 2, working: 3)

@Test func theSummaryDecodes() throws {
    let json = #"{"at":1800000000000,"counts":{"needs":1,"new":0,"working":1},"rows":[{"session":"demo","dir":"/u/blimp","title":"Fix it","state":"needs","since":1799999990000},{"session":"w","dir":"/u/cq","title":"Build","state":"working","since":1799999000000}],"lastFinished":1799999999000}"#
    let w = try JSONDecoder().decode(WidgetSummary.self, from: Data(json.utf8))
    #expect(w.counts == WidgetSummary.Counts(needs: 1, new: 0, working: 1))
    #expect(w.rows.map(\.state) == [WidgetSummary.State.needs, WidgetSummary.State.working])
    #expect(w.rows.first?.id == "demo")
    #expect(w.lastFinished == 1_799_999_999_000)
    let none = try JSONDecoder().decode(WidgetSummary.self, from: Data(#"{"at":1,"counts":{"needs":0,"new":0,"working":0},"rows":[]}"#.utf8))
    #expect(none.lastFinished == nil)
}

@Test func theLockScreenLineLeavesOutNoughtsAndSaysAllQuietForNothing() {
    #expect(WidgetText.line(counts) == "? 1 · ✓ 2 · ● 3")
    #expect(WidgetText.line(WidgetSummary.Counts(needs: 0, new: 0, working: 3)) == "● 3")
    #expect(WidgetText.line(WidgetSummary.Counts(needs: 0, new: 0, working: 0)) == "All quiet")
    #expect(WidgetText.isQuiet(WidgetSummary.Counts(needs: 0, new: 0, working: 0)))
    #expect(!WidgetText.isQuiet(counts))
}

@Test func theSmallWidgetHasAllThreeCounts() {
    #expect(WidgetText.countLines(counts) == ["? 1 needs you", "✓ 2 new", "● 3 working"])
    #expect(WidgetText.countLines(WidgetSummary.Counts(needs: 0, new: 0, working: 0)) == ["? 0 needs you", "✓ 0 new", "● 0 working"])
}

@Test func theRoundWidgetShowsNeedsYouElseWorkingElseATick() {
    let needs = WidgetText.circle(counts)
    #expect(needs.symbol == "?")
    #expect(needs.count == 1)
    let working = WidgetText.circle(WidgetSummary.Counts(needs: 0, new: 2, working: 3))
    #expect(working.symbol == "●")
    #expect(working.count == 3)
    let neither = WidgetText.circle(WidgetSummary.Counts(needs: 0, new: 2, working: 0))
    #expect(neither.symbol == "✓")
    #expect(neither.count == nil)
}

@Test func aRowsProjectIsTwoLettersAsInTheDrawer() {
    #expect(WidgetText.letters(dir: "/Users/max/brain-memory") == "BM")
    #expect(WidgetText.letters(dir: "/Users/max/blimp") == "BL")
}

@Test func aWorkingRowsTimeIsATimerUnderAnHourThenHoursThenDays() {
    let now = 1_800_000_000_000.0
    #expect(WidgetText.elapsed(since: now - 59 * 60_000, now: now) == nil)
    #expect(WidgetText.elapsed(since: now - 60 * 60_000, now: now) == "1h")
    #expect(WidgetText.elapsed(since: now - 23 * 3_600_000 - 59 * 60_000, now: now) == "23h")
    #expect(WidgetText.elapsed(since: now - 50 * 3_600_000, now: now) == "2d")
}

@Test func aRowsLinkOpensItsSessionAndOtherLinksOpenNone() {
    let url = WidgetLink.url(session: "blimp-demo-chat")
    #expect(url.absoluteString == "blimp://open?session=blimp-demo-chat")
    #expect(WidgetLink.session(url) == "blimp-demo-chat")
    #expect(WidgetLink.session(WidgetLink.app) == nil)
    #expect(WidgetLink.session(URL(string: "blimp://open?session=")!) == nil)
    #expect(WidgetLink.session(URL(string: "blimp://pair?url=x&token=y")!) == nil)
    #expect(WidgetLink.session(URL(string: "https://example.com/open?session=x")!) == nil)
}

@Test func theSharedFilesGoThereAndBackAndAMissingOneReadsAsNone() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("widgets-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let files = WidgetShared.files(in: dir)
    #expect(files.server.lastPathComponent == "server.json")
    #expect(files.kept.lastPathComponent == "kept.json")
    #expect(WidgetShared.read(WidgetShared.Server.self, from: files.server) == nil)
    let server = WidgetShared.Server(url: URL(string: "https://box.tail1234.ts.net:7425")!, key: "abc")
    try WidgetShared.write(server, to: files.server)
    #expect(WidgetShared.read(WidgetShared.Server.self, from: files.server) == server)
    let summary = WidgetSummary(at: 1, counts: counts, rows: [WidgetSummary.Row(session: "a", dir: "/u/blimp", title: "A", state: .new, since: 1)])
    let kept = WidgetShared.Kept(summary: summary, pushToken: "ab")
    try WidgetShared.write(kept, to: files.kept)
    #expect(WidgetShared.read(WidgetShared.Kept.self, from: files.kept) == kept)
    #expect(WidgetShared.group == "group.dev.blimp.phone")
}
