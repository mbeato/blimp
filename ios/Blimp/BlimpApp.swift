// The app's entry: Pair until a server is saved (or after blimpd refuses the token), else the sessions.
// A saved server that can't be read yet (the phone still locked) shows the lock cover, never Pair. The lock
// covers the sessions without ending them, and unlocking keeps the link that's up.
import BlimpKit
import SwiftUI
import UIKit

@main
struct BlimpApp: App {
    @State private var store = Store()
    @State private var lock = Lock()
    /// iOS's notification side (Push.swift): the device token and what a tapped notification opens.
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    /// The UI tests launch it with `-noAnimations YES`: every tap then settles without waiting out a transition.
    private static let noAnimations = UserDefaults.standard.bool(forKey: "noAnimations")

    init() {
        if Self.noAnimations { UIView.setAnimationsEnabled(false) }
    }

    var body: some Scene {
        WindowGroup {
            Root().environment(store).environment(lock)
                .transaction { if Self.noAnimations { $0.animation = nil; $0.disablesAnimations = true } }
        }
    }
}

private struct Root: View {
    @Environment(Store.self) private var store
    @Environment(Lock.self) private var lock
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if store.waitingForKeychain {
                LockedView()
            } else if store.server == nil || store.connection == .unauthorized {
                PairView()
            } else {
                // Kept alive under the lock, so unlocking lands on the same chat, scrolled where it was, with the
                // words still in the box. Hidden from VoiceOver (and the UI tests) while covered: .accessibilityHidden
                // alone missed the parts UIKit hosts (the navigation bar, the chat), so it's also see-through, which
                // UIKit skips too (nothing changes on screen: the cover is opaque), and the cover is modal.
                HomeView().accessibilityHidden(covered).opacity(covered ? 0 : 1).environment(\.covered, covered)
            }
        }
        .overlay { if covered { LockedView() } }
        .onReturnFromBackground { store.reconnectNow() }
        // Again once a Keychain that couldn't be read at launch has been read: a saved server then asks for Face ID.
        .task(id: store.waitingForKeychain) {
            guard !store.waitingForKeychain else { return }
            if store.server == nil { lock.startUnlocked() } else { await lock.unlock() }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { store.loadServer() }
            lock.scenePhaseChanged(phase, paired: store.server != nil)
        }
        // Nothing is read aloud in the background, behind the lock cover, or while locked.
        .onChange(of: scenePhase == .active && !lock.locked, initial: true) { _, open in Speaker.shared.allowed = open }
        // Notifications: iOS's question and the device token each time the app is online and unlocked (not over
        // the lock or Face ID), and the token again whenever iOS gives a new one.
        .task(id: store.connection == .online && !lock.locked) {
            if store.connection == .online && !lock.locked { store.startPush() }
        }
        .onChange(of: Push.shared.token) { _, token in
            if let token { store.sendPushToken(token) }
        }
    }

    /// The cover is up while locked, and in the background, where the app switcher takes its snapshot. Not
    /// while only inactive (Control Center, a notification, the Face ID sheet, the mic alert): the screen stays.
    private var covered: Bool {
        store.server != nil && !store.waitingForKeychain && (lock.locked || scenePhase == .background)
    }
}

extension EnvironmentValues {
    /// The lock cover is up: what's under it stays alive, but is hidden from VoiceOver and marks nothing read.
    @Entry var covered = false
}

extension View {
    /// Runs `action` when the app becomes active again after being in the background. Not after it
    /// was only inactive (Control Center, a system alert, Face ID): the links are still fine then.
    func onReturnFromBackground(_ action: @escaping () -> Void) -> some View {
        modifier(ReturnFromBackground(action: action))
    }
}

private struct ReturnFromBackground: ViewModifier {
    let action: () -> Void
    @Environment(\.scenePhase) private var phase
    @State private var wasInBackground = false

    func body(content: Content) -> some View {
        content.onChange(of: phase) { _, new in
            if new == .background {
                wasInBackground = true
            } else if new == .active, wasInBackground {
                wasInBackground = false
                action()
            }
        }
    }
}

/// Where you were, for a cold launch: the open chat, saved as you open it and as the app leaves. A cold
/// launch reopens it with the first session list, if it was used in the last hour and still runs, and
/// nothing else was opened first (nor the drawer: tapping Inbox or the project already showing opens nothing new).
struct KeepsPlace: ViewModifier {
    @Binding var opened: Opened
    let drawer: Bool
    @Environment(Store.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @State private var tried = false

    private static let key = "lastChat"

    func body(content: Content) -> some View {
        content
            .onChange(of: store.sessions) { _, sessions in
                guard !tried else { return }
                tried = true
                guard opened == .inbox, let name = Self.saved?.reopen(listed: sessions.map(\.name), now: Self.now),
                      let session = sessions.first(where: { $0.name == name }) else { return }
                store.dir = session.dir
                opened = .session(name)
            }
            .onChange(of: opened) { _, now in
                tried = true
                Self.save(now)
            }
            // A project picked before the list came: that's where you want to be.
            .onChange(of: store.dir) { tried = true }
            .onChange(of: drawer) { tried = true }
            .onChange(of: scenePhase) { _, phase in if phase == .background { Self.save(opened) } }
    }

    private static var now: Double { Date.now.timeIntervalSince1970 * 1000 }

    private static var saved: LastChat? {
        UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode(LastChat.self, from: $0) }
    }

    private static func save(_ opened: Opened) {
        if case .session(let name) = opened, let data = try? JSONEncoder().encode(LastChat(name: name, at: now)) {
            UserDefaults.standard.set(data, forKey: key)
        } else {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }
}
