// The widgets (docs/superpowers/specs/2026-10-25-phone-widgets-design.md): every project's sessions that need you, are
// new or are working, on the home screen (small, medium, large) and the lock screen (inline, circular, rectangular).
// They read GET /widget with the widget key the app leaves in the App Group (WidgetShare.swift in the app) whenever iOS
// reloads them: after blimpd's widget push, after 15 minutes, or when the app is online or leaves. Failing that, the
// last summary they had, greyed.
import BlimpKit
import SwiftUI
import WidgetKit

// Not named BlimpWidgets: that's the module's name.
@main
struct BlimpWidgetBundle: WidgetBundle {
    var body: some Widget { SessionsWidget() }
}

struct SessionsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "sessions", provider: Provider()) { entry in
            SessionsView(entry: entry).containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("blimp")
        .description("What needs you, what's new and what's working, in every project.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryInline, .accessoryCircular, .accessoryRectangular])
        .pushHandler(PushHandler.self)
    }
}

struct Entry: TimelineEntry {
    enum Status { case fresh, stale, notSetUp, needsUpdate }
    let date: Date
    /// stale: the last one the widgets had, if any.
    let summary: WidgetSummary?
    let status: Status
}

/// The App Group's two files; nil without the group (a build without its entitlement).
enum Files {
    static var both: (server: URL, kept: URL)? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: WidgetShared.group).map(WidgetShared.files(in:))
    }
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> Entry {
        Entry(date: .now, summary: .sample, status: .fresh)
    }

    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
        if context.isPreview { return completion(placeholder(in: context)) }
        Task { completion(await Self.load()) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        Task {
            let entry = await Self.load()
            completion(Timeline(entries: [entry], policy: .after(Date.now.addingTimeInterval(15 * 60))))
        }
    }

    /// GET /widget with the widget key, kept for next time; failing that, the last one, greyed.
    static func load() async -> Entry {
        guard let files = Files.both, let server = WidgetShared.read(WidgetShared.Server.self, from: files.server) else {
            return Entry(date: .now, summary: nil, status: .notSetUp)
        }
        guard let key = server.key else { return Entry(date: .now, summary: nil, status: .needsUpdate) }
        var kept = WidgetShared.read(WidgetShared.Kept.self, from: files.kept) ?? WidgetShared.Kept()
        guard var c = URLComponents(url: server.url, resolvingAgainstBaseURL: false) else {
            return Entry(date: .now, summary: kept.summary, status: .stale)
        }
        c.path += "/widget"
        guard let url = c.url else { return Entry(date: .now, summary: kept.summary, status: .stale) }
        var req = URLRequest(url: url, timeoutInterval: 10)
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        do {
            let (data, response) = try await URLSession.shared.data(for: req)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            let summary = try JSONDecoder().decode(WidgetSummary.self, from: data)
            kept.summary = summary
            try? WidgetShared.write(kept, to: files.kept)
            return Entry(date: .now, summary: summary, status: .fresh)
        } catch {
            return Entry(date: .now, summary: kept.summary, status: .stale)
        }
    }
}

/// iOS 26's widget push: the token for blimpd's pings goes in kept.json, and the app sends it on (POST /push/widget)
/// the next time it's online.
struct PushHandler: WidgetPushHandler {
    func pushTokenDidChange(_ pushInfo: WidgetPushInfo, widgets: [WidgetInfo]) {
        guard let files = Files.both else { return }
        var kept = WidgetShared.read(WidgetShared.Kept.self, from: files.kept) ?? WidgetShared.Kept()
        kept.pushToken = pushInfo.token.map { String(format: "%02x", $0) }.joined()
        try? WidgetShared.write(kept, to: files.kept)
    }
}

extension WidgetSummary {
    /// The widget gallery's picture.
    static var sample: WidgetSummary {
        let now = Date.now.timeIntervalSince1970 * 1000
        return WidgetSummary(
            at: now,
            counts: Counts(needs: 1, new: 1, working: 2),
            rows: [
                Row(session: "a", dir: "/blimp", title: "Linking Linear cards", state: .needs, since: now - 600_000),
                Row(session: "b", dir: "/blimp", title: "Folder browser", state: .new, since: now - 300_000),
                Row(session: "c", dir: "/blimp", title: "PR overnight fixes", state: .working, since: now - 720_000),
                Row(session: "d", dir: "/brain-memory", title: "Fixing the Slack bot", state: .working, since: now - 7_200_000),
            ])
    }
}
