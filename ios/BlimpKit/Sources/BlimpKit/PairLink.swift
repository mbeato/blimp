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
              token.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
        else { return nil }
        var s = raw
        while s.hasSuffix("/") { s.removeLast() }
        guard let url = URL(string: s), let host = url.host, !host.isEmpty else { return nil }
        // Plain http only for the SSH-forward development setup; everything else must be https.
        let ok = url.scheme == "https" || (url.scheme == "http" && (host == "127.0.0.1" || host == "localhost"))
        return ok ? ServerLink(url: url, token: token) : nil
    }
}
