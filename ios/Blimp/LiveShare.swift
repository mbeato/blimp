// The live panel's side in the app (docs/superpowers/specs/2026-10-26-phone-live-activity-design.md, "How"): iOS's
// push-to-start token, and each panel's own push token, go to blimpd (POST /push/live) with the widget key from the
// App Group's server.json (WidgetShare.swift). Unlike the Keychain, that file can be read while the phone is locked,
// which is when iOS wakes the app to hand over a panel blimpd started. With the app open, blimpd asks it to start the
// panel itself (the events socket's "live" message), so no banner shows. One panel: a new one ends any other (blimpd's
// and the app's can cross), and the ask is ignored while one is up. A panel that ends or is dismissed on the phone,
// Settings off, or signing out: blimpd forgets the token (DELETE /push/live), and off or out also ends the panel.
import ActivityKit
import BlimpKit
import Foundation
import UIKit

@MainActor
enum LiveShare {
    typealias Panel = Activity<BlimpActivityAttributes>

    /// Off in Settings ("Live panel on the lock screen" is on by default).
    static var off: Bool {
        get { UserDefaults.standard.bool(forKey: "liveOff") }
        set { UserDefaults.standard.set(newValue, forKey: "liveOff") }
    }

    private static var observing = false
    /// The panels whose push tokens and ending are watched, by id.
    private static var watched: Set<String> = []
    /// Each watched panel's newest push token, to tell blimpd when it ends.
    private static var tokens: [String: String] = [:]

    /// The panels showing or about to: one that is ending (blimpd's end, or the 7 h 45 min restart's) is not one.
    private static var current: [Panel] {
        Panel.activities.filter { $0.activityState == .active || $0.activityState == .stale }
    }

    /// At launch, also when iOS launches the app in the background for a panel blimpd started: the push-to-start token,
    /// new panels, and each panel's token, as iOS gives them.
    static func observe() {
        guard !observing else { return }
        observing = true
        Task {
            for await data in Panel.pushToStartTokenUpdates {
                if !off { send("POST", kind: "start", token: hex(data)) }
            }
        }
        Task {
            for await activity in Panel.activityUpdates {
                // Off in Settings: a panel that came anyway (a push-to-start sent before blimpd heard) ends at once.
                if off {
                    await end(id: activity.id)
                    continue
                }
                // A panel not seen before is the newest: the others go (the app's own is watched from start() on, so
                // it never ends the one blimpd pushed). It is watched first, so its own token is kept even if an end
                // below is slow.
                let isNew = !watched.contains(activity.id)
                watch(activity)
                if isNew {
                    await end(except: activity.id, liveOnly: true)
                }
            }
        }
        for activity in current { watch(activity) }
    }

    private static func watch(_ activity: Panel) {
        guard watched.insert(activity.id).inserted else { return }
        Task {
            for await data in activity.pushTokenUpdates {
                tokens[activity.id] = hex(data)
                if !off { send("POST", kind: "activity", token: hex(data)) }
            }
        }
        // Ended or dismissed (by blimpd, the person or this app): blimpd forgets its token.
        Task {
            for await state in activity.activityStateUpdates where state == .ended || state == .dismissed {
                if let token = tokens.removeValue(forKey: activity.id) { send("DELETE", kind: "activity", token: token) }
                watched.remove(activity.id)
                return
            }
        }
    }

    /// blimpd asked: the app is open, so it starts the panel (no banner). Not when it's off here or in iOS Settings,
    /// when the app isn't in front after all (blimpd then pushes it 10 s on), or when one is up already (a panel that
    /// is ending, at a restart, doesn't count: the new one is started).
    static func start(_ state: LiveState) {
        guard !off, ActivityAuthorizationInfo().areActivitiesEnabled, UIApplication.shared.applicationState == .active,
              current.isEmpty
        else { return }
        let content = ActivityContent(state: state, staleDate: nil)
        if let activity = try? Panel.request(attributes: BlimpActivityAttributes(), content: content, pushType: .token) {
            watch(activity)
        }
    }

    /// Each time the app is online, the tokens again: blimpd forgets them on pair --revoke, and one sent while offline
    /// was lost. With the switch off, the DELETEs again and the panels ended, in case the first were lost (as
    /// Store.startPush does for notifications).
    static func update() {
        guard !off else {
            stop()
            return
        }
        if let data = Panel.pushToStartToken { send("POST", kind: "start", token: hex(data)) }
        for activity in current {
            if let data = activity.pushToken { send("POST", kind: "activity", token: hex(data)) }
        }
    }

    /// Off in Settings, or signing out: blimpd forgets this phone's panel tokens, and the panel ends.
    static func stop() {
        if let data = Panel.pushToStartToken { send("DELETE", kind: "start", token: hex(data)) }
        for activity in Panel.activities {
            if let data = activity.pushToken { send("DELETE", kind: "activity", token: hex(data)) }
            tokens[activity.id] = nil
        }
        Task { await end() }
    }

    /// Ends panels by id, looking them up here: an `Activity` isn't Sendable, so none is passed into an async call from
    /// the main actor. With `id`, that panel; otherwise every panel but `except` (only the showing ones with `liveOnly`).
    private nonisolated static func end(id: String? = nil, except: String? = nil, liveOnly: Bool = false) async {
        for panel in Panel.activities {
            if let id, panel.id != id { continue }
            if panel.id == except { continue }
            if liveOnly, panel.activityState != .active, panel.activityState != .stale { continue }
            await panel.end(nil, dismissalPolicy: .immediate)
        }
    }

    private struct Body: Encodable {
        let kind: String
        let token: String
        let env: String
    }

    /// With the server and widget key in the App Group, read now (signing out removes them right after). Neither yet
    /// (not online since pairing), or no key (an older blimpd): nothing is sent. A failure is dropped: update() sends
    /// again the next time the app is online.
    private static func send(_ method: String, kind: String, token: String) {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: WidgetShared.group),
              let server = WidgetShared.read(WidgetShared.Server.self, from: WidgetShared.files(in: container).server),
              let key = server.key,
              var c = URLComponents(url: server.url, resolvingAgainstBaseURL: false)
        else { return }
        c.path += "/push/live"
        guard let url = c.url else { return }
        var req = URLRequest(url: url, timeoutInterval: 20)
        req.httpMethod = method
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONEncoder().encode(Body(kind: kind, token: token, env: Push.env))
        let request = req
        Task { _ = try? await URLSession.shared.data(for: request) }
    }

    private static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }
}
