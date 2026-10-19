// The Face ID lock. Locked at launch and after more than five minutes in the background.
// `.deviceOwnerAuthentication` falls back to the passcode when Face ID fails.
import LocalAuthentication
import Observation
import SwiftUI

@Observable @MainActor
final class Lock {
    private(set) var locked = true
    private var backgroundedAt: TimeInterval?
    /// Plain reason shown under Unlock after a failure other than a cancel.
    private(set) var note: String?
    private var asking = false
    static let grace: TimeInterval = 300

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

    /// Locks when the app comes back after more than five minutes away, and asks once then.
    /// It never asks again by itself: the sheet makes the scene inactive, and a cancel returns to
    /// .active, so asking there would loop. After a cancel, the Unlock button is the way.
    func scenePhaseChanged(_ phase: ScenePhase) {
        switch phase {
        case .background:
            if backgroundedAt == nil { backgroundedAt = ProcessInfo.processInfo.systemUptime }
        case .active:
            if let at = backgroundedAt, ProcessInfo.processInfo.systemUptime - at > Self.grace {
                locked = true
                Task { await unlock() }
            }
            backgroundedAt = nil
        default: break
        }
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
    }
}
