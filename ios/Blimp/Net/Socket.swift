// A WebSocket to blimpd that reconnects by itself (1, 2, 5, then every 10 s), except when the session
// ended (close 4000, or a handshake refused with 404) or the token was refused (handshake 401).
// Pings every 20 s so a dead link is noticed.
import BlimpKit
import Foundation

enum SocketState: Equatable, Sendable {
    case connecting, open
    case closed(code: Int)
}

enum SocketError: Error, Equatable {
    /// There is no link to blimpd right now (between reconnects, or after stop()).
    case notConnected
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

    init(url: URL, onMessage: @escaping @MainActor (Data) -> Void, onState: @escaping @MainActor (SocketState) -> Void) {
        self.url = url
        self.onMessage = onMessage
        self.onState = onState
    }

    func start() {
        guard loop == nil else { return }
        loop = Task { await run() }
    }

    /// Closes the link for good. A Socket keeps reconnecting until this is called (or the session
    /// ended, or the token was refused), so whoever owns one must call it when done with it.
    func stop() {
        loop?.cancel()
        loop = nil
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    /// Drops the link and connects again at once, without waiting out the backoff: for when the app
    /// comes back and the old link may be dead. Does nothing after stop() or once it has ended.
    func reconnectNow() {
        guard loop != nil else { return }
        loop?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        attempt = 0
        loop = Task { await run() }
    }

    /// Sends one text frame (blimpd reads JSON from text frames only).
    func send(_ data: Data) async throws {
        guard let task else { throw SocketError.notConnected }
        try await task.send(.string(String(decoding: data, as: UTF8.self)))
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
            // 404 is blimpd's answer for a chat on a session that no longer exists: it ended too
            let code = status == 401 ? 401 : status == 404 ? 4000 : t.closeCode.rawValue
            onState(.closed(code: code))
            if code == 4000 || code == 401 { loop = nil; return }
            try? await Task.sleep(for: .seconds(Backoff.delay(attempt: attempt)))
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
            markOpen(t)
        } else if opened {
            t.cancel(with: .goingAway, reason: nil)
        } else {
            pongDue = false  // not connected yet; a failed handshake ends receive() by itself
        }
    }
}
