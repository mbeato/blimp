// One server browser tab on the phone (BrowserView): the last frame and the page size it's at, the address and
// title, a dialog the page opened, and whether the keyboard is wanted. While it's on screen it says its size, as a
// phone's, so Chrome lays the page out for the phone; every frame drawn is acked, so a slow link gets fewer frames
// rather than a queue.
import BlimpKit
import Observation
import UIKit

@Observable @MainActor
final class BrowserModel {
    let tabId: String
    private(set) var image: UIImage?
    /// The page's size (CSS pixels) that `image` shows.
    private(set) var page: CGSize?
    private(set) var info: BrowserInfo?
    private(set) var state: BrowserLink.State = .connecting
    /// An alert, confirm or prompt from the page, waiting to be answered.
    var dialog: BrowserDialog?
    /// A text field on the page has focus (after a tap), or Keyboard in the menu.
    var wantsKeyboard = false

    @ObservationIgnored private var link: BrowserLink?
    /// The size the next frame is at (blimpd sends it just before the frame).
    @ObservationIgnored private var next: CGSize?
    /// The page's area on screen, in points: sent on open, again on each reconnect, and when it changes.
    @ObservationIgnored private var size: (width: Int, height: Int)?
    @ObservationIgnored private var resizing: Task<Void, Never>?
    /// The last frame being decoded: the next waits for it.
    @ObservationIgnored private var drawing: Task<Void, Never>?

    init(tabId: String) { self.tabId = tabId }

    func start(api: API) {
        guard link == nil else { return }
        let link = BrowserLink(
            url: api.socketURL("/browser/tabs/" + tabId + "/view"),
            onText: { [weak self] data in self?.received(BrowserEvent.decode(data)) },
            onFrame: { [weak self] data in self?.frame(data) },
            onState: { [weak self] state in self?.changed(state) })
        self.link = link
        link.start()
    }

    func stop() {
        link?.stop()
        link = nil
        resizing?.cancel()
        wantsKeyboard = false
    }

    /// The page's area changed (it opened, the keyboard came or went): sent once it has settled a moment, so
    /// the keyboard's animation doesn't lay the page out again at every step.
    func resize(_ area: CGSize) {
        let s = (width: Int(area.width.rounded()), height: Int(area.height.rounded()))
        guard s.width > 0, s.height > 0, size.map({ $0 != s }) ?? true else { return }
        let first = size == nil
        size = s
        resizing?.cancel()
        if first { return sendSize() }
        resizing = Task {
            try? await Task.sleep(for: .milliseconds(150))
            if !Task.isCancelled { sendSize() }
        }
    }

    func touch(_ phase: TouchPhase, _ points: [TouchPoint]) { link?.send(.touch(phase, points)) }

    func type(_ text: String) { link?.send(.text(text)) }

    func press(_ key: BrowserKey) { BrowserCommand.press(key).forEach { link?.send($0) } }

    func go(_ url: String) { link?.send(.go(url)) }

    func nav(_ action: BrowserNav) { link?.send(.nav(action)) }

    func answer(_ accept: Bool, text: String? = nil) {
        link?.send(.dialog(accept: accept, text: text))
        dialog = nil
    }

    private func sendSize() {
        guard let size else { return }
        link?.send(.size(width: size.width, height: size.height))
    }

    private func changed(_ s: BrowserLink.State) {
        state = s
        if s == .open { sendSize() }
    }

    private func received(_ event: BrowserEvent) {
        switch event {
        case let .frame(width, height): next = CGSize(width: width, height: height)
        case .info(let i): info = i
        case .dialog(let d): dialog = d
        case .dialogClosed: dialog = nil
        case .focus(let editable): wantsKeyboard = editable
        case .other: break
        }
    }

    /// Decoded off the main thread, which keeps the keys and fingers (a frame comes with every change while you
    /// scroll or type), and drawn in the order they came. Acked even when it can't be read, or no frame would come
    /// again.
    private func frame(_ data: Data) {
        let size = next
        let before = drawing
        drawing = Task { [weak self] in
            let image = await UIImage(data: data)?.byPreparingForDisplay()
            await before?.value
            guard let self else { return }
            if let image {
                self.image = image
                page = size ?? CGSize(width: image.size.width / 2, height: image.size.height / 2)
            }
            link?.send(.ack)
        }
    }
}
