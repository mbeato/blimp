import Foundation
import Testing
@testable import BlimpKit

let tok = String(repeating: "ab", count: 32)

@Test func parsesGoodLinks() {
    let a = ServerLink.parse("  blimp://pair?url=https%3A%2F%2Fclaude1.tail1234.ts.net%2F&token=\(tok)\n")
    #expect(a == ServerLink(url: URL(string: "https://claude1.tail1234.ts.net")!, token: tok))
    #expect(ServerLink.parse("blimp://pair?url=http%3A%2F%2F127.0.0.1%3A7425&token=\(tok)")?.url.absoluteString == "http://127.0.0.1:7425")
}

@Test func refusesBadLinks() {
    #expect(ServerLink.parse("blimp://pair?url=http%3A%2F%2Fexample.com&token=\(tok)") == nil)  // plain http off-device
    #expect(ServerLink.parse("blimp://pair?url=https%3A%2F%2Fx.ts.net&token=short") == nil)
    #expect(ServerLink.parse("https://x.ts.net") == nil)
    #expect(ServerLink.parse("blimp://pair?token=\(tok)") == nil)
    #expect(ServerLink.parse("blimp://pair?url=ftp%3A%2F%2Fx&token=\(tok)") == nil)
}

@Test func refusesATokenWithATrailingNewline() {
    #expect(ServerLink.parse("blimp://pair?url=https%3A%2F%2Fx.ts.net&token=\(tok)%0A") == nil)
}

@Test func schemeAndHostAreCaseInsensitive() {
    #expect(ServerLink.parse("blimp://pair?url=HTTPS%3A%2F%2FX.ts.net&token=\(tok)") != nil)
    #expect(ServerLink.parse("blimp://pair?url=http%3A%2F%2FLOCALHOST%3A7425&token=\(tok)") != nil)
}
