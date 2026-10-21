// The app's state: which server it's paired with, the live session list from /events, and how the link is.
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
    /// Each running folder's paragraph (Digest), from the same messages as the sessions.
    var digests: [String: Digest] = [:]
    var connection: Connection = .connecting
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
                guard let self, case .sessions(let list) = EventsMessage.decode(data) else { return }
                self.sessions = list
                self.digests = EventsMessage.digests(data)
            },
            onState: { [weak self] state in self?.update(state) })
        events = socket
        socket.start()
    }

    /// Back from the background: the old link may be dead, so don't wait for a ping to find out.
    func reconnectNow() {
        events?.reconnectNow()
    }

    func signOut() {
        events?.stop()
        events = nil
        Keychain.clear()
        server = nil
        sessions = []
        connection = .connecting
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
        case .closed(code: 401):
            connection = .unauthorized
        case .closed:
            connection = .offline("Can't reach the server")
        }
    }
}
