// A WebSocket to blimpd that reconnects by itself (1, 2, 5, then every 10 s), except when the session
// ended (close 4000) or the token was refused (handshake 401). A handshake refused with 404 is passed
// on as closed(404) and retried like any other failure: the chat decides whether that means ended.
// Pings every 20 s so a dead link is noticed; sooner when it matters: a send, or the app coming back, waits
// at most 3 s to hear from blimpd, and a new network (Wi-Fi, cellular, a hotspot, Tailscale) reconnects at once.
import BlimpKit
import Foundation
import Network

enum SocketState: Equatable, Sendable {
    case connecting, open
    case closed(code: Int)
}

enum SocketError: Error, Equatable {
    /// There is no link to blimpd right now (between reconnects, or after stop()).
    case notConnected
    /// The frame was written, but blimpd wasn't heard from within 3 s, so the link was dropped. blimpd may
    /// still have it: send it again with the same id, which blimpd types only once.
    case unconfirmed
}

@MainActor
final class Socket {
    private let url: URL
    private let onMessage: @MainActor (Data) -> Void
    private let onState: @MainActor (SocketState) -> Void
    private var loop: Task<Void, Never>?
    private var task: URLSessionWebSocketTask?
    private var pongDue = false
    private var opened = false
    private var attempt = 0
    /// When blimpd was last heard from: a frame, or a pong.
    private var heardAt = ContinuousClock.now
    /// A check after the app came back is under way.
    private var checking = false

    /// How long a link may stay quiet after a ping before it counts as dead.
    static let deadline: Duration = .seconds(3)

    init(url: URL, onMessage: @escaping @MainActor (Data) -> Void, onState: @escaping @MainActor (SocketState) -> Void) {
        self.url = url
        self.onMessage = onMessage
        self.onState = onState
    }

    func start() {
        guard loop == nil else { return }
        NetworkWatch.shared.add(self)
        loop = Task { await run() }
    }

