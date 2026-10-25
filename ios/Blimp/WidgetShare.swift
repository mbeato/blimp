// The widgets' side, in the app (docs/superpowers/specs/2026-10-25-phone-widgets-design.md): each time the app is
// online, the server's address and the widget key go in the App Group's server.json for the widgets to read GET /widget
// with, a widget push token the widgets left in kept.json goes to blimpd (each time, as the phone's own token does:
// blimpd forgets it on pair --revoke), and the widgets reload. Signing out takes the server away from them.
import BlimpKit
import Foundation
import WidgetKit

@MainActor
enum WidgetShare {
    private static var files: (server: URL, kept: URL)? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: WidgetShared.group).map(WidgetShared.files(in:))
    }

    /// An older blimpd has no widget key ("not found"): server.json then has none, and the widgets say to update it.
    /// Any other failure (offline) leaves server.json as it was. isCurrent: the app is still paired with api's server;
    /// once it isn't (signed out while this waited), nothing is written or sent.
    static func update(api: API, isCurrent: () -> Bool) async {
        guard let files else { return }
        do {
            let key = try await api.widgetKey()
            guard isCurrent() else { return }
            try? WidgetShared.write(WidgetShared.Server(url: api.server.url, key: key), to: files.server)
        } catch APIError.server(let message) where message == "not found" {
            guard isCurrent() else { return }
            try? WidgetShared.write(WidgetShared.Server(url: api.server.url, key: nil), to: files.server)
        } catch {}
        guard isCurrent() else { return }
        if let token = WidgetShared.read(WidgetShared.Kept.self, from: files.kept)?.pushToken {
            try? await api.registerWidget(token: token, env: Push.env)
        }
        reload()
    }

    /// Signing out: blimpd stops pinging the widgets (the old server still answers this), and they forget the server.
    static func forget(api: API?) {
        if let api, let files, let token = WidgetShared.read(WidgetShared.Kept.self, from: files.kept)?.pushToken {
            Task { try? await api.unregisterWidget(token: token) }
        }
        if let files { try? FileManager.default.removeItem(at: files.server) }
        reload()
    }

    static func reload() {
        WidgetCenter.shared.reloadAllTimelines()
    }
}
