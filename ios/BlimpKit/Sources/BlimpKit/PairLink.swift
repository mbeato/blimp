// The pairing link blimpd shows as a QR code: blimp://pair?url=<server>&token=<64 hex>.
import Foundation

public struct ServerLink: Codable, Equatable, Sendable {
    public let url: URL
    public let token: String

    public init(url: URL, token: String) { self.url = url; self.token = token }

    public static func parse(_ text: String) -> ServerLink? {
        guard let c = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              c.scheme == "blimp", c.host == "pair",
              let raw = c.queryItems?.first(where: { $0.name == "url" })?.value,
              let token = c.queryItems?.first(where: { $0.name == "token" })?.value,
              // exact check: a regex `$` would let a trailing newline through
              token.count == 64, token.allSatisfy({ "0123456789abcdef".contains($0) })
        else { return nil }
        var s = raw
        while s.hasSuffix("/") { s.removeLast() }
        guard let url = URL(string: s), let host = url.host, !host.isEmpty else { return nil }
        // Plain http only for the SSH-forward development setup; everything else must be https.
        let scheme = url.scheme?.lowercased(), h = host.lowercased()
        let ok = scheme == "https" || (scheme == "http" && (h == "127.0.0.1" || h == "localhost"))
        return ok ? ServerLink(url: url, token: token) : nil
    }
}
