// Why blimpd can't be reached, in words: most often the phone's Tailscale is off. The server is on the
// tailnet (a 100.64.0.0/10 address or a .ts.net name), and none of the phone's tunnels (utun) has a tailnet
// address. A 100.64/10 address elsewhere doesn't count: some carriers give phones those too.
import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

public struct NetInterface: Equatable, Sendable {
    public let name: String
    public let address: String

    public init(name: String, address: String) {
        self.name = name
        self.address = address
    }
}

public enum Tailnet {
    /// An IPv4 address Tailscale gives out: 100.64.0.0 to 100.127.255.255.
    public static func contains(_ address: String) -> Bool {
        let parts = address.split(separator: ".", omittingEmptySubsequences: false)
        let bytes = parts.compactMap { UInt8($0) }
        guard parts.count == 4, bytes.count == 4 else { return false }
        return bytes[0] == 100 && (64...127).contains(bytes[1])
    }

    public static func isTailnetHost(_ host: String) -> Bool {
        var name = host.lowercased()
        if name.hasSuffix(".") { name.removeLast() }
        return contains(name) || name.hasSuffix(".ts.net")
    }

    /// The tunnel is up: some utun interface has a tailnet address.
    public static func up(_ interfaces: [NetInterface]) -> Bool {
        interfaces.contains { $0.name.hasPrefix("utun") && contains($0.address) }
    }

    public static func looksOff(server host: String?, interfaces: [NetInterface]) -> Bool {
        guard let host, isTailnetHost(host) else { return false }
        return !up(interfaces)
    }
}

public enum Interfaces {
    /// This device's IPv4 addresses, by interface.
    public static func ipv4() -> [NetInterface] {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else { return [] }
        defer { freeifaddrs(head) }
        var out: [NetInterface] = []
        for p in sequence(first: first, next: { $0.pointee.ifa_next }) {
            guard let sa = p.pointee.ifa_addr, sa.pointee.sa_family == sa_family_t(AF_INET) else { continue }
            let raw = sa.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr.s_addr }
            // s_addr is in network order, so its bytes in memory are the address's, first to last.
            let bytes = withUnsafeBytes(of: raw) { Array($0) }
            out.append(NetInterface(name: String(cString: p.pointee.ifa_name), address: bytes.map(String.init).joined(separator: ".")))
        }
        return out
    }
}

/// The connection bar's words.
public enum LinkText {
    public static func connecting(everOnline: Bool) -> String { everOnline ? "Reconnecting…" : "Connecting…" }
    public static func offline(tailnetOff: Bool) -> String { tailnetOff ? "Tailscale looks off" : "Can't reach the server" }

    /// Online, with a blimpd older than this app (the two are released together): what this app asks of it may
    /// be missing (Hide on 0.3.4 was a 404), so say so instead of each thing failing on its own.
    public static func behind(server: String?, app: String?) -> String? {
        guard let server, let app, versionParts(server).lexicographicallyPrecedes(versionParts(app)) else { return nil }
        return "The server runs an older blimp (\(server)). Update it from the Mac."
    }

    /// As the Mac app reads versions: 0.3.6 → [0, 3, 6, max], 0.3.6-rc.2 → [0, 3, 6, 2] (a release candidate comes
    /// before its release). Anything unreadable counts as 0.0.0.
    static func versionParts(_ v: String) -> [Int] {
        let unreadable = [0, 0, 0, Int.max]
        var s = v.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("v") { s.removeFirst() }
        let halves = s.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        let nums = halves[0].split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
        guard nums.count == 3, let a = nums[0], let b = nums[1], let c = nums[2] else { return unreadable }
        guard halves.count == 2 else { return [a, b, c, Int.max] }
        guard halves[1].hasPrefix("rc."), let rc = Int(halves[1].dropFirst(3)) else { return unreadable }
        return [a, b, c, rc]
    }
}
