# Phone notifications, step 2: the iPhone app — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The iPhone app asks for notifications once paired, signs the phone up with blimpd, opens a session's chat when its notification is tapped, and its TestFlight build carries the push entitlement, so `blimpd push-test` and real waits reach Max's phone with the app closed.

**Architecture:** BlimpKit gets the pure parts (reading a notification's data, the device token as hex), tested on Linux. The app gets one new file, `ios/Blimp/Push.swift` (an `@Observable` `Push` model and an `AppDelegate` that is iOS's notification delegate), wired into `BlimpApp`, `Store`, `API`, `HomeView` and `SettingsView`. `project.yml` gets the `aps-environment` entitlement; the TestFlight job gives the unsigned archive an ad-hoc signature with it so the export keeps it. A UI test pushes a notification to the simulator through `ios/e2e/signals.sh` and taps it.

**Tech Stack:** Swift 6.0, SwiftUI, UserNotifications, iOS 26 (deployment target "26.0"), XcodeGen, XCUITest, GitHub Actions (`.github/workflows/ios.yml`).

**Spec:** `docs/superpowers/specs/2026-10-20-phone-push-design.md`, section 2 (the phone registers), section 4's tap and in-app rows, Tests ("App" and "App e2e" rows), and "Order of work" step 2. The Yes/No actions (step 3) and the Mac's `active` (step 4) are later plans.

## Global Constraints

- There is no Swift toolchain on the machine the plan runs on. Swift is verified only in CI, by pushing the branch `phone-push-app`: `kit-linux` runs BlimpKit's tests on Linux, `app` builds the app for the simulator with `SWIFT_TREAT_WARNINGS_AS_ERRORS=YES` (any warning fails), and `app-e2e (a)`/`(b)` run the UI tests on the self-hosted Mac. Write code that compiles under Swift 6 strict concurrency with no warnings.
- Never start a manual iOS workflow run (`gh workflow run iOS`) while another iOS run's e2e is going: two e2e runs collide on the Mac runners' ports. A newer push to the branch cancels the branch's older run by itself.
- What blimpd sends (src/push/payload.ts on main, exact keys): `aps.alert.title`, `aps.alert.body`, `aps.sound`, `aps["thread-id"]` = the session's name, and `aps.category` = `"permission"` only on a permission with buttons; custom keys `session` (string), `kind` (`"ask"` or `"finish"`), and on a permission with buttons only, `at` (number, ms), `yes` `{ pick, label }` and `no` `{ pick, label }`.
- blimpd's routes: `POST /push/device` `{ "token": <lowercase hex>, "env": "development" | "production" }` → 204; `DELETE /push/device` `{ "token" }` → 204; 400 on a bad token or env; an older blimpd answers 404, which the app ignores (no notifications, nothing shown).
- `env` is `"development"` for a Debug build (Xcode, the simulator) and `"production"` for Release (TestFlight). Apple's `BadDeviceToken` for a wrong environment makes blimpd delete the phone, so this must be right.
- Bundle id `dev.blimp.phone`. The UI tests' host folder is `$E2E_DIR` (`/tmp/be-<shard>`); the e2e blimpd's socket is `$E2E_DIR/b/blimpd.sock`, so its phones are in `$E2E_DIR/b/push.json`.
- Comments and UI text: plain English, short sentences, saying why, at the density of the files around them. Commit subjects start with `iPhone: `, `CI: ` or `docs: ` and say what changed in plain words. **Never add a `Co-Authored-By` line or any Claude attribution to a commit.**

## Rulings made while planning

- **While the app is in front, no system notification shows at all.** Home already shows its own banner and haptic for a wait in another session, and the chat on screen shows its own wait; the spec's "one for another session shows as a banner, as the in-app banners do today" is that banner. Cost if wrong: a finish in another session gets only Home's light tick while the app is open.
- **iOS's question is asked only while the app is online and unlocked,** not over the lock cover or Face ID. It's still "after pairing and on every launch" (iOS remembers the answer). Cost if wrong: none seen.
- **Sign out also stops notifications from that server** (`DELETE /push/device`), as the Settings switch does.
- **No Yes/No category is registered in this step.** blimpd's `category: "permission"` then shows no buttons; step 3 registers it.
- **The release build's entitlement:** the TestFlight job archives unsigned, and the export (cloud signing with the App Store Connect key) keeps only the entitlements the archived app's signature lists. Checked in CI on 2026-10-24 (throwaway branch `push-probe`): as is, the exported app had no `aps-environment`; Ad Hoc signing at archive time is refused for the iOS SDK; an ad-hoc `codesign` of the archived app with the entitlements, then the same export, gave `"aps-environment": "production"` and the export succeeded.

