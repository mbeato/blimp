// The box you type into: Return adds a line, Send sends. While Claude works and the box is empty,
// Stop takes Send's place.
import SwiftUI

struct InputBar: View {
    @Binding var text: String
    let working: Bool
    let sending: Bool
    let stopping: Bool
    let onSend: () -> Void
    let onStop: () -> Void

    private var hasText: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message", text: $text, axis: .vertical)
                .lineLimit(1...6)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 20))
            action
                .frame(width: 36, height: 36)
        }
    }

    @ViewBuilder private var action: some View {
        if sending {
            ProgressView()
        } else if working && !hasText {
            Button("Stop", systemImage: "stop.fill", action: onStop)
                .labelStyle(.iconOnly)
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.circle)
                .tint(.red)
                .disabled(stopping)
        } else {
            Button("Send", systemImage: "arrow.up", action: onSend)
                .labelStyle(.iconOnly)
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.circle)
                .disabled(!hasText)
        }
    }
}
