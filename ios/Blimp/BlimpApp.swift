// The app's entry: Pair until a server is saved (or after blimpd refuses the token), else the sessions.
import BlimpKit
import SwiftUI

@main
struct BlimpApp: App {
    @State private var store = Store()

    var body: some Scene {
        WindowGroup {
            Root().environment(store)
        }
    }
}

private struct Root: View {
    @Environment(Store.self) private var store

    var body: some View {
        Group {
            if store.server == nil || store.connection == .unauthorized {
                PairView()
            } else {
                HomeView()
            }
        }
        .onReturnFromBackground { store.reconnectNow() }
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
