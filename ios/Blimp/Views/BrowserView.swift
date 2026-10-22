// A server browser tab, full screen over the chat (HomeView), opened from the drawer's Browser section. The top
// bar has × (back to the chat), the address (a tap edits it; a typed word is a Google search, as on the Mac) and
// ••• (Back, Forward, Reload, Keyboard, Send to Session, Close Tab). Below it, the live page: Chrome on the server
// lays it out as a phone's while this view was used last, and the fingers go to it as touches, so Chrome scrolls,
// glides, taps and zooms. A tap on a text field brings the keyboard up; what's typed goes to the page. The page's
// alerts show as alerts here. While the link is down, the last picture stays, greyed, with "Reconnecting". It
// closes its view when it goes and when the app leaves the front, so the Mac gets its own size back.
import BlimpKit
import SwiftUI
import UIKit

struct BrowserView: View {
    let tab: BrowserTab
    let onClose: () -> Void
    /// Puts the tab in the open session's box; nil while no session's chat is open.
    let onSend: ((String) -> Void)?
    let onCloseTab: () -> Void
    @Environment(Store.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: BrowserModel
    @State private var address = ""
    @State private var prompt = ""
    @FocusState private var editing: Bool

    init(tab: BrowserTab, onClose: @escaping () -> Void, onSend: ((String) -> Void)?, onCloseTab: @escaping () -> Void) {
        self.tab = tab
        self.onClose = onClose
        self.onSend = onSend
        self.onCloseTab = onCloseTab
        _model = State(initialValue: BrowserModel(tabId: tab.id))
    }

    private var url: String { model.info?.url ?? tab.url }
    private var title: String { model.info?.title ?? tab.title }

    var body: some View {
        VStack(spacing: 0) {
            bar
            Divider()
            page
        }
        .background(Color(.systemBackground))
        .onAppear(perform: start)
        .onDisappear { model.stop() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { start() } else { model.stop() }
        }
        .onChange(of: model.state) { _, state in if state == .gone { onClose() } }
        .onChange(of: url, initial: true) { _, now in if !editing { address = BrowserAddress.host(of: now) } }
        .onChange(of: editing) { _, on in
            if on {
                model.wantsKeyboard = false
                address = url
            } else {
                address = BrowserAddress.host(of: url)
            }
        }
        .onChange(of: model.dialog) { _, d in prompt = d?.defaultPrompt ?? "" }
        .alert(model.dialog?.message ?? "", isPresented: Binding(get: { model.dialog != nil }, set: { if !$0 { model.dialog = nil } }),
               presenting: model.dialog) { d in
            if d.kind == "prompt" { TextField("", text: $prompt) }
            if d.kind == "alert" {
                Button("OK") { model.answer(true) }
            } else {
                Button("Cancel", role: .cancel) { model.answer(false) }
                Button("OK") { model.answer(true, text: d.kind == "prompt" ? prompt : nil) }
            }
        }
    }

    private func start() {
        guard scenePhase == .active, let api = store.api else { return }
        model.start(api: api)
    }

    private var bar: some View {
        HStack(spacing: 10) {
            Button(action: onClose) { Image(systemName: "xmark").font(.body.weight(.semibold)).frame(width: 32, height: 32) }
                .accessibilityLabel("Back to the chat")
                .accessibilityIdentifier("browserClose")
            HStack(spacing: 6) {
                TextField("Search or address", text: $address)
                    .focused($editing)
                    .keyboardType(.webSearch)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .multilineTextAlignment(editing ? .leading : .center)
                    .onSubmit {
                        if let to = BrowserAddress.typed(address) { model.go(to) }
                        editing = false
                    }
                    .accessibilityIdentifier("browserAddress")
                if model.info?.loading == true, !editing { ProgressView().controlSize(.small) }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(.quaternary, in: Capsule())
            Menu {
                Button { model.nav(.back) } label: { Label("Back", systemImage: "chevron.left") }
                    .disabled(model.info?.canGoBack != true)
                Button { model.nav(.forward) } label: { Label("Forward", systemImage: "chevron.right") }
                    .disabled(model.info?.canGoForward != true)
                Button { model.nav(.reload) } label: { Label("Reload", systemImage: "arrow.clockwise") }
                Button { model.wantsKeyboard.toggle() } label: {
                    Label(model.wantsKeyboard ? "Hide Keyboard" : "Keyboard", systemImage: model.wantsKeyboard ? "keyboard.chevron.compact.down" : "keyboard")
                }
                if let onSend {
                    Button { onSend(BrowserTab.mention(title: title, url: url)) } label: { Label("Send to Session", systemImage: "arrow.up.message") }
                }
                Button(role: .destructive, action: onCloseTab) { Label("Close Tab", systemImage: "xmark.square") }
            } label: {
                Image(systemName: "ellipsis.circle").font(.title3).frame(width: 32, height: 32)
            }
            .accessibilityLabel("Page actions")
            .accessibilityIdentifier("browserMenu")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var page: some View {
        GeometryReader { geo in
            let k = PageFit.scale(pageWidth: model.page.map { Double($0.width) }, viewWidth: Double(geo.size.width))
            ZStack(alignment: .topLeading) {
                Color(.secondarySystemBackground)
                if let image = model.image, let size = model.page {
                    Image(uiImage: image)
                        .resizable()
                        .frame(width: size.width * k, height: size.height * k)
                }
                PageSurface(scale: k, wantsKeyboard: $model.wantsKeyboard, drawn: model.image != nil,
                            onTouch: model.touch, onText: model.type, onKey: model.press)
            }
            .opacity(model.state == .open ? 1 : 0.5)
            .overlay {
                if model.state != .open {
                    if model.image == nil {
                        ProgressView()
                    } else {
                        Text("Reconnecting").font(.subheadline.weight(.semibold))
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .background(.regularMaterial, in: Capsule())
                    }
                }
            }
            .clipped()
            .onChange(of: geo.size, initial: true) { _, size in model.resize(size) }
        }
    }
}

/// The page's surface: every finger, in the page's pixels (through `scale`), as touch messages, and the keyboard
/// (a UIKeyInput, so each key goes to the page as it's typed instead of into a field here).
private struct PageSurface: UIViewRepresentable {
    let scale: Double
    @Binding var wantsKeyboard: Bool
    let drawn: Bool
    let onTouch: @MainActor (TouchPhase, [TouchPoint]) -> Void
    let onText: @MainActor (String) -> Void
    let onKey: @MainActor (BrowserKey) -> Void

    func makeUIView(context: Context) -> SurfaceView {
        let v = SurfaceView()
        v.isMultipleTouchEnabled = true
        v.backgroundColor = .clear
        v.isAccessibilityElement = true
        v.accessibilityIdentifier = "browserPage"
        v.accessibilityLabel = "Page"
        return v
    }

    func updateUIView(_ v: SurfaceView, context: Context) {
        v.scale = scale
        v.onTouch = onTouch
        v.onText = onText
        v.onKey = onKey
        v.onKeyboardGone = { wantsKeyboard = false }
        // For the UI tests: whether a frame has been drawn.
        v.accessibilityValue = drawn ? "drawn" : "waiting"
        let want = wantsKeyboard
        guard want != v.isFirstResponder else { return }
        // After this update: becoming first responder needs the view in its window.
        Task { @MainActor in
            if want { _ = v.becomeFirstResponder() } else { _ = v.resignFirstResponder() }
        }
    }
}

final class SurfaceView: UIView, UIKeyInput {
    var scale: Double = 1
    var onTouch: @MainActor (TouchPhase, [TouchPoint]) -> Void = { _, _ in }
    var onText: @MainActor (String) -> Void = { _ in }
    var onKey: @MainActor (BrowserKey) -> Void = { _ in }
    var onKeyboardGone: @MainActor () -> Void = {}
    /// The fingers down, each with the id it keeps until it lifts. Chrome works out which finger went down, moved
    /// or lifted from the ones it's sent: a lift that leaves others down is a move with those, and the last
    /// lift is an end with none (Input.dispatchTouchEvent).
    private var down: [ObjectIdentifier: (touch: UITouch, id: Int)] = [:]
    private var nextId = 0

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        for t in touches {
            down[ObjectIdentifier(t)] = (t, nextId)
            nextId += 1
        }
        onTouch(.start, points())
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) { onTouch(.move, points()) }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) { lifted(touches, last: .end) }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) { lifted(touches, last: .cancel) }

    private func lifted(_ touches: Set<UITouch>, last: TouchPhase) {
        for t in touches { down[ObjectIdentifier(t)] = nil }
        onTouch(down.isEmpty ? last : .move, points())
    }

    private func points() -> [TouchPoint] {
        down.values.sorted { $0.id < $1.id }.map { d in
            let p = d.touch.location(in: self)
            return PageFit.toPage(x: Double(p.x), y: Double(p.y), scale: scale, id: d.id)
        }
    }

    // The keyboard: each key goes to the page as it's typed. Plain, as a web form wants: no corrections.
    override var canBecomeFirstResponder: Bool { true }
    var hasText: Bool { true }
    var autocorrectionType: UITextAutocorrectionType = .no
    var autocapitalizationType: UITextAutocapitalizationType = .none
    var spellCheckingType: UITextSpellCheckingType = .no
    var smartQuotesType: UITextSmartQuotesType = .no
    var smartDashesType: UITextSmartDashesType = .no
    var smartInsertDeleteType: UITextSmartInsertDeleteType = .no

    func insertText(_ text: String) {
        if text == "\n" { onKey(.enter) } else { onText(text) }
    }

    func deleteBackward() { onKey(.backspace) }

    override func resignFirstResponder() -> Bool {
        let done = super.resignFirstResponder()
        if done { onKeyboardGone() }
        return done
    }
}
