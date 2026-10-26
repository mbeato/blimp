// The feed screen's state (FeedView): this visit's feed, loaded once as it opens, so the cards seen stay in the list
// to swipe back to; the saved cards, newest first; and the seen ids not sent yet, kept across visits while offline
// and sent first when the feed opens again.
import BlimpKit
import Foundation
import Observation

@Observable @MainActor
final class FeedModel {
    private(set) var feed: Feed?
    /// Why it couldn't load, while nothing has loaded.
    private(set) var failed: String?
    /// Newest saved first.
    private(set) var saved: [FeedCard] = []
    @ObservationIgnored private var seen = FeedSeen()
    private static var unsent: Set<String> = []

    func load(_ api: API?) async {
        guard let api else { return }
        await send(api)
        do {
            let f = try await api.feed()
            feed = f
            saved = f.saved
            failed = nil
        } catch {
            if feed == nil { failed = Store.words(for: error) }
        }
    }

    func isSaved(_ id: String) -> Bool { saved.contains { $0.id == id } }

    /// The card on screen now (nil: the caught-up card).
    func show(_ id: String?, api: API?) {
        if let gone = seen.show(id, at: .now) { mark(gone, api) }
    }

    /// The feed is closing.
    func close(api: API?) {
        if let gone = seen.leave(at: .now) { mark(gone, api) }
    }

    /// Saved goes to the top of Saved at once; if blimpd can't be told, it goes back as it was.
    func toggleSave(_ card: FeedCard, api: API?) async {
        guard let api else { return }
        let was = saved
        let save = !isSaved(card.id)
        if save { saved.insert(card, at: 0) } else { saved.removeAll { $0.id == card.id } }
        do { try await api.feedSaved(id: card.id, saved: save) } catch { saved = was }
    }

    private func mark(_ id: String, _ api: API?) {
        Self.unsent.insert(id)
        guard let api else { return }
        Task { await send(api) }
    }

    private func send(_ api: API) async {
        while !Self.unsent.isEmpty {
            let ids = Array(Self.unsent.prefix(500))
            do {
                try await api.feedSeen(ids: ids)
            } catch APIError.server {
                // blimpd refused them (a card id it doesn't take): sending them again would fail the same way.
            } catch {
                return // offline or the like: they wait for the next one, or the next open
            }
            Self.unsent.subtract(ids)
        }
    }
}
