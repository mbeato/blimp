// The mic for a box that only takes words (the new-chat box): what's heard goes after what's already typed,
// and stays in the box to read, edit and Send. Nothing is ever sent by letting go.
import BlimpKit
import Observation

@Observable @MainActor
final class Dictation {
    private let listener = Listener()
    private(set) var on = false
    /// The last press's stop() is still finishing: a new press waits for it.
    private(set) var stopping = false
    /// Why it couldn't listen, in words.
    private(set) var note: String?
    private var base = ""
    /// Bumped by each press, so a late failure of an earlier one changes nothing.
    private var round = 0

    var listening: Bool { on || stopping }
    var preparing: Bool { listener.preparing }
    /// The box while listening: what was in it, then the words heard so far.
    var live: String { DraftText.joined(base, listener.partial) }

    /// Starts listening; `text` is what's in the box now.
    func down(text: String, vocabulary: [String]) {
        guard !on, !stopping else { return }
        Speaker.shared.hushed = true
        note = nil
        on = true
        round += 1
        let mine = round
        base = text
        Task {
            do {
                try await listener.start(vocabulary: vocabulary)
            } catch is CancellationError {
                // let go before it was ready
            } catch {
                note = (error as? ListenError) == .denied
                    ? "Turn on Microphone and Speech Recognition for blimp in Settings > Apps > blimp."
                    : "This iPhone can't listen right now."
                guard on, mine == round else { return }
                on = false
                Speaker.shared.hushed = false
            }
        }
    }

    /// Stops listening; the box's text with the words heard, or nil if it wasn't listening.
    func up() async -> String? {
        guard on else { return nil }
        on = false
        stopping = true
        let heard = await listener.stop()
        stopping = false
        Speaker.shared.hushed = false
        return DraftText.joined(base, heard)
    }
}
