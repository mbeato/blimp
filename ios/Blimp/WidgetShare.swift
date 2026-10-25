// The widgets' side, in the app (docs/superpowers/specs/2026-10-25-phone-widgets-design.md): each time the app is
// online, the server's address and the widget key go in the App Group's server.json for the widgets to read GET /widget
// with, a widget push token the widgets left in kept.json goes to blimpd once, and the widgets reload. Signing out
// takes the server away from them.
import BlimpKit
import Foundation
import WidgetKit

@MainActor
enum WidgetShare {
    private static var files: (server: URL, kept: URL)? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: WidgetShared.group).map(WidgetShared.files(in:))
    }

    /// The widget push token blimpd has been sent.
    private static var sentToken: String? {
        get { UserDefaults.standard.string(forKey: "widgetTokenSent") }
        set { UserDefaults.standard.set(newValue, forKey: "widgetTokenSent") }
    }

    /// An older blimpd has no widget key ("not found"): server.json then has none, and the widgets say to update it.
    /// Any other failure (offline) leaves server.json as it was.
    static func update(api: API) async {
        guard let files else { return }
        do {
            let key = try await api.widgetKey()
            try? WidgetShared.write(WidgetShared.Server(url: api.server.url, key: key), to: files.server)
        } catch APIError.server(let message) where message == "not found" {
            try? WidgetShared.write(WidgetShared.Server(url: api.server.url, key: nil), to: files.server)
        } catch {}
        if let token = WidgetShared.read(WidgetShared.Kept.self, from: files.kept)?.pushToken, token != sentToken,
           (try? await api.registerWidget(token: token, env: Push.env)) != nil {
            sentToken = token
        }
        reload()
    }

    /// Signing out: blimpd stops pinging the widgets (the old server still answers this), and they forget the server.
    static func forget(api: API?) {
        if let api, let token = sentToken { Task { try? await api.unregisterWidget(token: token) } }
        sentToken = nil
        if let files { try? FileManager.default.removeItem(at: files.server) }
        reload()
    }

    static func reload() {
        WidgetCenter.shared.reloadAllTimelines()
    }
}
