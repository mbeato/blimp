// The box you type into, the full width of the bar, with one round button inside its end: the mic
// while the box is empty, Send once there's text (a spinner while sending). Return adds a line. The
// mic: hold to talk and let go to send, slide up first to keep the words unsent; or tap to start and
// tap again to stop, the words kept in the box to read before Send. Stop is on the chat's working
// row, not here.
import SwiftUI

/// How a press on the mic ended.
enum MicRelease { case send, keep }

struct InputBar: View {
    @Binding var text: String
    let sending: Bool
    /// The mic is on: from the press until the words are sent or kept.
    let listening: Bool
    let onSend: () -> Void
    let onMicDown: () -> Void
    let onMicUp: (MicRelease) -> Void

    @State private var pressedAt: Date?
    /// A tap started it: it listens until the next tap.
    @State private var latched = false
    @State private var inKeepZone = false
    // Resets by itself when the system cancels the press (an alert, a call), where onEnded never comes.
    @GestureState private var pressing = false

    private static let keepDistance: CGFloat = 60
    private static let tapTime: TimeInterval = 0.3

    private var hasText: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        HStack(alignment: .bottom, spacing: 4) {
            TextField("Message", text: $text, axis: .vertical)
                .lineLimit(1...6)
                .padding(.leading, 14)
                .padding(.vertical, 9)
                .accessibilityIdentifier("messageField")
            // The mic stays while it listens, though the words heard fill the box: swapping it would end the press.
            Group {
                if listening || (!hasText && !sending) {
                    mic
                } else if sending {
                    ProgressView()
                } else {
                    send
                }
            }
            .frame(width: 32, height: 32)
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
            // A press that ended without onEnded was cancelled: keep what was heard, unsent.
            guard !now, pressedAt != nil else { return }
            pressedAt = nil
            inKeepZone = false
            if !latched { onMicUp(.keep) }
        }
    }

    private var hint: String? {
        guard listening else { return nil }
        if inKeepZone { return "Release to keep" }
        if latched { return "Tap the mic to stop" }
        return pressedAt != nil ? "Slide up to keep" : nil
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
                    .onChanged { value in
                        if pressedAt == nil {
                            pressedAt = .now
                            if !latched { onMicDown() }
                        }
                        inKeepZone = !latched && value.translation.height < -Self.keepDistance
                    }
                    .onEnded { value in
                        let held = pressedAt.map { Date.now.timeIntervalSince($0) } ?? 0
                        pressedAt = nil
                        inKeepZone = false
                        if latched {
                            latched = false
                            onMicUp(.keep)
                        } else if value.translation.height < -Self.keepDistance {
                            onMicUp(.keep)
                        } else if held < Self.tapTime {
                            latched = listening  // a press the screen refused (still stopping) doesn't latch
                        } else {
                            onMicUp(.send)
                        }
                    }
            )
            .accessibilityLabel(listening ? "Stop listening" : "Talk")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction {
                if listening {
                    latched = false
                    onMicUp(.keep)
                } else {
                    latched = true
                    onMicDown()
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
}
