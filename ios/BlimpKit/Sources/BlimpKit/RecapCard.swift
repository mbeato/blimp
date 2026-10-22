// When the return card ("where was I?") comes by itself: a Claude session's chat opens, and the phone hadn't
// shown it for an hour or more (or never). The Mac's rule (app/src/lib/recap.ts). The card is blimpd's
// Recap (GET /sessions/<name>/recap?min=3: only for a session with 3 prompts or more); any error shows
// nothing. On the phone it waits in the chat's drawer from the right, with a dot on its button; it never opens
// by itself. When each chat was last on screen is kept on the phone, by a key the app picks (the session's name).
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

    /// A swipe that pulls the drawer out starts this close to the chat's right edge (points).
    public static let edge: Double = 32

    /// A swipe in the chat pulls the recap drawer out: it starts near the right edge and goes left, mostly
    /// sideways (as the left drawer's swipe right), so scrolling never does. x: where it started; dx, dy: how far.
    public static func pulls(from x: Double, width: Double, dx: Double, dy: Double) -> Bool {
        x >= width - edge && dx < 0 && abs(dx) > abs(dy) * 1.5
    }

    /// Let go past 120 points, or flung left: it opens; else back closed. predicted: where the swipe would end.
    public static func opens(dx: Double, predicted: Double) -> Bool {
        dx < -120 || predicted < -260
    }
}

/// A part of the return card, with its heading. The Mac's rule (app/src/lib/recap.ts `recapSections`).
public struct RecapSection: Sendable, Equatable {
    public enum Kind: String, Sendable, Equatable {
        case stuck, doing, next, done, open
    }

    public let kind: Kind
    public let lines: [String]

    public var title: String {
        switch kind {
        case .stuck: "Stuck"
        case .doing: "In progress"
        case .next: "Next"
        case .done: "Done"
        case .open: "Open"
        }
    }
}

extension Recap {
    /// The card's parts, with an empty one left out: Stuck first, as it needs you, then In progress, Next and Done.
    /// From a blimpd before 0.3.1 (no doing, stuck or next): Done and Open, as it showed them.
    public var sections: [RecapSection] {
        let all: [(RecapSection.Kind, [String])]
        if let doing, let stuck, let next {
            all = [(.stuck, stuck), (.doing, doing), (.next, next), (.done, done)]
        } else {
            all = [(.done, done), (.open, open)]
        }
        return all.filter { !$0.1.isEmpty }.map { RecapSection(kind: $0.0, lines: $0.1) }
    }
}
