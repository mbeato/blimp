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
            HomeView()
        }
    }
}
