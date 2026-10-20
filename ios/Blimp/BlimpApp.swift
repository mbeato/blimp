// The app's entry: Pair until a server is saved (or after blimpd refuses the token), else the sessions.
// A saved server that can't be read yet (the phone still locked) shows the lock cover, never Pair.
import BlimpKit
import SwiftUI

@main
struct BlimpApp: App {
    @State private var store = Store()
    @State private var lock = Lock()

    var body: some Scene {
        WindowGroup {
            Root().environment(store).environment(lock)
        }
    }
}

private struct Root: View {
    @Environment(Store.self) private var store
    @Environment(Lock.self) private var lock
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if store.waitingForKeychain || (lock.locked && store.server != nil) {
                LockedView()
            } else if store.server == nil || store.connection == .unauthorized {
                PairView()
            } else {
                HomeView()
            }
        }
        // the app switcher's snapshot is taken as the app goes inactive: show no session titles
        .overlay { if scenePhase != .active && store.server != nil { LockedView() } }
        .onReturnFromBackground { store.reconnectNow() }
        .onChange(of: lock.locked) { _, locked in if !locked { store.reconnectNow() } }
        // Again once a Keychain that couldn't be read at launch has been read: a saved server then asks for Face ID.
        .task(id: store.waitingForKeychain) {
            guard !store.waitingForKeychain else { return }
            if store.server == nil { lock.startUnlocked() } else { await lock.unlock() }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { store.loadServer() }
            lock.scenePhaseChanged(phase, paired: store.server != nil)
        }
        // Nothing is read aloud in the background, behind the lock cover, or while locked.
        .onChange(of: scenePhase == .active && !lock.locked, initial: true) { _, open in Speaker.shared.allowed = open }
    }
}

extension View {
    /// Runs `action` when the app becomes active again after being in the background. Not after it
    /// was only inactive (Control Center, a system alert, Face ID): the links are still fine then.
    func onReturnFromBackground(_ action: @escaping () -> Void) -> some View {
        modifier(ReturnFromBackground(action: action))
    }
}

private struct ReturnFromBackground: ViewModifier {
    let action: () -> Void
    @Environment(\.scenePhase) private var phase
    @State private var wasInBackground = false

    func body(content: Content) -> some View {
        content.onChange(of: phase) { _, new in
            if new == .background {
                wasInBackground = true
            } else if new == .active, wasInBackground {
                wasInBackground = false
                action()
            }
        }
    }
}
