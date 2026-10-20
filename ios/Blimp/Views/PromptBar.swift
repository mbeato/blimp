// What Claude is waiting on, above the input: a permission or a question with a button per choice,
// or, when the phone can't answer it, the question read-only and a pointer to the Mac.
import BlimpKit
import SwiftUI

struct PromptBar: View {
    let prompt: Prompt
    /// An answer is on its way, or went through and the prompt is still up: the buttons wait.
    let busy: Bool
    /// A spoken answer's guess: this button is marked and waits for a tap; nothing was sent.
    var highlight: Int? = nil
    /// The choice's index, and the prompt it was shown in.
    let onPick: (Int, Prompt) -> Void
    @State private var height: CGFloat = 0

    var body: some View {
        // As tall as it needs, up to a point; a long question scrolls instead of hiding the chat.
        ScrollView {
            content
                .frame(maxWidth: .infinity, alignment: .leading)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(height: min(height, 320))
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Circle().fill(.orange).frame(width: 8, height: 8)
                Text("Claude is waiting").font(.footnote).foregroundStyle(.secondary)
            }
            if prompt.answerable && prompt.kind != .other {
                answerable
            } else {
                readOnly
                Text("Open on Mac to answer this").font(.footnote).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private var answerable: some View {
        switch prompt.kind {
        case .permission:
            summary
            ForEach(Array(prompt.choices.enumerated()), id: \.offset) { i, choice in
                ChoiceButton(label: choice, detail: nil, style: Self.style(i, choice), marked: highlight == i) { onPick(i, prompt) }
            }
            .disabled(busy)
        case .question:
            if let q = prompt.questions?.first {
                Text(q.question).font(.callout)
                ForEach(Array(q.options.enumerated()), id: \.offset) { i, option in
                    ChoiceButton(label: option.label, detail: option.description, style: .normal, marked: highlight == i) {
                        onPick(i, prompt)
                    }
                }
                .disabled(busy)
            }
        case .other:
            EmptyView()
        }
    }

    @ViewBuilder private var readOnly: some View {
        switch prompt.kind {
        case .permission:
            summary
            if !prompt.choices.isEmpty {
                Text(prompt.choices.joined(separator: " · ")).font(.callout).foregroundStyle(.secondary)
            }
        case .question:
            ForEach(Array((prompt.questions ?? []).enumerated()), id: \.offset) { _, q in
                VStack(alignment: .leading, spacing: 2) {
                    Text(q.question).font(.callout)
                    ForEach(Array(q.options.enumerated()), id: \.offset) { _, option in
                        Text("• " + option.label).font(.callout).foregroundStyle(.secondary)
                    }
                }
            }
        case .other:
            Text("Claude is asking something.").font(.callout)
        }
    }

    // The first choice is the likely one; a "No…" is there but quiet.
    private static func style(_ i: Int, _ choice: String) -> ChoiceButton.Style {
        if i == 0 { return .prominent }
        return choice.hasPrefix("No") ? .plain : .normal
    }

    @ViewBuilder private var summary: some View {
        if let s = prompt.summary, !s.isEmpty {
            Text(Inline.summary(s))
                .font(.callout)
                .lineLimit(6)
                .textSelection(.enabled)
        }
    }
}

private struct ChoiceButton: View {
    enum Style { case prominent, normal, plain }

    let label: String
    let detail: String?
    let style: Style
    let marked: Bool
    let action: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            button
                .accessibilityIdentifier("choice-\(label)")
                .overlay {
                    if marked { RoundedRectangle(cornerRadius: 10).stroke(Color.accentColor, lineWidth: 2).padding(-3) }
                }
            if marked {
                Text("Did you mean this? Tap to send.").font(.caption).foregroundStyle(Color.accentColor)
            }
        }
    }

    @ViewBuilder private var button: some View {
        switch style {
        case .prominent: Button(action: action) { text }.buttonStyle(.borderedProminent)
        case .normal: Button(action: action) { text }.buttonStyle(.bordered)
        case .plain: Button(action: action) { text }.buttonStyle(.borderless)
        }
    }

    private var text: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
            if let detail, !detail.isEmpty {
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
        }
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 2)
    }
}
