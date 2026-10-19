// The app's entry: Pair until a server is saved (or after blimpd refuses the token), else the sessions.
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
            if lock.locked && store.server != nil {
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
        .task { if store.server == nil { lock.startUnlocked() } else { await lock.unlock() } }
        .onChange(of: scenePhase) { _, phase in lock.scenePhaseChanged(phase) }
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
