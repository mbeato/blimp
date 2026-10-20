// First launch, or after blimpd refuses the token: paste the blimp:// link (ios/README.md says how to make it).
import BlimpKit
import SwiftUI

struct PairView: View {
    @Environment(Store.self) private var store
    @State private var text = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Paste the blimp:// link", text: $text, axis: .vertical)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .accessibilityIdentifier("pairField")
                    Button {
                        Task { await connect() }
                    } label: {
                        if busy { ProgressView() } else { Text("Connect") }
                    }
                    .disabled(busy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("connectButton")
                } footer: {
                    Text("Paste the blimp:// link from ios/README.md, with your server's token in it.")
                }
                if let message = error ?? (store.connection == .unauthorized ? "blimpd didn't accept the token" : nil) {
                    Section {
                        Text(message).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Connect")
        }
    }

    private func connect() async {
        error = nil
        guard let link = ServerLink.parse(text) else {
            error = "That isn't a blimp link"
            return
        }
        busy = true
        defer { busy = false }
        do {
            try await store.pair(link)
        } catch APIError.unauthorized {
            error = "blimpd didn't accept the token"
        } catch APIError.server(let message) {
            error = message
        } catch is KeychainError {
            error = "Couldn't save the link on this iPhone"
        } catch {
            self.error = Store.words(for: error)
        }
    }
}
