// The phone's widgets (docs/superpowers/specs/2026-10-25-phone-widgets-design.md): what GET /widget answers
// (src/widget.ts), the words and symbols they show, the link a row opens, and the two files the app and the widgets
// share in their App Group: server.json, which only the app writes, and kept.json, which only the widgets write.
import Foundation

public struct WidgetSummary: Codable, Sendable, Equatable {
    public enum State: String, Codable, Sendable { case needs, new, working }

    public struct Counts: Codable, Sendable, Equatable {
        public let needs: Int
        public let new: Int
        public let working: Int

        public init(needs: Int, new: Int, working: Int) {
            self.needs = needs
            self.new = new
            self.working = working
        }
    }

    public struct Row: Codable, Sendable, Equatable, Identifiable {
        public let session: String
        public let dir: String
        public let title: String
        public let state: State
        /// Milliseconds: when it started waiting or working.
        public let since: Double

        public var id: String { session }

        public init(session: String, dir: String, title: String, state: State, since: Double) {
            self.session = session
            self.dir = dir
            self.title = title
            self.state = state
            self.since = since
        }
    }

    /// Milliseconds: when blimpd made it.
    public let at: Double
    public let counts: Counts
    /// Needs you, then new, then working; at most 9.
    public let rows: [Row]
    /// Milliseconds: when the last session finished. nil: none has.
    public let lastFinished: Double?

    public init(at: Double, counts: Counts, rows: [Row], lastFinished: Double? = nil) {
        self.at = at
        self.counts = counts
        self.rows = rows
        self.lastFinished = lastFinished
    }
}

public enum WidgetText {
    public static func symbol(_ state: WidgetSummary.State) -> String {
        switch state {
        case .needs: "?"
        case .new: "✓"
        case .working: "●"
        }
    }

    public static let quiet = "All quiet"

    /// Nothing needs you, is new or works.
    public static func isQuiet(_ c: WidgetSummary.Counts) -> Bool { c.needs == 0 && c.new == 0 && c.working == 0 }

    /// The lock screen's line above the clock, "? 1 · ✓ 2 · ● 3", a count of 0 left out; with none, "All quiet".
    public static func line(_ c: WidgetSummary.Counts) -> String {
        let all: [(WidgetSummary.State, Int)] = [(.needs, c.needs), (.new, c.new), (.working, c.working)]
        let parts = all.filter { $0.1 > 0 }.map { "\(symbol($0.0)) \($0.1)" }
        return parts.isEmpty ? quiet : parts.joined(separator: " · ")
    }

    /// The small widget's lines, each count even at 0.
    public static func countLines(_ c: WidgetSummary.Counts) -> [String] {
        ["\(symbol(.needs)) \(c.needs) needs you", "\(symbol(.new)) \(c.new) new", "\(symbol(.working)) \(c.working) working"]
    }

    /// The round lock screen widget: the needs-you count with ?, else the working count with ●, else ✓ alone.
    public static func circle(_ c: WidgetSummary.Counts) -> (symbol: String, count: Int?) {
        if c.needs > 0 { return (symbol(.needs), c.needs) }
        if c.working > 0 { return (symbol(.working), c.working) }
        return (symbol(.new), nil)
    }

    /// A row's project, as the drawer's column has it: two letters from its folder's name.
    public static func letters(dir: String) -> String {
        Strip.letters(URL(fileURLWithPath: dir).lastPathComponent)
    }

    /// A working row's time from an hour on: "3h", then "2d" from 24 hours. Under an hour nil: the widget shows a timer
    /// that counts up by itself. Both in milliseconds.
    public static func elapsed(since: Double, now: Double) -> String? {
        let minutes = Int((now - since) / 60_000)
        if minutes < 60 { return nil }
        let hours = minutes / 60
        return hours < 24 ? "\(hours)h" : "\(hours / 24)d"
    }
}

/// What a widget's tap opens: a session's chat (blimp://open?session=<name>), or just the app (blimp://open).
public enum WidgetLink {
    public static let app = URL(string: "blimp://open")!

    public static func url(session: String) -> URL {
        var c = URLComponents()
        c.scheme = "blimp"
        c.host = "open"
        c.queryItems = [URLQueryItem(name: "session", value: session)]
        return c.url!
    }

    /// The session a link opens; nil for blimp://open alone and for any other link.
    public static func session(_ url: URL) -> String? {
        guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false), c.scheme == "blimp", c.host == "open",
              let name = c.queryItems?.first(where: { $0.name == "session" })?.value, !name.isEmpty
        else { return nil }
        return name
    }
}

public enum WidgetShared {
    /// The App Group the app and the widgets share.
    public static let group = "group.dev.blimp.phone"

    /// What only the app writes: the server's address and the widget key. key nil: blimpd is too old to have one.
    public struct Server: Codable, Sendable, Equatable {
        public let url: URL
        public let key: String?

        public init(url: URL, key: String?) {
            self.url = url
            self.key = key
        }
    }

    /// What only the widgets write: their last summary, and their push token for the app to send to blimpd.
    public struct Kept: Codable, Sendable, Equatable {
        public var summary: WidgetSummary?
        public var pushToken: String?

        public init(summary: WidgetSummary? = nil, pushToken: String? = nil) {
            self.summary = summary
            self.pushToken = pushToken
        }
    }

    /// The two files in the App Group's folder.
    public static func files(in container: URL) -> (server: URL, kept: URL) {
        (container.appendingPathComponent("server.json"), container.appendingPathComponent("kept.json"))
    }

    /// nil: missing or unreadable.
    public static func read<T: Decodable>(_ type: T.Type, from file: URL) -> T? {
        guard let data = try? Data(contentsOf: file) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    /// Whole or not at all: a temporary file, then a rename.
    public static func write<T: Encodable>(_ value: T, to file: URL) throws {
        try JSONEncoder().encode(value).write(to: file, options: .atomic)
    }
}
