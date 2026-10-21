// How full a Claude session's context window is (Session.context), and what a session that handed off
// says (Session.handoff), with the Mac's rules (app/src/lib/handoff.ts).
import Foundation

public struct ContextMeter: Equatable, Sendable {
    /// Rounded, as shown: 62.
    public let percent: Int
    /// How much of the gauge to fill, 0 to 1.
    public let fraction: Double
    /// From 80%: time to hand off, so red.
    public let high: Bool
    /// "Context 62% (620k of 1M tokens)"
    public let label: String
}

public enum ContextText {
    /// The gauge shows from half full (not rounded: 49.6% doesn't show).
    public static let shownFrom = 0.5

    /// 950, 620k, 1M, 1.5M.
    public static func tokens(_ n: Int) -> String {
        if n >= 999_500 {
            let m = (Double(n) / 100_000).rounded() / 10
            return m == m.rounded() ? "\(Int(m))M" : "\(m)M"
        }
        if n >= 1000 { return "\(Int((Double(n) / 1000).rounded()))k" }
        return String(n)
    }

    /// nil below half full, or without a size.
    public static func meter(_ c: ContextWindow?) -> ContextMeter? {
        guard let c, c.limit > 0 else { return nil }
        let used = Double(c.used) / Double(c.limit)
        guard used >= shownFrom else { return nil }
        let percent = Int((used * 100).rounded())
        return ContextMeter(percent: percent, fraction: min(1, used), high: percent >= 80,
                            label: "Context \(percent)% (\(tokens(c.used)) of \(tokens(c.limit)) tokens)")
    }
}

public enum HandoffText {
    /// What the row says instead of its state: "Writing handoff" while Claude writes it, "Handed off" once the
    /// new session started and this one isn't working. A question for you still says so (nil).
    public static func words(_ s: Session) -> String? {
        guard let h = s.handoff, s.state != .waiting else { return nil }
        if h.state == .writing { return "Writing handoff" }
        if h.state == .started, s.state != .working { return "Handed off" }
        return nil
    }

    /// The words when POST /sessions/<name>/handoff failed with blimpd's `message`. A blimpd from before
    /// handoffs answers the route with a bare "not found" (a missing session says "no session named …").
    public static func failure(_ message: String) -> String {
        message == "not found" ? "This server's blimpd is too old to continue in a new session. Update it first."
            : "Couldn't continue in a new session: \(message)"
    }
}
