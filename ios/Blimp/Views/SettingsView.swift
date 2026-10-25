// Settings: which server this phone is paired with, notifications, the voice replies are read in, and sign out.
import AVFoundation
import SwiftUI

struct SettingsView: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var voices: [AVSpeechSynthesisVoice] = []
    /// The picked voice's identifier; nil is the best one installed.
    @State private var chosen = UserDefaults.standard.string(forKey: Speaker.voiceKey)
    /// Notifications from this server (Push.off is the opposite).
    @State private var notify = !Push.off

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    Text(store.server?.url.absoluteString ?? "Not paired").textSelection(.enabled)
                }
                Section {
                    Toggle("Notifications", isOn: $notify)
                        .tint(.green)
                        .accessibilityIdentifier("pushSwitch")
                        .onChange(of: notify) { _, on in
                            Push.off = !on
                            if on { store.startPush() } else { store.stopPush() }
                        }
                } footer: {
                    Text(Push.shared.denied
                        ? "iOS has them off for blimp: Settings > Notifications > blimp."
                        : "When a session waits on you or a long turn ends, even with blimp closed. The server needs its push key first (blimpd push-key).")
                }
                Section {
                    voiceRow("Automatic", detail: "The best one installed", id: nil)
                    ForEach(voices, id: \.identifier) { voice in
                        voiceRow(voice.name, detail: Self.quality(voice), id: voice.identifier)
                    }
                } header: {
                    Text("Voice")
                } footer: {
                    Text("Better voices: Settings > Accessibility > Spoken Content > Voices, then download a Premium voice.")
                }
                Section {
                    Button("Sign out", role: .destructive) {
                        store.signOut()
                        dismiss()
                    }
                } footer: {
                    Text("Forgets this server on this phone and stops its notifications. The token stays valid on the server.")
                }
            }
            .navigationTitle("Settings")
            .toolbar { Button("Done") { dismiss() } }
            .onAppear { voices = Speaker.installed }
            .onDisappear { Speaker.shared.stop() }
        }
    }

    private func voiceRow(_ name: String, detail: String, id: String?) -> some View {
        Button {
            chosen = id
            if let id { UserDefaults.standard.set(id, forKey: Speaker.voiceKey) } else { UserDefaults.standard.removeObject(forKey: Speaker.voiceKey) }
            Speaker.shared.stop()
            Speaker.shared.say("This is how replies will sound.", id: "sample")
        } label: {
            HStack {
                VStack(alignment: .leading) {
                    Text(name).foregroundStyle(.primary)
                    Text(detail).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if chosen == id { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
            }
        }
    }

    private static func quality(_ voice: AVSpeechSynthesisVoice) -> String {
        switch voice.quality {
        case .premium: "Premium"
        case .enhanced: "Enhanced"
        default: "Standard"
        }
    }
}
