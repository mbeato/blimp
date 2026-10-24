// Phone notifications (docs/superpowers/specs/2026-10-20-phone-push-design.md): iOS's question (asked once; iOS
// remembers), the device token for blimpd (Store sends it: POST /push/device), and the session a tapped one opens.
// While the app is in front none shows: Home's own banner and haptic already tell of a wait.
import BlimpKit
import Observation
import UIKit
import UserNotifications

@MainActor @Observable
final class Push {
    static let shared = Push()

    /// The device token as hex, once iOS has given it.
    var token: String?
    /// A tapped notification's session, for Home to open; Home sets it back.
    var open: String?
    /// iOS has notifications off for blimp: its question was answered no, or they were turned off in iOS Settings.
    var denied = false

    /// Off in Settings. The UI tests launch with -pushOff YES, so iOS's question doesn't cover their screens.
    static var off: Bool {
        get { UserDefaults.standard.bool(forKey: "pushOff") }
        set { UserDefaults.standard.set(newValue, forKey: "pushOff") }
    }

    /// Which of Apple's services the token is for: blimpd sends to that one.
    #if DEBUG
    static let env = "development"
    #else
    static let env = "production"
    #endif

    /// Asks iOS (only the first time shows anything), then asks for the device token, which comes to AppDelegate.
    func start() async {
        let granted = await Self.ask()
        denied = !granted
        if granted { UIApplication.shared.registerForRemoteNotifications() }
    }

    nonisolated private static func ask() async -> Bool {
        (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    /// Opening a chat takes its notifications off the lock screen and out of Notification Center (blimpd sends the
    /// session's name as each one's thread).
    nonisolated static func clear(session: String) async {
        let center = UNUserNotificationCenter.current()
        let ids = await center.deliveredNotifications().filter { $0.request.content.threadIdentifier == session }.map(\.request.identifier)
        center.removeDeliveredNotifications(withIdentifiers: ids)
    }
}

/// iOS's side: the device token, and the notification delegate (what shows in front, what a tap opens).
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // Set before launch ends, so a tap that launched the app still reaches it.
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Push.shared.token = DeviceToken.hex(deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("push: no device token: \(error.localizedDescription)")
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        []
    }

    /// A tap: that session's chat, behind the lock as at any launch.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let note = PushNote(response.notification.request.content.userInfo) else { return }
        await MainActor.run { Push.shared.open = note.session }
    }
}
