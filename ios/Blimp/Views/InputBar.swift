// The box you type into, the full width of the bar, with round buttons inside its end: the mic, always (so
// you can talk more onto what's typed), and Send once there's text (a spinner while sending). Return adds a
// line. The mic: hold to talk and let go, or tap to start and tap again to stop. Either way the words stay
// in the box to read, edit or add to, then Send; letting go never sends a message (held while Claude asks
// something, the chat may take the words as the answer). Above the box, while it's empty and nothing is
// asked: one-tap replies. A tap sends after a short Undo; a long press puts the words in the box instead.
// Stop is on the chat's working row, not here. What's typed is kept per chat (keepsDraft).
import BlimpKit
import SwiftUI

/// How a press on the mic ended.
enum MicRelease {
    /// Let go after holding: an answer to what Claude asked, if it asked; else only words in the box.
    case held
    /// Tapped off, or cut short (an alert, the app leaving): only words in the box.
    case keep
}

struct InputBar: View {
    @Binding var text: String
    let sending: Bool
    /// The mic is on: from the press until the words are in the box.
    let listening: Bool
    let onSend: () -> Void
    /// nil: no mic; Send shows from the start, off while the box is empty.
    let onMicDown: (() -> Void)?
    let onMicUp: ((MicRelease) -> Void)?
    var placeholder = "Message"
    /// One-tap replies above the box (ReplyChips.row); none hides the row.
    var chips: [String] = []
    /// Sends a chip's words, once its Undo time has passed.
    var onChip: ((String) -> Void)? = nil

    @State private var pressedAt: Date?
    /// A tap started it: it listens until the next tap.
    @State private var latched = false
    // Resets by itself when the system cancels the press (an alert, a call), where onEnded never comes.
    @GestureState private var pressing = false
    /// A chip tapped and waiting out its Undo.
    @State private var pendingChip: String?
    /// This box asked Listener to load an analyzer ahead of a press.
    @State private var warmed = false

    private static let tapTime: TimeInterval = 0.3
    private static let undoTime: Duration = .seconds(2)