    /// Closes the link for good. A Socket keeps reconnecting until this is called (or the session
    /// ended, or the token was refused), so whoever owns one must call it when done with it.
    func stop() {
        NetworkWatch.shared.remove(self)
        loop?.cancel()
        loop = nil
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    /// For when the app comes back and the old link may be dead: an open link is pinged and dropped only if
    /// blimpd says nothing within 3 s (a healthy one, and the chat it carries, stay as they are); one that
    /// isn't open connects again at once, without waiting out the backoff. Does nothing after stop() or once
    /// it has ended. kept: called when the link answered and stays, so no new history comes.
    func reconnectNow(kept: (@MainActor () -> Void)? = nil) {
        guard loop != nil else { return }
        guard let t = task, opened else { return restart() }
        guard !checking else { return }
        checking = true
        Task {
            let alive = await heard(on: t, since: .now)
            checking = false
            guard task === t else { return }
            if alive { kept?() } else { restart() }
        }
    }

    /// The network changed: the old link went with it, so connect again at once.
    func networkChanged() {
        guard loop != nil else { return }
        restart()
    }

    private func restart() {
        loop?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        attempt = 0
        loop = Task { await run() }
    }

    /// Sends one text frame (blimpd reads JSON from text frames only). A dead link takes a frame without a
    /// word, so it also waits to hear from blimpd (a pong, the ack, any frame): nothing within 3 s drops the
    /// link and throws `unconfirmed`, so the sender can try again on the new link now instead of after its own
    /// timeouts.
    func send(_ data: Data) async throws {
        guard let task else { throw SocketError.notConnected }
        let since = ContinuousClock.now
        try await task.send(.string(String(decoding: data, as: UTF8.self)))
        guard await heard(on: task, since: since) else {
            if self.task === task { restart() }
            throw SocketError.unconfirmed
        }
    }

    /// Pings and waits up to `deadline` for blimpd to be heard from after `since`; false if not, or once
    /// the link was replaced.
    private func heard(on t: URLSessionWebSocketTask, since: ContinuousClock.Instant) async -> Bool {
        t.sendPing { [weak self] error in
            let failed = error != nil
            Task { @MainActor in self?.pong(t, failed: failed) }
        }
        let end = since + Self.deadline
        while heardAt <= since {
            guard task === t, ContinuousClock.now < end else { return false }
            try? await Task.sleep(for: .milliseconds(100))
        }
        return true
    }

    private func run() async {
        while !Task.isCancelled {
            onState(.connecting)
            let t = URLSession.shared.webSocketTask(with: url)
            task = t
            opened = false
            t.resume()
            let pinger = Task { await ping(t) }
            do {
                while true {
                    let message = try await t.receive()
                    // a frame from a link reconnectNow() already dropped
                    guard task === t else { break }
                    // blimpd sends something as soon as a socket opens, so the first message means open
                    heardAt = .now
                    markOpen(t)
                    switch message {
                    case .string(let s): onMessage(Data(s.utf8))
                    case .data(let d): onMessage(d)
                    @unknown default: break
                    }
                }
            } catch {}
            pinger.cancel()
            if task === t { task = nil }
            if Task.isCancelled { return }
            let status = (t.response as? HTTPURLResponse)?.statusCode
            let code = status == 401 || status == 404 ? status ?? 0 : t.closeCode.rawValue
            onState(.closed(code: code))
            if code == 4000 || code == 401 { loop = nil; return }
            try? await Task.sleep(for: .seconds(Backoff.delay(attempt: attempt)))
            // stopped or replaced by reconnectNow() while it waited, which also reset attempt
            if Task.isCancelled { return }
            attempt += 1
        }
    }

    private func markOpen(_ t: URLSessionWebSocketTask) {
        guard task === t, !opened else { return }
        opened = true
        attempt = 0
        pongDue = false
        onState(.open)
    }

    private func ping(_ t: URLSessionWebSocketTask) async {
        pongDue = false
        while !Task.isCancelled, task === t {
            if !pongDue {
                pongDue = true
                t.sendPing { [weak self] error in
                    let failed = error != nil
                    Task { @MainActor in self?.pong(t, failed: failed) }
                }
            } else if opened {
                // no pong since the last ping: the link is dead; cancelling ends receive() and reconnects
                t.cancel(with: .goingAway, reason: nil)
                return
            }
            // Until it's open, ping every second: a first pong also means open, for a socket that
            // has nothing to say yet (blimpd's /events sends nothing if its first zmx list failed).
            try? await Task.sleep(for: .seconds(opened ? 20 : 1))
        }
    }

    private func pong(_ t: URLSessionWebSocketTask, failed: Bool) {
        guard task === t else { return }
        if !failed {
            pongDue = false
            heardAt = .now
            markOpen(t)
        } else if opened {
            t.cancel(with: .goingAway, reason: nil)
        } else {
            pongDue = false  // not connected yet; a failed handshake ends receive() by itself
        }
    }
}

/// Watches the phone's network and tells every live Socket when it changes (not on the first reading).
@MainActor
final class NetworkWatch {
    static let shared = NetworkWatch()

    private let monitor = NWPathMonitor()
    private let sockets = NSHashTable<Socket>.weakObjects()
    /// The network as last seen: whether it's usable, and its interfaces.
    private var last: String?
    /// Also told of each change: the Store, to say again why it's offline.
    var onChange: (() -> Void)?

    private init() {
        monitor.pathUpdateHandler = { @Sendable path in
            let key = NetworkWatch.key(path)
            let usable = path.status == .satisfied
            Task { @MainActor in NetworkWatch.shared.changed(key, usable: usable) }
        }
        monitor.start(queue: .main)
    }

    func add(_ socket: Socket) { sockets.add(socket) }
    func remove(_ socket: Socket) { sockets.remove(socket) }

    private func changed(_ key: String, usable: Bool) {
        let previous = last
        last = key
        guard let previous, previous != key else { return }
        onChange?()
        guard usable else { return }
        for socket in sockets.allObjects { socket.networkChanged() }
    }

    nonisolated private static func key(_ path: NWPath) -> String {
        "\(path.status == .satisfied) " + path.availableInterfaces.map(\.name).joined(separator: ",")
    }
}
