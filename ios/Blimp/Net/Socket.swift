// A WebSocket to blimpd that reconnects by itself (1, 2, 5, then every 10 s), except when the session
// ended (close 4000) or the token was refused (handshake 401). Pings every 20 s so a dead link is noticed.
import BlimpKit
import Foundation

enum SocketState: Equatable, Sendable {
    case connecting, open
    case closed(code: Int)
}

@MainActor
final class Socket {
    private let url: URL
    private let onMessage: @MainActor (Data) -> Void
    private let onState: @MainActor (SocketState) -> Void
    private var loop: Task<Void, Never>?
    private var task: URLSessionWebSocketTask?
    private var pongDue = false

    init(url: URL, onMessage: @escaping @MainActor (Data) -> Void, onState: @escaping @MainActor (SocketState) -> Void) {
        self.url = url
        self.onMessage = onMessage
        self.onState = onState
    }

    func start() {
        guard loop == nil else { return }
        loop = Task { await run() }
    }

    func stop() {
        loop?.cancel()
        loop = nil
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    /// Sends one text frame (blimpd reads JSON from text frames only).
    func send(_ data: Data) async throws {
        guard let task else { throw URLError(.notConnectedToInternet) }
        try await task.send(.string(String(decoding: data, as: UTF8.self)))
    }

    private func run() async {
        var attempt = 0
        while !Task.isCancelled {
            onState(.connecting)
            let t = URLSession.shared.webSocketTask(with: url)
            task = t
            t.resume()
            let pinger = Task { await ping(t) }
            var opened = false
            do {
                while true {
                    let message = try await t.receive()
                    // blimpd sends something as soon as a socket opens, so the first message means open
                    if !opened { opened = true; attempt = 0; onState(.open) }
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
            let refused = (t.response as? HTTPURLResponse)?.statusCode == 401
            let code = refused ? 401 : t.closeCode.rawValue
            onState(.closed(code: code))
            if code == 4000 || code == 401 { loop = nil; return }
            try? await Task.sleep(for: .seconds(Backoff.delay(attempt: attempt)))
            attempt += 1
        }
    }

    private func ping(_ t: URLSessionWebSocketTask) async {
        pongDue = false
        while true {
            try? await Task.sleep(for: .seconds(20))
            if Task.isCancelled || task !== t { return }
            // no pong since the last ping: the link is dead; cancelling ends receive() and reconnects
            if pongDue { t.cancel(with: .goingAway, reason: nil); return }
            pongDue = true
            t.sendPing { [weak self] error in
                Task { @MainActor in
                    guard let self, self.task === t else { return }
                    if error == nil { self.pongDue = false } else { t.cancel(with: .goingAway, reason: nil) }
                }
            }
        }
    }
}