    private var hasText: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    /// Send shows once there's text, not while listening (the words heard are still coming), or always
    /// for a box with no mic.
    private var showsSend: Bool { onMicDown == nil || (hasText && !listening) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !chips.isEmpty, !listening, !sending { chipRow }
            box
        }
        // A tapped chip is sent only from the row it was tapped on: text in the box, a prompt or a new reply
        // changes the chips, and the mic or a send hides them; each cancels it, so it isn't sent when the row comes back.
        .onChange(of: chips) { pendingChip = nil }
        .onChange(of: listening || sending) { _, busy in if busy { pendingChip = nil } }
        .onAppear {
            guard onMicDown != nil, !warmed else { return }
            warmed = true
            Listener.warm()
        }
        .onDisappear {
            guard warmed else { return }
            warmed = false
            Listener.cool()
        }
    }

    private var box: some View {
        HStack(alignment: .bottom, spacing: 4) {
            TextField(placeholder, text: $text, axis: .vertical)
                .lineLimit(1...6)
                .padding(.leading, 14)
                .padding(.vertical, 9)
                .accessibilityIdentifier("messageField")
            // The mic keeps its place while it listens, so the press never ends under the finger.
            HStack(spacing: 2) {
                if onMicDown != nil { mic }
                if sending {
                    ProgressView().frame(width: 32, height: 32)
                } else if showsSend {
                    send.disabled(!hasText)
                }
            }
            .padding(.trailing, 4)
            .padding(.bottom, 4)
        }
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 20))
        .overlay(alignment: .topTrailing) {
            if let hint {
                Text(hint)
                    .font(.footnote.weight(.semibold))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(.regularMaterial, in: Capsule())
                    .offset(y: -40)
                    .allowsHitTesting(false)
            }
        }
        .onChange(of: listening) { _, on in
            if !on { latched = false }
        }
        .onChange(of: pressing) { _, now in
            // A press that ended without onEnded was cancelled: keep what was heard.
            guard !now, pressedAt != nil else { return }
            pressedAt = nil
            if !latched { onMicUp?(.keep) }
        }
    }

    private var hint: String? {
        guard listening, latched else { return nil }
        return "Tap the mic to stop"
    }

    private var mic: some View {
        Image(systemName: listening ? "mic.fill" : "mic")
            .font(.body.weight(.medium))
            .foregroundStyle(listening ? Color.white : Color.accentColor)
            .frame(width: 32, height: 32)
            .background(listening ? Color.accentColor : Color.clear, in: Circle())
            .contentShape(Circle())
            .gesture(
                DragGesture(minimumDistance: 0, coordinateSpace: .global)
                    .updating($pressing) { _, state, _ in state = true }
                    .onChanged { _ in
                        if pressedAt == nil {
                            pressedAt = .now
                            if !latched { onMicDown?() }
                        }
                    }
                    .onEnded { _ in
                        let held = pressedAt.map { Date.now.timeIntervalSince($0) } ?? 0
                        pressedAt = nil
                        if latched {
                            latched = false
                            onMicUp?(.keep)
                        } else if held < Self.tapTime {
                            latched = listening  // a press the screen refused (still stopping) doesn't latch
                        } else {
                            onMicUp?(.held)
                        }
                    }
            )
            .accessibilityLabel(listening ? "Stop listening" : "Talk")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction {
                if listening {
                    latched = false
                    onMicUp?(.keep)
                } else {
                    latched = true
                    onMicDown?()
                }
            }
    }

    private var send: some View {
        Button(action: onSend) {
            Image(systemName: "arrow.up")
                .font(.body.weight(.semibold))
                .foregroundStyle(.white)
                .frame(width: 32, height: 32)
                .background(Color.accentColor, in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Send")
        .accessibilityIdentifier("sendButton")
    }

    // MARK: - One-tap replies

    private var chipRow: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                if let pendingChip {
                    Text("Sending “\(pendingChip)”…").font(.footnote).foregroundStyle(.secondary)
                    Button("Undo") { self.pendingChip = nil }
                        .font(.footnote.weight(.semibold))
                        .accessibilityIdentifier("chipUndo")
                } else {
                    ForEach(chips, id: \.self) { chipView($0) }
                }
            }
            .padding(.vertical, 2)
        }
        .scrollIndicators(.hidden)
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        .fixedSize(horizontal: false, vertical: true)
        // Sent once the Undo time has passed; Undo, typing, a prompt or leaving the chat cancels it (see body).
        .task(id: pendingChip) {
            guard let chip = pendingChip else { return }
            try? await Task.sleep(for: Self.undoTime)
            guard !Task.isCancelled, pendingChip == chip else { return }
            pendingChip = nil
            onChip?(chip)
        }
        .sensoryFeedback(.selection, trigger: pendingChip) { _, chip in chip != nil }
    }

    private func chipView(_ chip: String) -> some View {
        Text(chip)
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.quaternary, in: Capsule())
            .contentShape(Capsule())
            .onTapGesture { pendingChip = chip }
            .onLongPressGesture { text = chip }
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("chip-" + chip)
            .accessibilityAction { pendingChip = chip }
            .accessibilityAction(named: "Edit before sending") { text = chip }
    }
}

/// What's typed in a box, kept in UserDefaults per chat (`key`), so it comes back after switching chats,
/// the lock or a cold launch. The box clears it by emptying (once blimpd took the message).
struct KeepsDraft: ViewModifier {
    @Binding var text: String
    let key: String

    func body(content: Content) -> some View {
        content
            .onAppear { if text.isEmpty { text = DraftBox.text(for: key) } }
            .onChange(of: text) { _, now in DraftBox.set(now, for: key) }
    }
}

extension View {
    func keepsDraft(_ text: Binding<String>, key: String) -> some View {
        modifier(KeepsDraft(text: text, key: key))
    }
}

/// The drafts as saved: one UserDefaults entry, read once.
@MainActor
enum DraftBox {
    private static let key = "drafts"
    private static var cache: Drafts?

    static func text(for chat: String) -> String { load().text(for: chat) }

    static func set(_ text: String, for chat: String) {
        var drafts = load()
        guard drafts.text(for: chat) != text else { return }
        let now = Date.now.timeIntervalSince1970 * 1000
        drafts.set(text, for: chat, now: now)
        drafts = drafts.pruned(now: now)
        cache = drafts
        if let data = try? JSONEncoder().encode(drafts) { UserDefaults.standard.set(data, forKey: key) }
    }

    private static func load() -> Drafts {
        if let cache { return cache }
        let saved = UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode(Drafts.self, from: $0) }
        let drafts = saved ?? Drafts()
        cache = drafts
        return drafts
    }
}
