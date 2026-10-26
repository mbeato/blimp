import Foundation
import Testing
@testable import BlimpKit

// The phone's feed: GET /feed's cards, a card's words, the caught-up card, Comments' threads, the links that open, the
// seen rule, and the events' feed message.

private let feedJSON = #"""
{"on":true,"cards":[
 {"id":"aaaaaaaaaaaaaaaa","url":"https://bun.com/blog/bun-v2.0","title":"Bun 2.0","sources":[{"kind":"hn","name":"Hacker News","score":412,"comments":318,"thread":"https://news.ycombinator.com/item?id=1"},{"kind":"reddit","name":"r/programming","score":230,"comments":12,"thread":"https://www.reddit.com/r/programming/comments/abc/"}],"at":1800000000000,"image":"https://bun.com/og.png","summary":"Bun talks to Postgres now.","interest":true},
 {"id":"bbbbbbbbbbbbbbbb","title":"no url, so this app can't read it"},
 {"id":"cccccccccccccccc","url":"https://github.com/oven-sh/bun","title":"oven-sh/bun","sources":[{"kind":"github","name":"GitHub","score":1234}],"at":1800000000000,"interest":false}],
 "saved":[],"runs":{"Hacker News":{"at":1800000000000,"ok":true},"Reddit":{"at":1800000000000,"ok":false,"reason":"no key"}},"next":1800003600000}
"""#

private func feed() throws -> Feed { try JSONDecoder().decode(Feed.self, from: Data(feedJSON.utf8)) }

@Test func theFeedDecodesAndOneBadCardDoesntBlankIt() throws {
    let f = try feed()
    #expect(f.on)
    #expect(f.cards.map(\.id) == ["aaaaaaaaaaaaaaaa", "cccccccccccccccc"])
    #expect(f.cards[1].summary == nil)
    #expect(f.runs["Reddit"]?.reason == "no key")
    #expect(f.next == 1_800_003_600_000)
}

@Test func theSourceLineHasTheScoreInWordsOrEachSourcesBareScore() throws {
    let f = try feed()
    let now = Date(timeIntervalSince1970: 1_800_000_000 + 2 * 3600 + 5)
    #expect(FeedText.sourceLine(f.cards[0], now: now) == "Hacker News 412 · r/programming 230 · 2h")
    #expect(FeedText.sourceLine(f.cards[1], now: now) == "GitHub · 1,234 stars today · 2h")
    #expect(FeedText.age(1_800_000_000_000, now: Date(timeIntervalSince1970: 1_800_000_030)) == "now")
    #expect(FeedText.age(1_800_000_000_000, now: Date(timeIntervalSince1970: 1_800_000_000 + 45 * 60)) == "45m")
    #expect(FeedText.age(1_800_000_000_000, now: Date(timeIntervalSince1970: 1_800_000_000 + 3 * 86400)) == "3d")
    #expect(FeedText.grouped(1_234_567) == "1,234,567")
    #expect(FeedText.grouped(412) == "412")
}

@Test func commentsOpensHNsAndRedditsThreadsAndCountsBoth() throws {
    let f = try feed()
    #expect(FeedText.threads(f.cards[0]).map(\.name) == ["Hacker News", "r/programming"])
    #expect(FeedText.commentsLabel(f.cards[0]) == "Comments (330)")
    #expect(FeedText.threads(f.cards[1]).isEmpty)
    #expect(FeedText.commentsLabel(f.cards[1]) == "Comments")
}

@Test func onlyWebLinksOpen() {
    #expect(FeedText.link("https://bun.com/x") != nil)
    #expect(FeedText.link("http://bun.com") != nil)
    #expect(FeedText.link("javascript:alert(1)") == nil)
    #expect(FeedText.link("blimp://open") == nil)
    #expect(FeedText.link("not a link") == nil)
}

@Test func theCaughtUpCardSaysWhenTheNextUpdateIsAndWhichSourcesFailed() throws {
    let f = try feed()
    let time: (Date) -> String = { "t\(Int($0.timeIntervalSince1970))" }
    #expect(FeedText.nextLine(f.next, time: time) == "Next update around t1800003600")
    #expect(FeedText.failures(f.runs, time: time) == ["Reddit didn't load at t1800000000: no key"])
    #expect(FeedText.failures([:], time: time).isEmpty)
}

@Test func aCardIsSeenAfterASecondOnScreenOnceTheScreenMovesOn() {
    var s = FeedSeen()
    let t0 = Date(timeIntervalSince1970: 100)
    #expect(s.show("a", at: t0) == nil)
    #expect(s.show("b", at: t0.addingTimeInterval(1.2)) == "a")
    #expect(s.show("c", at: t0.addingTimeInterval(1.5)) == nil) // b was on screen for 0.3 s
    #expect(s.show(nil, at: t0.addingTimeInterval(3)) == "c") // the caught-up card
    #expect(s.leave(at: t0.addingTimeInterval(9)) == nil) // no card on screen
    #expect(s.show("d", at: t0.addingTimeInterval(10)) == nil)
    #expect(s.leave(at: t0.addingTimeInterval(11)) == "d")
    #expect(s.leave(at: t0.addingTimeInterval(12)) == nil)
}

@Test func theEventsFeedMessage() {
    #expect(EventsMessage.decode(Data(#"{"type":"feed","on":true,"unseen":12}"#.utf8)) == .feed(on: true, unseen: 12))
    #expect(EventsMessage.decode(Data(#"{"type":"feed","on":false}"#.utf8)) == .feed(on: false, unseen: 0))
    #expect(EventsMessage.decode(Data(#"{"type":"feed"}"#.utf8)) == .other)
}
