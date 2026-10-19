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
        if store.server == nil || store.connection == .unauthorized {
            PairView()
        } else {
            SessionsPlaceholder()
        }
    }
}

// Stands in for Home until the Home screen is built.
private struct SessionsPlaceholder: View {
    @Environment(Store.self) private var store

    var body: some View {
        NavigationStack {
            List(store.sessions) { session in
                Text(session.title)
            }
            .overlay {
                if store.sessions.isEmpty { Text(status).foregroundStyle(.secondary) }
            }
            .navigationTitle("blimp")
            .toolbar {
                Button("Sign out") { store.signOut() }
            }
        }
    }

    private var status: String {
        switch store.connection {
        case .connecting: "Connecting…"
        case .online: "No sessions running."
        case .offline(let reason): reason
        case .unauthorized: "blimpd didn't accept the token"
        }
    }
}
