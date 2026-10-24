import Testing
@testable import BlimpKit

@Test func tailscaleAddressesAreTheOnesIn100Point64Slash10() {
    #expect(Tailnet.contains("100.64.0.1"))
    #expect(Tailnet.contains("100.101.102.103"))
    #expect(Tailnet.contains("100.127.255.255"))
    #expect(!Tailnet.contains("100.63.255.255"))
    #expect(!Tailnet.contains("100.128.0.1"))
    #expect(!Tailnet.contains("192.168.1.5"))
    #expect(!Tailnet.contains("100.64.0"))
    #expect(!Tailnet.contains("mac.tail1234.ts.net"))
}

@Test func aServerIsOnTheTailnetByItsAddressOrItsTsNetName() {
    #expect(Tailnet.isTailnetHost("100.70.1.2"))
    #expect(Tailnet.isTailnetHost("mac.tail1234.ts.net"))
    #expect(Tailnet.isTailnetHost("Mac.Tail1234.TS.NET."))
    #expect(!Tailnet.isTailnetHost("127.0.0.1"))
    #expect(!Tailnet.isTailnetHost("192.168.1.5"))
}

@Test func tailscaleLooksOffWhenTheServerIsOnTheTailnetAndNoTunnelHasATailnetAddress() {
    let wifi = NetInterface(name: "en0", address: "192.168.1.20")
    let tunnel = NetInterface(name: "utun4", address: "100.88.1.2")
    // Some carriers hand out 100.64/10 addresses too: only a tunnel's counts.
    let carrier = NetInterface(name: "pdp_ip0", address: "100.65.3.4")
    #expect(Tailnet.looksOff(server: "100.70.1.2", interfaces: [wifi, carrier]))
    #expect(!Tailnet.looksOff(server: "100.70.1.2", interfaces: [wifi, tunnel]))
    #expect(Tailnet.looksOff(server: "mac.tail1234.ts.net", interfaces: []))
    // A server reached some other way says nothing about Tailscale.
    #expect(!Tailnet.looksOff(server: "127.0.0.1", interfaces: [wifi]))
    #expect(!Tailnet.looksOff(server: nil, interfaces: []))
}

@Test func thisMachinesAddressesIncludeLoopback() {
    #expect(Interfaces.ipv4().contains { $0.address == "127.0.0.1" })
}

@Test func theBarSaysConnectingTheFirstTimeAndReconnectingAfter() {
    #expect(LinkText.connecting(everOnline: false) == "Connecting…")
    #expect(LinkText.connecting(everOnline: true) == "Reconnecting…")
    #expect(LinkText.offline(tailnetOff: true) == "Tailscale looks off")
    #expect(LinkText.offline(tailnetOff: false) == "Can't reach the server")
}

@Test func theBarSaysWhenTheServerIsOlderThanThisApp() {
    #expect(LinkText.behind(server: "0.3.4", app: "0.3.6") == "The server runs an older blimp (0.3.4). Update it from the Mac.")
    #expect(LinkText.behind(server: "0.2.16", app: "0.3.0") != nil)
    #expect(LinkText.behind(server: "0.3.6-rc.1", app: "0.3.6") != nil)
    #expect(LinkText.behind(server: "dev", app: "0.3.6") != nil)
    // The same or newer says nothing, and numbers compare as numbers.
    #expect(LinkText.behind(server: "0.3.6", app: "0.3.6") == nil)
    #expect(LinkText.behind(server: "v0.3.6", app: "0.3.6") == nil)
    #expect(LinkText.behind(server: "0.3.7", app: "0.3.6") == nil)
    #expect(LinkText.behind(server: "0.3.10", app: "0.3.9") == nil)
    #expect(LinkText.behind(server: "0.3.6", app: "0.3.6-rc.2") == nil)
    // Not known yet: nothing.
    #expect(LinkText.behind(server: nil, app: "0.3.6") == nil)
    #expect(LinkText.behind(server: "0.3.4", app: nil) == nil)
}
