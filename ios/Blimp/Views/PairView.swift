// First launch, or after blimpd refuses the token: paste the blimp:// link that `blimpd pair` prints.
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
                    Button {
                        Task { await connect() }
                    } label: {
                        if busy { ProgressView() } else { Text("Connect") }
                    }
                    .disabled(busy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                } footer: {
                    Text("On your server, run blimpd pair.\nCopy the blimp:// link it prints and paste it here.")
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
            self.error = "Can't reach the server"
        }
    }
}
