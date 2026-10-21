// A project's paragraph (blimpd's digests.ts, docs/DESIGN.md "Digests"): where the work in its Claude sessions
// stands, written by Haiku, on top of the phone's inbox. "[some words](n)" in it is a link to sessions[n - 1].
import Foundation

public struct Digest: Codable, Sendable, Equatable {
    public let text: String
    /// The session names its links point at: link n at sessions[n - 1].
    public let sessions: [String]
    /// Milliseconds: when it was written.
    public let at: Double

    public init(text: String, sessions: [String], at: Double) {
        self.text = text
        self.sessions = sessions
        self.at = at
    }

    public struct Part: Equatable, Sendable {
        public let text: String
        /// The session a link's words open; nil for plain text (and a link to a number it doesn't have).
        public let session: String?
        public init(text: String, session: String?) {
            self.text = text
            self.session = session
        }
    }

    /// The text in order: plain runs, and each link's words with its session.
    public var parts: [Part] {
        var out: [Part] = []
        var plain = ""
        var rest = Substring(text)
        func flush() {
            if !plain.isEmpty { out.append(Part(text: plain, session: nil)) }
            plain = ""
        }
        while let open = rest.firstIndex(of: "[") {
            plain += rest[..<open]
            let after = rest[rest.index(after: open)...]
            // "[words](digits)", words without brackets.
            if let close = after.firstIndex(of: "]"), !after[..<close].isEmpty, !after[..<close].contains("["),
               after[close...].hasPrefix("]("),
               let end = after[after.index(close, offsetBy: 2)...].firstIndex(of: ")") {
                let digits = after[after.index(close, offsetBy: 2)..<end]
                if !digits.isEmpty, digits.allSatisfy(\.isASCII), let n = Int(digits) {
                    flush()
                    out.append(Part(text: String(after[..<close]), session: n >= 1 && n <= sessions.count ? sessions[n - 1] : nil))
                    rest = after[after.index(after: end)...]
                    continue
                }
            }
            plain += "["
            rest = after
        }
        plain += rest
        flush()
        return out
    }
}

extension EventsMessage {
    // Each folder on its own: one malformed paragraph doesn't drop the others.
    private struct LenientDigest: Decodable {
        let digest: Digest?
        init(from decoder: Decoder) throws { digest = try? Digest(from: decoder) }
    }
    private struct DigestsWire: Decodable { let type: String; let digests: [String: LenientDigest]? }

    /// The paragraphs a "sessions" message carries, by folder (none in any other message).
    public static func digests(_ data: Data) -> [String: Digest] {
        guard let w = try? JSONDecoder().decode(DigestsWire.self, from: data), w.type == "sessions" else { return [:] }
        return (w.digests ?? [:]).compactMapValues(\.digest)
    }
}
