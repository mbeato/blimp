// The Face ID lock. Locked at launch and after more than five minutes in the background.
// `.deviceOwnerAuthentication` falls back to the passcode when Face ID fails.
import LocalAuthentication
import Observation
import SwiftUI

@Observable @MainActor
final class Lock {
    private(set) var locked = true
    private var backgroundedAt: Date?
    private var asking = false
    static let grace: TimeInterval = 300

    func unlock() async {
        guard locked, !asking else { return }
        asking = true
        defer { asking = false }
        let context = LAContext()
        var error: NSError?
        // No passcode on the device: nothing to ask, so don't lock the owner out.
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            locked = false
            return
        }
        do {
            if try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock blimp") {
                locked = false
            }
        } catch {
            // cancelled or failed: stay locked; the Unlock button asks again
        }
    }

    /// Locks when the app comes back after more than five minutes away; asks right away.
    func scenePhaseChanged(_ phase: ScenePhase) {
        switch phase {
        case .background:
            if backgroundedAt == nil { backgroundedAt = Date() }
        case .active:
            if let at = backgroundedAt, Date().timeIntervalSince(at) > Self.grace { locked = true }
            backgroundedAt = nil
            if locked { Task { await unlock() } }
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
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
    }
}
