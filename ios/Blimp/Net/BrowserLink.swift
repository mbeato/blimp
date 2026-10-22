// A server browser tab's live view (GET /browser/tabs/<id>/view): JSON text messages both ways and JPEG frames
// coming in. Sends don't wait to be confirmed, unlike Socket's: fingers move many times a second. It connects
// again by itself (1, 2, 5, then every 10 s) until stopped, or until the tab is gone (closed with "Tab closed", or
// a 404 handshake). A ping every 10 s that isn't answered by the next drops a dead link.
import BlimpKit
import Foundation

@MainActor
final class BrowserLink {
    enum State: Equatable {
        case connecting, open
        /// The link dropped; it's connecting again.
        case lost
        /// The tab was closed: nothing more comes.
        case gone
    }

    private let url: URL
    private let onText: @MainActor (Data) -> Void
    private let onFrame: @MainActor (Data) -> Void
    private let onState: @MainActor (State) -> Void
    private var loop: Task<Void, Never>?
    private var task: URLSessionWebSocketTask?
    private var pongDue = false

    init(url: URL, onText: @escaping @MainActor (Data) -> Void, onFrame: @escaping @MainActor (Data) -> Void,
         onState: @escaping @MainActor (State) -> Void) {
        self.url = url
        self.onText = onText
        self.onFrame = onFrame
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

    /// Dropped while there's no link: the view sends its size again once it's back.
    func send(_ command: BrowserCommand) {
        guard let task, let data = try? JSONEncoder().encode(command) else { return }
        task.send(.string(String(decoding: data, as: UTF8.self))) { _ in }
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
                    guard task === t else { break }
                    // blimpd sends the page's address as soon as a view opens.
                    if !opened {
                        opened = true
                        attempt = 0
                        onState(.open)
                    }
                    switch message {
                    case .string(let s): onText(Data(s.utf8))
                    case .data(let d): onFrame(d)
                    @unknown default: break
                    }
                }
            } catch {}
            pinger.cancel()
            if task === t { task = nil }
            if Task.isCancelled { return }
            let status = (t.response as? HTTPURLResponse)?.statusCode
            let reason = t.closeReason.map { String(decoding: $0, as: UTF8.self) }
            if status == 404 || reason == "Tab closed" {
                loop = nil
                onState(.gone)
                return
            }
            onState(.lost)
            try? await Task.sleep(for: .seconds(Backoff.delay(attempt: attempt)))
            attempt += 1
        }
    }

    private func ping(_ t: URLSessionWebSocketTask) async {
        pongDue = false
        while !Task.isCancelled, task === t {
            try? await Task.sleep(for: .seconds(10))
            guard !Task.isCancelled, task === t else { return }
            if pongDue {
                t.cancel(with: .goingAway, reason: nil)
                return
            }
            pongDue = true
            t.sendPing { [weak self] error in
                let ok = error == nil
                Task { @MainActor in
                    guard let self, self.task === t else { return }
                    if ok { self.pongDue = false } else { t.cancel(with: .goingAway, reason: nil) }
                }
            }
        }
    }
}
