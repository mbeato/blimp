// The phone's live panel (docs/superpowers/specs/2026-10-26-phone-live-activity-design.md): what blimpd sends as its
// Live Activity's content-state (src/live.ts), which iOS decodes with these types' default coding (so times are
// milliseconds as numbers, never Date, whose default coding is seconds since 2001), and the words and link the panel
// uses. The Live Activity type itself needs ActivityKit, so it's in ios/Live/, outside BlimpKit.
import Foundation

public struct LiveState: Codable, Sendable, Hashable {
    public struct Steps: Codable, Sendable, Hashable {
        public let done: Int
        public let total: Int
        /// The step in progress, in Claude's words; nil when none is.
        public let current: String?

        public init(done: Int, total: Int, current: String? = nil) {
            self.done = done
            self.total = total
            self.current = current
        }
    }

    /// The turn started from the phone.
    public struct Turn: Codable, Sendable, Hashable {
        public let session: String
        public let dir: String
        public let title: String
        /// .needs while it waits on you, else .working.
        public let state: WidgetSummary.State
        /// Milliseconds: when its prompt went in.
        public let since: Double
        /// nil: Claude keeps no task list for it.
        public let steps: Steps?

        public init(session: String, dir: String, title: String, state: WidgetSummary.State, since: Double, steps: Steps? = nil) {
            self.session = session
            self.dir = dir
            self.title = title
            self.state = state
            self.since = since
            self.steps = steps
        }
    }

    public let turn: Turn?
    /// The widgets' rows (needs you, new, working), the turn's own left out: blimpd sends 3 under a turn, 4 without.
    public let rows: [WidgetSummary.Row]
    public let counts: WidgetSummary.Counts

    public init(turn: Turn? = nil, rows: [WidgetSummary.Row], counts: WidgetSummary.Counts) {
        self.turn = turn
        self.rows = rows
        self.counts = counts
    }
}

public enum LiveText {
    /// "Step 4 of 7": the one after those done; all done, the last.
    public static func step(_ s: LiveState.Steps) -> String {
        "Step \(min(s.done + 1, s.total)) of \(s.total)"
    }

    /// The bar: the share done, 0 to 1.
    public static func progress(_ s: LiveState.Steps) -> Double {
        s.total > 0 ? min(1, Double(s.done) / Double(s.total)) : 0
    }

    /// The Dynamic Island's two sides: "?2" and "●3".
    public static func compact(_ c: WidgetSummary.Counts) -> (leading: String, trailing: String) {
        ("\(WidgetText.symbol(.needs))\(c.needs)", "\(WidgetText.symbol(.working))\(c.working)")
    }

    /// Its smallest form: ? when something needs you, else ●.
    public static func minimal(_ c: WidgetSummary.Counts) -> String {
        WidgetText.symbol(c.needs > 0 ? .needs : .working)
    }

    /// A tap: the turn's chat, else the oldest that needs you, else the app.
    public static func link(_ l: LiveState) -> URL {
        if let turn = l.turn { return WidgetLink.url(session: turn.session) }
        return l.rows.first(where: { $0.state == .needs }).map { WidgetLink.url(session: $0.session) } ?? WidgetLink.app
    }
}
