// The Face ID lock. Locked at launch and after more than five minutes in the background.
// `.deviceOwnerAuthentication` falls back to the passcode when Face ID fails.
import LocalAuthentication
import Observation
import SwiftUI

@Observable @MainActor
final class Lock {
    private(set) var locked = true
    private var backgroundedAt: ContinuousClock.Instant?
    /// Plain reason shown under Unlock after a failure other than a cancel.
    private(set) var note: String?
    private var asking = false
    /// The UI tests shorten it with the launch argument `-lockGrace <seconds>`.
    static var grace: Duration {
        let seconds = UserDefaults.standard.double(forKey: "lockGrace")
        return seconds > 0 ? .seconds(seconds) : .seconds(300)
    }

    /// First launch with nothing paired: nothing to protect and no Face ID ask. Once paired,
    /// the usual rules apply (the 5-minute rule, and the ask at the next launch).
    func startUnlocked() { locked = false }

    func unlock() async {
        guard locked, !asking else { return }
        asking = true
        defer { asking = false }
        let context = LAContext()
        var error: NSError?
        // No passcode on the device: anyone can open the phone anyway, so don't lock.
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            if (error as? LAError)?.code == .passcodeNotSet {
                locked = false
            } else {
                note = "This phone can't check it's you right now."
            }
            return
        }
        note = nil
        do {
            if try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock blimp") {
                locked = false
            }
        } catch {
            // cancelled or failed: stay locked; the Unlock button asks again
        }
    }

    /// Locks when the app comes back after more than five minutes away, and asks once then; not
    /// while nothing is paired (there's nothing to protect). It never asks again by itself: the sheet
    /// makes the scene inactive, and a cancel returns to .active, so asking there would loop. After a
    /// cancel, the Unlock button is the way. The lock is already on in the inactive step on the way back,
    /// so the chat never shows uncovered before the ask.
    func scenePhaseChanged(_ phase: ScenePhase, paired: Bool) {
        switch phase {
        case .background:
            if backgroundedAt == nil { backgroundedAt = .now }
        case .active:
            if due(paired: paired) {
                locked = true
                Task { await unlock() }
            }
            backgroundedAt = nil
        default:
            if phase == .inactive, due(paired: paired) { locked = true }
        }
    }

    /// Back after more than the grace time in the background.
    private func due(paired: Bool) -> Bool {
        guard paired, let at = backgroundedAt else { return false }
        return ContinuousClock.now - at > Self.grace
    }
}

/// What shows while locked: nothing about the sessions, only the way to unlock.
struct LockedView: View {
    @Environment(Lock.self) private var lock

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "lock").font(.largeTitle).foregroundStyle(.secondary)
            Button("Unlock") { Task { await lock.unlock() } }
                .buttonStyle(.borderedProminent)
                .opacity(lock.locked ? 1 : 0)
            if let note = lock.note, lock.locked { Text(note).font(.footnote).foregroundStyle(.secondary) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
        // Over a live Home, .accessibilityHidden doesn't reach Home's UIKit-hosted parts (the navigation bar,
        // the chat), so the cover itself shuts VoiceOver and the UI tests out of everything beside it.
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
    }
}
