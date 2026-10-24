// The app's state: which server it's paired with, the live session list from /events, and how the link is
// (in words: "Connecting…" the first time, "Reconnecting…" after, "Tailscale looks off" when that's why).
import BlimpKit
import Foundation
import Observation

enum Connection: Equatable, Sendable {
    case connecting, online
    case offline(String)
    case unauthorized
}

@Observable @MainActor
final class Store {
    var server: ServerLink?
    var sessions: [Session] = []
    /// The server browser's tabs, every folder's (the drawer shows the project's).
    var browserTabs: [BrowserTab] = []
    /// Words for a chat's box from elsewhere (the browser's Send to Session): that chat adds them to its box
    /// and sets this back.
    var insert: DraftInsert?
    var connection: Connection = .connecting
    /// The events socket has been open since the server was paired or loaded: a new try is a reconnect.
    private(set) var everOnline = false
    /// blimpd can't be reached, the server is on the tailnet, and the phone has no tailnet address.
    private(set) var tailnetOff = false
    /// blimpd's version, from /health each time the events socket opens (an update restarts it); nil until then.
    private(set) var serverVersion: String?
    /// The project the chat is in, kept for the next launch.
    var dir: String? = UserDefaults.standard.string(forKey: "project") {
        didSet { UserDefaults.standard.set(dir, forKey: "project") }
    }

    @ObservationIgnored private var events: Socket?

    var api: API? { server.map { API(server: $0) } }

    /// The Keychain couldn't be read yet, so whether a server is saved isn't known: neither Pair nor
    /// Home shows until it can be (`loadServer` again once the app is active).
    private(set) var waitingForKeychain = false

    init() {
        loadServer()
        // A new network may be Tailscale coming on or going off: say again why it's offline.
        NetworkWatch.shared.onChange = { [weak self] in
            guard let self, case .offline = self.connection else { return }
            self.offline()
        }
    }

    func loadServer() {
        guard server == nil else { return }
        switch Keychain.load() {
        case .server(let link):
            waitingForKeychain = false
            server = link
            connect()
        case .none:
            waitingForKeychain = false
        case .unreadable:
            waitingForKeychain = true
        }
    }

    /// Checks the link against /health first, so a wrong token or address never gets saved.
    func pair(_ link: ServerLink) async throws {
        _ = try await API(server: link).health()
        try Keychain.save(link)
        server = link
        connect()
    }

    func connect() {
        events?.stop()
        events = nil
        guard let server else { return }
        connection = .connecting
        let socket = Socket(
            url: API(server: server).socketURL("/events"),
            onMessage: { [weak self] data in
                guard let self else { return }
                switch EventsMessage.decode(data) {
                case .sessions(let list):
                    self.sessions = list
                case .browser(let tabs):
                    self.browserTabs = tabs
                case .other:
                    break
                }
            },
            onState: { [weak self] state in self?.update(state) })
        events = socket
        socket.start()
    }

    /// Back from the background: the old link may be dead, so don't wait for the 20 s ping to find out.
    /// A link that answers within 3 s is kept.
    func reconnectNow() {
        events?.reconnectNow()
    }

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

    func signOut() {
        stopPush()
        events?.stop()
        events = nil
        Keychain.clear()
        server = nil
        sessions = []
        browserTabs = []
        connection = .connecting
        everOnline = false
        tailnetOff = false
        serverVersion = nil
    }

    /// Starts (or resumes) Claude Code in `dir`, with `prompt` as its first message if given; returns the new session's name.
    func start(dir: String, resume: String?, prompt: String? = nil) async throws -> String {
        guard let api else { throw APIError.offline }
        return try await api.start(dir: dir, resume: resume, prompt: prompt)
    }

    func end(name: String) async throws {
        guard let api else { throw APIError.offline }
        try await api.end(name: name)
    }

    /// Opens a server browser tab in `dir`; returns its id.
    func openTab(dir: String, url: String = BrowserAddress.home) async throws -> String {
        guard let api else { throw APIError.offline }
        return try await api.openTab(dir: dir, url: url)
    }

    func closeTab(_ id: String) async throws {
        guard let api else { throw APIError.offline }
        try await api.closeTab(id)
    }

    /// An error in plain words for an alert.
    static func words(for error: Error) -> String {
        switch error as? APIError {
        case .offline: "Can't reach the server."
        case .unauthorized: "The server didn't accept this phone's token."
        case .server(let message): message
        case .other(let message): message
        case nil: error.localizedDescription
        }
    }

    private func update(_ state: SocketState) {
        switch state {
        case .connecting:
            // keep showing why it's offline while it retries
            if case .offline = connection { return }
            connection = .connecting
        case .open:
            connection = .online
            everOnline = true
            tailnetOff = false
            Task { [weak self] in
                guard let api = self?.api, let health = try? await api.health() else { return }
                self?.serverVersion = health.version
            }
        case .closed(code: 401):
            connection = .unauthorized
        case .closed:
            offline()
        }
    }

    private func offline() {
        tailnetOff = Tailnet.looksOff(server: server?.url.host(), interfaces: Interfaces.ipv4())
        connection = .offline(LinkText.offline(tailnetOff: tailnetOff))
    }
}

/// Words for one chat's box (Store.insert).
struct DraftInsert: Equatable {
    let chat: String
    let text: String
}
