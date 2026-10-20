// First launch, or after blimpd refuses the token: scan the QR code `blimpd pair` shows, or paste its
// blimp:// link (ios/README.md says how). Both go through the same check and save.
import AVFoundation
import BlimpKit
import SwiftUI
import VisionKit

struct PairView: View {
    @Environment(Store.self) private var store
    @State private var text = ""
    @State private var error: String?
    @State private var busy = false
    @State private var scanning = false

    // No camera (the simulator) or no scanner on this iPhone: no Scan button. The camera can still be
    // undecided: isAvailable is false until it's allowed, so the button asks first (scan()).
    private var canScan: Bool {
        DataScannerViewController.isSupported
            && (DataScannerViewController.isAvailable || AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined)
    }

    var body: some View {
        NavigationStack {
            Form {
                if canScan {
                    Section {
                        Button {
                            Task { await scan() }
                        } label: {
                            Label("Scan QR code", systemImage: "qrcode.viewfinder")
                        }
                        .disabled(busy)
                        .accessibilityIdentifier("scanButton")
                    } footer: {
                        Text("Run blimpd pair on your server and scan the code it shows.")
                    }
                }
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
                    Text("Or paste the blimp:// link that blimpd pair prints.")
                }
                if let message = error ?? (store.connection == .unauthorized ? "blimpd didn't accept the token" : nil) {
                    Section {
                        Text(message).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Connect")
            .sheet(isPresented: $scanning) {
                NavigationStack {
                    QRScanner { scanned in
                        scanning = false
                        text = scanned
                        Task { await connect() }
                    }
                    .ignoresSafeArea()
                    .navigationTitle("Scan the code")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel") { scanning = false }
                        }
                    }
                }
            }
        }
    }

    private func scan() async {
        error = nil
        if AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
            _ = await AVCaptureDevice.requestAccess(for: .video)
        }
        if DataScannerViewController.isAvailable {
            scanning = true
        } else {
            error = "blimp can't use the camera. Allow it in Settings, or paste the link."
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
