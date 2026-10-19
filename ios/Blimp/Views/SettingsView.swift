// Settings: which server this phone is paired with, and sign out. (Voice settings come with the voice task.)
import SwiftUI

struct SettingsView: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    Text(store.server?.url.absoluteString ?? "Not paired").textSelection(.enabled)
                }
                Section {
                    Button("Sign out", role: .destructive) {
                        store.signOut()
                        dismiss()
                    }
                } footer: {
                    Text("Forgets this server on this phone. The token stays valid on the server.")
                }
            }
            .navigationTitle("Settings")
            .toolbar { Button("Done") { dismiss() } }
        }
    }
}
