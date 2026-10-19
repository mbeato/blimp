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
    var home = HomeList.make([])
    var connection: Connection = .connecting

    @ObservationIgnored private var events: Socket?

    var api: API? { server.map { API(server: $0) } }

    init() {
        server = Keychain.load()
        if server != nil { connect() }
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
                self.home = HomeList.make(list)
            },
            onState: { [weak self] state in self?.update(state) })
        events = socket
        socket.start()
    }

    func signOut() {
        events?.stop()
        events = nil
        Keychain.clear()
        server = nil
        sessions = []
        home = HomeList.make([])
        connection = .connecting
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