## File structure

- Create `ios/BlimpKit/Sources/BlimpKit/PushNote.swift`: `PushNote` (a notification's data) and `DeviceToken` (hex). Pure.
- Create `ios/BlimpKit/Tests/BlimpKitTests/PushNoteTests.swift`.
- Modify `ios/project.yml` (entitlement), `ios/.gitignore` (the generated entitlements file), `.github/workflows/ios.yml` (the TestFlight job's signature; the shard lists).
- Create `ios/Blimp/Push.swift`: `Push` and `AppDelegate`.
- Modify `ios/Blimp/BlimpApp.swift`, `ios/Blimp/Model/Store.swift`, `ios/Blimp/Net/API.swift`, `ios/Blimp/Views/HomeView.swift`, `ios/Blimp/Views/SettingsView.swift`.
- Modify `ios/BlimpUITests/BlimpUITests.swift`, `ios/e2e/signals.sh`; create `ios/e2e/push-demo-chat.json`.
- Docs: `ios/README.md`, `README.md`, `docs/PHONE-CHECKLIST.md`, `docs/SECURITY.md`.

---

### Task 1: A notification's data, and the device token as hex (BlimpKit)

**Files:**
- Create: `ios/BlimpKit/Sources/BlimpKit/PushNote.swift`
- Test: `ios/BlimpKit/Tests/BlimpKitTests/PushNoteTests.swift`

**Interfaces:**
- Produces: `public struct PushNote: Equatable, Sendable` with `public enum Kind: String, Sendable { case ask, finish }`, `public struct Choice: Equatable, Sendable { public let pick: Int; public let label: String; public init(pick: Int, label: String) }`, `public let session: String`, `public let kind: Kind`, `public let at: Double?`, `public let yes: Choice?`, `public let no: Choice?`, `public init?(_ info: [AnyHashable: Any])`; `public enum DeviceToken { public static func hex(_ data: Data) -> String }`.

- [ ] **Step 1: Write the tests** in `ios/BlimpKit/Tests/BlimpKitTests/PushNoteTests.swift`:

```swift
import Foundation
import Testing
@testable import BlimpKit

private func choice(_ pick: Int, _ label: String) -> [String: Any] { ["pick": pick, "label": label] }

@Test func aPermissionsNotificationHasItsSessionTheWaitAndYesAndNo() {
    let info: [AnyHashable: Any] = [
        "aps": ["alert": ["title": "Fix the drawer is waiting", "body": "Run bun test"], "category": "permission"],
        "session": "blimp-1", "kind": "ask", "at": 1_800_000_000_000.0, "yes": choice(0, "Yes"), "no": choice(2, "No"),
    ]
    let note = PushNote(info)
    #expect(note?.session == "blimp-1")
    #expect(note?.kind == .ask)
    #expect(note?.at == 1_800_000_000_000)
    #expect(note?.yes == PushNote.Choice(pick: 0, label: "Yes"))
    #expect(note?.no == PushNote.Choice(pick: 2, label: "No"))
}

@Test func aQuestionOrAFinishHasNoWaitAndNoButtons() {
    let ask = PushNote(["session": "s", "kind": "ask"])
    #expect(ask?.kind == .ask)
    #expect(ask?.at == nil)
    #expect(ask?.yes == nil)
    #expect(ask?.no == nil)
    #expect(PushNote(["session": "s", "kind": "finish"])?.kind == .finish)
}

@Test func halfAPermissionHasNoButtons() {
    let note = PushNote(["session": "s", "kind": "ask", "at": 5, "yes": choice(0, "Yes")])
    #expect(note?.session == "s")
    #expect(note?.at == nil)
    #expect(note?.yes == nil)
    #expect(note?.no == nil)
}

@Test func aNotificationThatIsntBlimpdsIsNone() {
    #expect(PushNote([:]) == nil)
    #expect(PushNote(["session": "s"]) == nil)
    #expect(PushNote(["session": "", "kind": "ask"]) == nil)
    #expect(PushNote(["session": "s", "kind": "other"]) == nil)
    #expect(PushNote(["session": 5, "kind": "ask"]) == nil)
}

@Test func aDeviceTokenIsLowercaseHexTwoDigitsAByte() {
    #expect(DeviceToken.hex(Data([0x00, 0x0f, 0xa5, 0xff])) == "000fa5ff")
    #expect(DeviceToken.hex(Data()) == "")
}
```

- [ ] **Step 2: Write `ios/BlimpKit/Sources/BlimpKit/PushNote.swift`:**

```swift
// What a notification from blimpd carries for the app (blimpd's src/push/payload.ts): its session, whether it's an
// ask or a finish, and for a permission with buttons the wait's `at` with the pick and label Yes and No answer with.
// The phone's device token goes to blimpd as hex (POST /push/device).
import Foundation

public struct PushNote: Equatable, Sendable {
    public enum Kind: String, Sendable {
        case ask, finish
    }

    public struct Choice: Equatable, Sendable {
        public let pick: Int
        public let label: String

        public init(pick: Int, label: String) {
            self.pick = pick
            self.label = label
        }
    }

    public let session: String
    public let kind: Kind
    /// A permission's wait and its Yes and No, all three or none: blimpd sends none for a question, a plan or a
    /// risky command.
    public let at: Double?
    public let yes: Choice?
    public let no: Choice?

    /// From a notification's userInfo; nil if it isn't one of blimpd's.
    public init?(_ info: [AnyHashable: Any]) {
        guard let session = info["session"] as? String, !session.isEmpty,
              let kind = (info["kind"] as? String).flatMap(Kind.init(rawValue:)) else { return nil }
        self.session = session
        self.kind = kind
        if let at = Self.number(info["at"]), let yes = Self.choice(info["yes"]), let no = Self.choice(info["no"]) {
            self.at = at
            self.yes = yes
            self.no = no
        } else {
            at = nil
            yes = nil
            no = nil
        }
    }

    private static func number(_ v: Any?) -> Double? {
        if let d = v as? Double { return d }
        if let i = v as? Int { return Double(i) }
        return nil
    }

    private static func choice(_ v: Any?) -> Choice? {
        guard let d = v as? [AnyHashable: Any], let pick = number(d["pick"]), pick >= 0, pick == pick.rounded(),
              let label = d["label"] as? String else { return nil }
        return Choice(pick: Int(pick), label: label)
    }
}

public enum DeviceToken {
    /// The token as blimpd takes it: lowercase hex, two digits a byte.
    public static func hex(_ data: Data) -> String {
        let digits = Array("0123456789abcdef")
        return String(data.flatMap { [digits[Int($0 >> 4)], digits[Int($0 & 0x0f)]] })
    }
}
```

- [ ] **Step 3: Commit**

```bash
git add ios/BlimpKit/Sources/BlimpKit/PushNote.swift ios/BlimpKit/Tests/BlimpKitTests/PushNoteTests.swift
git commit -m "iPhone: BlimpKit reads what blimpd's notifications carry (the session, ask or finish, and a permission's wait with its Yes and No) and writes the device token as the hex blimpd takes"
```

(Verified in CI with Task 2: `kit-linux` runs these tests. No push yet; the controller pushes after Task 2.)

---

### Task 2: The push entitlement, in the simulator builds and in the TestFlight build

**Files:**
- Modify: `ios/project.yml` (target `Blimp`'s settings and a new `entitlements` block)
- Modify: `ios/.gitignore`
- Modify: `.github/workflows/ios.yml` (the `testflight` job's "Archive" step)

**Interfaces:**
- Produces: the build setting `APS_ENVIRONMENT` (`development` for Debug, `production` for Release) and the generated file `ios/Blimp/Blimp.entitlements` with `aps-environment` = `$(APS_ENVIRONMENT)`.

- [ ] **Step 1: project.yml.** In target `Blimp`, under `settings:`, add a `configs:` block beside `base:`, and add an `entitlements:` block before `info:`:

```yaml
    settings:
      base:
        # (unchanged)
      configs:
        Debug:
          APS_ENVIRONMENT: development
        Release:
          APS_ENVIRONMENT: production
    # Notifications: Apple's sandbox service for a build from Xcode or the simulator, production for TestFlight.
    # XcodeGen writes the file (it's ignored, as Info.plist is).
    entitlements:
      path: Blimp/Blimp.entitlements
      properties:
        aps-environment: $(APS_ENVIRONMENT)
    info:
      # (unchanged)
```

- [ ] **Step 2: ios/.gitignore.** Add the line `Blimp/Blimp.entitlements` after `Blimp/Info.plist`.

- [ ] **Step 3: The TestFlight job.** In `.github/workflows/ios.yml`, job `testflight`, step "Archive", after the `xcodebuild … archive | tail -80` command, add:

```yaml
          # The export signs only the entitlements the archived app's signature lists, and an unsigned archive lists
          # none: an ad-hoc signature with Release's (aps-environment production) carries notifications over, or the
          # TestFlight build could never get one. Checked 2026-10-24: with it, the exported app has aps-environment.
          app="$RUNNER_TEMP/blimp.xcarchive/Products/Applications/blimp.app"
          ent="$RUNNER_TEMP/release.entitlements"
          cp Blimp/Blimp.entitlements "$ent"
          plutil -replace aps-environment -string production "$ent"
          codesign --force --sign - --entitlements "$ent" --timestamp=none --generate-entitlement-der "$app"
```

(The step's `working-directory` is `ios`, so `Blimp/Blimp.entitlements` is the file `xcodegen generate` wrote at the start of the step.)

- [ ] **Step 4: Commit**

```bash
git add ios/project.yml ios/.gitignore .github/workflows/ios.yml
git commit -m "iPhone: the app has the push entitlement (Apple's sandbox for Debug builds, production for TestFlight), and the TestFlight job signs the unsigned archive ad hoc with it, since the export keeps only what that signature lists"
```

- [ ] **Step 5: CI.** The controller pushes the branch (`git push -u origin phone-push-app`) and waits for the iOS run: `kit-linux` (Task 1's tests), `app` (the simulator build) and both `app-e2e` shards must pass. The TestFlight step itself runs only on a release tag.

---

### Task 3: The app asks, signs up, opens the chat from a tap, and has a Settings switch

**Files:**
- Create: `ios/Blimp/Push.swift`
- Modify: `ios/Blimp/BlimpApp.swift`, `ios/Blimp/Model/Store.swift`, `ios/Blimp/Net/API.swift`, `ios/Blimp/Views/HomeView.swift`, `ios/Blimp/Views/SettingsView.swift`, `ios/BlimpUITests/BlimpUITests.swift` (only `launchable`)

**Interfaces:**
- Consumes: `PushNote`, `DeviceToken` (Task 1).
- Produces: `@MainActor @Observable final class Push { static let shared; var token: String?; var open: String?; var denied: Bool; static var off: Bool; static let env: String; func start() async; nonisolated static func clear(session: String) async }`; `@MainActor final class AppDelegate`; `Store.startPush()`, `Store.sendPushToken(_:)`, `Store.stopPush()`; `API.registerDevice(token:env:)`, `API.unregisterDevice(token:)`; the UI tests' `launchable(push:)`.

- [ ] **Step 1: Create `ios/Blimp/Push.swift`:**

```swift
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
```

- [ ] **Step 2: BlimpApp.swift.** In `struct BlimpApp`, add after `@State private var lock = Lock()`:

```swift
    /// iOS's notification side (Push.swift): the device token and what a tapped notification opens.
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
```

In `Root`'s `body`, after the `.onChange(of: scenePhase == .active && !lock.locked, initial: true) { … }` modifier, add:

```swift
        // Notifications: iOS's question and the device token each time the app is online and unlocked (not over
        // the lock or Face ID), and the token again whenever iOS gives a new one.
        .task(id: store.connection == .online && !lock.locked) {
            if store.connection == .online && !lock.locked { store.startPush() }
        }
        .onChange(of: Push.shared.token) { _, token in
            if let token { store.sendPushToken(token) }
        }
```

- [ ] **Step 3: API.swift.** Add after `setHidden(dir:hidden:)`:

```swift
    /// Notifications to this phone: its device token, and which of Apple's services it's on (development for a build
    /// from Xcode, production for TestFlight). Sending it again is harmless. An older blimpd answers 404.
    func registerDevice(token: String, env: String) async throws {
        struct Body: Encodable { let token: String; let env: String }
        _ = try await call("POST", "/push/device", body: JSONEncoder().encode(Body(token: token, env: env)))
    }

    /// No more notifications to this phone from this server.
    func unregisterDevice(token: String) async throws {
        struct Body: Encodable { let token: String }
        _ = try await call("DELETE", "/push/device", body: JSONEncoder().encode(Body(token: token)))
    }
```

- [ ] **Step 4: Store.swift.** Add after `reconnectNow()`:

```swift
    /// Notifications, unless off in Settings: the token iOS already gave goes to blimpd, and iOS is asked again
    /// (it shows its question only the first time), which gives the token again.
    func startPush() {
        guard !Push.off else { return }
        if let token = Push.shared.token { sendPushToken(token) }
        Task { await Push.shared.start() }
    }

    /// An older blimpd has no /push/device: this phone then just gets no notifications from it.
    func sendPushToken(_ token: String) {
        guard !Push.off, let api else { return }
        Task { try? await api.registerDevice(token: token, env: Push.env) }
    }

    /// The Settings switch turned off, or signing out: blimpd forgets this phone.
    func stopPush() {
        guard let token = Push.shared.token, let api else { return }
        Task { try? await api.unregisterDevice(token: token) }
    }
```

In `signOut()`, make `stopPush()` the first line (it needs the server, which the next lines forget):

```swift
    func signOut() {
        stopPush()
        events?.stop()
```

- [ ] **Step 5: HomeView.swift.** Add after the `.onChange(of: store.sessions) { … }` modifier (in `body`):

```swift
        // A tapped notification: its session's chat, once the session list has it (a cold launch waits for the first
        // list); one that has ended since opens nothing.
        .onChange(of: PushTarget(name: Push.shared.open, sessions: store.sessions.map(\.name)), initial: true) { _, target in
            guard let name = target.name, !target.sessions.isEmpty else { return }
            Push.shared.open = nil
            if target.sessions.contains(name) { show(.session(name)) }
        }
        // Opening a chat takes its notifications away.
        .onChange(of: opened) { _, now in
            if case .session(let name) = now { Task { await Push.clear(session: name) } }
        }
```

and next to `private struct EarlierKey`, add:

```swift
private struct PushTarget: Equatable {
    let name: String?
    let sessions: [String]
}
```

- [ ] **Step 6: SettingsView.swift.** Update the file's top comment to `// Settings: which server this phone is paired with, notifications, the voice replies are read in, and sign out.` Add a state property after `chosen`:

```swift
    /// Notifications from this server (Push.off is the opposite).
    @State private var notify = !Push.off
```

and a section after the `Section("Server") { … }`:

```swift
                Section {
                    Toggle("Notifications", isOn: $notify)
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
```

- [ ] **Step 7: The UI tests launch with notifications off.** In `ios/BlimpUITests/BlimpUITests.swift`, replace `launchable()` with:

```swift
    /// The app, with its animations off (BlimpApp: `noAnimations`): each tap settles without waiting out a transition.
    /// Notifications off (Push: `pushOff`), so iOS's question never covers a test's screen, unless `push`.
    private func launchable(push: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["-noAnimations", "YES"]
        if !push { app.launchArguments += ["-pushOff", "YES"] }
        return app
    }
```

- [ ] **Step 8: Commit**

```bash
git add ios/Blimp/Push.swift ios/Blimp/BlimpApp.swift ios/Blimp/Model/Store.swift ios/Blimp/Net/API.swift ios/Blimp/Views/HomeView.swift ios/Blimp/Views/SettingsView.swift ios/BlimpUITests/BlimpUITests.swift
git commit -m "iPhone: notifications: once online and unlocked the app asks iOS (once) and sends its device token to blimpd; a tapped notification opens its session's chat, opening a chat clears its notifications, none show while the app is in front; Settings has a Notifications switch, and Sign out stops them too; the UI tests launch with them off"
```

- [ ] **Step 9: CI.** The controller pushes and waits for the iOS run: `app` must build with no warnings and both e2e shards must pass. If `app` fails, the job log names the file and line: fix and commit again. Likely spots: Swift 6 isolation in `Push.swift` (the `nonisolated` delegate methods, the `UNNotification` values that must not cross into the main actor).

---

### Task 4: A UI test: a notification for demo-chat, tapped, opens its chat

**Files:**
- Modify: `ios/BlimpUITests/BlimpUITests.swift` (a new test and two helpers; `launchPaired` gets `push:`)
- Modify: `ios/e2e/signals.sh`
- Create: `ios/e2e/push-demo-chat.json`
- Modify: `.github/workflows/ios.yml` (e2e-check's shard lists)

**Interfaces:**
- Consumes: `launchable(push:)` (Task 3); the existing helpers `wait`, `until`, `signal`, `screen`, `shot`, `message`, `hostFile`, `failed`, `unlockWithFace`, `homeButton`, `element`.

- [ ] **Step 1: signals.sh.** Add a line to the header comment after `faceid-match  a matching face`:

```sh
#   push-<name>   push ios/e2e/push-<name>.json to the simulator's blimp, as Apple would deliver it
```

and a case before `*) echo "unknown signal $name" ;;`:

```sh
      push-*) xcrun simctl push "$SIM" dev.blimp.phone "$here/$name.json" ;;
```

- [ ] **Step 2: Create `ios/e2e/push-demo-chat.json`** (the shape blimpd sends for a question; the title is demo-chat's):

```json
{
  "aps": {
    "alert": { "title": "Add a dark mode toggle to settings is waiting", "body": "Should it follow the system setting?" },
    "sound": "default",
    "thread-id": "demo-chat"
  },
  "session": "demo-chat",
  "kind": "ask"
}
```

- [ ] **Step 3: launchPaired takes `push`.** Change its signature and first lines to:

```swift
    private func launchPaired(arguments: [String] = [], push: Bool = false) throws {
        continueAfterFailure = false
        app = launchable(push: push)
        app.launchArguments += arguments
```

(The rest of `launchPaired` stays as it is.)

- [ ] **Step 4: The test.** Add a new section before `// MARK: - Helpers`:

```swift
    // MARK: - Notifications

    /// Notifications on: iOS asks once (Allow), and the phone signs up with blimpd, whose push.json then lists a
    /// development phone (no push key here, so blimpd sends nothing itself). With the app in the background, a
    /// notification for demo-chat (signals.sh pushes it to the simulator, as Apple would) opens its chat when tapped.
    /// (Last in shard b, after the tests that read demo-chat.)
    func testPushOpensTheChat() throws {
        try launchPaired(push: true)
        allowNotifications()
        let end = Date().addingTimeInterval(30)
        while !hostFile("b/push.json").contains("\"development\"") {
            if Date() > end { throw failed("the phone to sign up for notifications (b/push.json: \(hostFile("b/push.json")))") }
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCUIDevice.shared.press(.home)
        try signal("push-demo-chat")
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let banner = springboard.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "is waiting")).firstMatch
        try wait(banner, "the notification over the home screen", timeout: 20)
        screen("41-push-banner")
        banner.tap()
        try wait(message("message.user", "Add a dark mode toggle to settings"), "demo-chat's chat from the notification", timeout: 30)
        shot("42-push-opened")
    }
```

and a helper next to `allowFaceID()`:

```swift
    /// iOS asks once whether blimp may send notifications.
    private func allowNotifications() {
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.buttons["Allow"]
        if allow.waitForExistence(timeout: 15) {
            screen("push-permission")
            allow.tap()
        }
    }
```

(Check the existing `wait(_:_:timeout:)` helper's signature in the file and match it; if it has no `timeout:` parameter, use `until(…, "exists == true", …)` with its timeout instead.)

- [ ] **Step 5: The shard lists.** In `.github/workflows/ios.yml`, job `e2e-check`, add `testPushOpensTheChat` at the end of shard b's core list in both branches (the Mac's `shard b 7426 7432 "…"` and GitHub's `shard b 7426 7432 "…"`).

- [ ] **Step 6: Commit**

```bash
git add ios/BlimpUITests/BlimpUITests.swift ios/e2e/signals.sh ios/e2e/push-demo-chat.json .github/workflows/ios.yml
git commit -m "iPhone: a UI test allows notifications, checks the phone signed up with blimpd, then taps a notification for demo-chat (pushed to the simulator by signals.sh) and lands in its chat"
```

- [ ] **Step 7: CI.** The controller pushes and waits for the iOS run: both e2e shards must pass, with `testPushOpensTheChat` in shard b's results. If the simulator gives no device token (the test fails waiting for `b/push.json`), the xcodebuild log in the shard's artifact has the app's `push: no device token:` line.

---

### Task 5: Docs

**Files:**
- Modify: `ios/README.md`, `README.md`, `docs/PHONE-CHECKLIST.md`, `docs/SECURITY.md`

- [ ] **Step 1: ios/README.md.** After the paragraph that starts "The drawer on the left", add:

```markdown
**Notifications.** Once paired, blimp asks whether it may send notifications (iOS asks only once). Then the server tells your phone when a session waits on you, or when a Claude turn of 30 seconds or more ends, even with blimp closed. Tap one to open that session's chat. While blimp is open, none shows: its own banner tells you. Opening a chat clears its notifications. Settings has a Notifications switch. The server needs a push key first; the main README says how. Debug builds use Apple's sandbox service and TestFlight builds the production one; each tells blimpd which.
```

- [ ] **Step 2: README.md.** After the paragraph that starts "**Pair your iPhone.**", add:

```markdown
**Notifications on the iPhone.** blimpd sends them straight to Apple with your own push key. To set it up once:
1. In Apple's developer site (Certificates, Identifiers & Profiles), open Keys and add one with "Apple Push Notifications service (APNs)" ticked (Sandbox & Production). Download the `.p8` file (Apple lets you download it only once) and note its Key ID. Your Team ID is under Membership.
2. Copy it to the server, then run `blimpd push-key AuthKey_XXXXXXXXXX.p8 --key-id XXXXXXXXXX --team-id YYYYYYYYYY`. You can delete the file afterwards.
3. Open blimp on the iPhone and allow notifications, then run `blimpd push-test`. It prints Apple's answer for each phone.
The notification's text (a session's title, a command, a question, the start of a reply) shows on the lock screen. To hide it until Face ID: iOS Settings > Notifications > Show Previews > When Unlocked.
```

- [ ] **Step 3: docs/PHONE-CHECKLIST.md.** Add at the end of the list:

```markdown
- [ ] Notifications. After pairing (or on the first launch with this build), blimp asks once whether it may send notifications: Allow. With the server's push key set, `blimpd push-test` shows "blimp can reach this phone". Close blimp and let a session wait on you: a notification comes within a few seconds, titled with the session and "is waiting". Tap it: blimp opens (after Face ID) on that session's chat, and the notification is gone. A Claude turn of 30 s or more that ends sends "… finished" with the start of the reply. With blimp open, none shows (its own banner does). Settings > Notifications off: none come, on again: they do.
```

- [ ] **Step 4: docs/SECURITY.md.** In the table under "Who might attack, and what stops them", add after the row that starts "| Anyone but you | Send your phone fake notifications":

```markdown
| Someone who sees your locked phone | Read commands, questions or replies | A notification's text shows on the lock screen. iOS Settings > Notifications > Show Previews > When Unlocked hides it until Face ID. The README says so. |
```

- [ ] **Step 5: Commit**

```bash
git add ios/README.md README.md docs/PHONE-CHECKLIST.md docs/SECURITY.md
git commit -m "docs: notifications on the iPhone: what the app does, setting up the push key (Apple's site, blimpd push-key, push-test), the checklist item, and hiding the text from the lock screen"
```

---

## After this plan

- Max: the push key (README's three steps). Then a release, so TestFlight has the entitlement, and the checklist item.
- Step 3 (Yes and No on the notification) and step 4 (the Mac's `active`) get their own plans.
