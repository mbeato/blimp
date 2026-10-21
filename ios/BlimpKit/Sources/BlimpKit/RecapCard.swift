// When the return card ("where was I?") shows by itself: a Claude session's chat opens, and the phone hadn't
// shown it for an hour or more (or never). The Mac's rule (app/src/lib/recap.ts). The card is blimpd's
// Recap (GET /sessions/<name>/recap?min=3: only for a session with 3 prompts or more); any error shows
// nothing. When each chat was last on screen is kept on the phone, by a key the app picks (the session's name).
import Foundation

public enum RecapCard {
    /// Away this long or more, the card shows.
    public static let away: Double = 60 * 60_000
    /// Asked for on its own, a card needs this many prompts in the session (the recap's `min`).
    public static let autoMin = 3
    /// A chat not on screen for this long is forgotten.
    static let keep: Double = 30 * 24 * 60 * 60_000

    /// Whether opening the chat now shows the card. lastShown: when it was last on screen (ms), nil for never.
    public static func due(lastShown: Double?, now: Double) -> Bool {
        guard let lastShown else { return true }
        return now - lastShown >= away
    }

    /// last, with `shown` on screen until now; ones not on screen for a month are dropped.
    public static func markShown(_ last: [String: Double], _ shown: [String], now: Double) -> [String: Double] {
        var out = last.filter { now - $0.value < keep }
        for k in shown { out[k] = now }
        return out
    }
}
