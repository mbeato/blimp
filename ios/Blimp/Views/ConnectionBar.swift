// The slim bar at the top while the events link isn't up: "Connecting…" the first time, "Reconnecting…"
// after, why it can't reach blimpd, and when that's most likely Tailscale being off, a button to open it.
import BlimpKit
import SwiftUI

struct ConnectionBar: View {
    @Environment(Store.self) private var store
    @Environment(\.openURL) private var openURL

    /// Tailscale's own link; unchecked on a device, so a refusal falls back to its App Store page.
    private static let tailscale = URL(string: "tailscale://")!
    private static let appStore = URL(string: "https://apps.apple.com/app/id1470499037")!

    var body: some View {
        if let text {
            HStack(spacing: 10) {
                Text(text).font(.footnote)
                if offline && store.tailnetOff {
                    Button("Open Tailscale", action: openTailscale)
                        .font(.footnote.weight(.semibold))
                        .accessibilityIdentifier("openTailscale")
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .background(.bar)
        }
    }

    private var offline: Bool {
        if case .offline = store.connection { return true }
        return false
    }

    private var text: String? {
        switch store.connection {
        case .online, .unauthorized: nil
        case .connecting: LinkText.connecting(everOnline: store.everOnline)
        case .offline(let reason): reason
        }
    }

    private func openTailscale() {
        let fallback = openURL, page = Self.appStore
        openURL(Self.tailscale) { opened in
            if !opened { fallback(page) }
        }
    }
}
