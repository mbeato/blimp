// What Claude is waiting on, above the input: a permission with a button per choice, a question dialog
// a question at a time (QuestionFlow), or, when the phone can't answer it, the question read-only and a
// pointer to the Mac.
import BlimpKit
import SwiftUI

struct PromptBar: View {
    let prompt: Prompt
    /// An answer is on its way, or went through and the prompt is still up: the buttons wait.
    let busy: Bool
    /// A spoken answer's guess: this button is marked and waits for a tap; nothing was sent.
    var highlight: Int? = nil
    /// The tallest it gets before it scrolls: the chat screen passes most of its height.
    var maxHeight: CGFloat = 320
    /// Esc, as on the Mac; nil for folder trust, where Esc would end Claude.
    let onDismiss: (() -> Void)?
    /// The choice's index, and the prompt it was shown in: a permission, or one single-choice question.
    let onPick: (Int, Prompt) -> Void
    /// Every question's answer, for any other question dialog (or a typed answer to one question).
    let onAnswers: (QuestionDraft, Prompt) -> Void
    @State private var height: CGFloat = 0

    var body: some View {
        // As tall as it needs, up to a point; a long question scrolls instead of hiding the chat.
        ScrollView {
            content
                .frame(maxWidth: .infinity, alignment: .leading)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(height: min(height, maxHeight))
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Circle().fill(.orange).frame(width: 8, height: 8)
                Text("Claude is waiting").font(.footnote).foregroundStyle(.secondary)
                Spacer()
                if let onDismiss {
                    Button("Dismiss", systemImage: "xmark", action: onDismiss)
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                        .controlSize(.small)
                        .font(.footnote)
                        .disabled(busy)
                        .accessibilityIdentifier("dismissPrompt")
                }
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
            buttons
        case .trust:
            trust
            buttons
        case .question:
            QuestionFlow(prompt: prompt, highlight: highlight, onPick: onPick, onAnswers: onAnswers)
                .disabled(busy)
                .id(prompt.at)
        case .other:
            EmptyView()
        }
    }

    private var buttons: some View {
        ForEach(Array(prompt.choices.enumerated()), id: \.offset) { i, choice in
            ChoiceButton(label: choice, detail: nil, style: Self.style(i, choice), marked: highlight == i) { onPick(i, prompt) }
        }
        .disabled(busy)
    }

    /// Claude's own question, and the folder in small text.
    private var trust: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Is this a project you created or one you trust?").font(.callout)
            if let folder = prompt.folder, !folder.isEmpty {
                Text(folder).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
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
        case .trust:
            trust
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

/// A question dialog like Claude's own: "1 of 3", the header and question, the options as compact rows
/// (a tap picks and moves on; multi-choice rows tick, then Next), "Type an answer", and with more than
/// one question a review before Submit. Back goes to the question before. Nothing is sent until the end.
private struct QuestionFlow: View {
    let prompt: Prompt
    let highlight: Int?
    let onPick: (Int, Prompt) -> Void
    let onAnswers: (QuestionDraft, Prompt) -> Void
    @State private var draft: QuestionDraft
    @State private var typing = false
    @State private var text = ""
    @FocusState private var focused: Bool

    init(prompt: Prompt, highlight: Int?, onPick: @escaping (Int, Prompt) -> Void, onAnswers: @escaping (QuestionDraft, Prompt) -> Void) {
        self.prompt = prompt
        self.highlight = highlight
        self.onPick = onPick
        self.onAnswers = onAnswers
        _draft = State(initialValue: QuestionDraft(questions: prompt.questions ?? []))
    }

    var body: some View {
        if draft.done && draft.reviews {
            review
        } else if let q = draft.current {
            question(q)
        }
    }

    private func question(_ q: Question) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                if let h = q.header, !h.isEmpty {
                    Text(h.uppercased()).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                }
                Spacer()
                if let p = draft.position { Text(p).font(.caption).foregroundStyle(.secondary) }
            }
            Text(q.question).font(.callout)
            ForEach(Array(q.options.enumerated()), id: \.offset) { i, option in
                if q.multiSelect {
                    CheckRow(label: option.label, detail: option.description, checked: draft.isPicked(i)) { draft.pick(i) }
                } else {
                    ChoiceButton(label: option.label, detail: option.description, style: .normal, marked: highlight == i) { pick(i) }
                }
            }
            typed(q)
            HStack {
                if draft.step > 0 {
                    Button("Back") { move { draft.back() } }.accessibilityIdentifier("backButton")
                }
                Spacer()
                if q.multiSelect {
                    Button(nextLabel) { move { draft.next() } }
                        .buttonStyle(.borderedProminent)
                        .disabled(!draft.isAnswered(draft.step))
                        .accessibilityIdentifier("nextButton")
                }
            }
        }
    }

    /// "Type an answer": a field in place of the options (single-choice: Use moves on), or with them (multi-choice).
    @ViewBuilder private func typed(_ q: Question) -> some View {
        if typing {
            HStack {
                TextField("Your answer", text: $text)
                    .textFieldStyle(.roundedBorder)
                    .focused($focused)
                    .submitLabel(.done)
                    .onSubmit {
                        if q.multiSelect { focused = false } else { use() }
                    }
                    .onChange(of: text) { if q.multiSelect { draft.type(text) } }
                    .accessibilityIdentifier("answerField")
                if !q.multiSelect {
                    Button("Use") { use() }
                        .disabled(text.allSatisfy(\.isWhitespace))
                        .accessibilityIdentifier("useAnswer")
                }
            }
        } else {
            Button {
                typing = true
                focused = true
            } label: {
                Label("Type an answer", systemImage: "keyboard").font(.callout)
            }
            .buttonStyle(.borderless)
            .accessibilityIdentifier("typeAnswer")
        }
    }

    private var review: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Review your answers").font(.callout.weight(.semibold))
            ForEach(Array(draft.questions.enumerated()), id: \.offset) { i, q in
                Button { move { draft.edit(i) } } label: {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(q.question).font(.caption).foregroundStyle(.secondary)
                        Text(draft.answer(i)).font(.callout)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.borderless)
                .accessibilityIdentifier("review-\(i)")
            }
            HStack {
                Button("Back") { move { draft.back() } }.accessibilityIdentifier("backButton")
                Spacer()
                Button("Submit") { onAnswers(draft, prompt) }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("submitAnswers")
            }
        }
    }

    private var nextLabel: String {
        draft.step < draft.questions.count - 1 ? "Next" : draft.reviews ? "Review" : "Submit"
    }

    /// One single-choice question goes as a pick, as voice answers do; otherwise the pick moves on.
    private func pick(_ i: Int) {
        if prompt.singleChoice {
            onPick(i, prompt)
        } else {
            move { draft.pick(i) }
        }
    }

    private func use() {
        move { draft.type(text) }
    }

    /// A change of step: the field shows that question's typed answer. With one question there's no
    /// review, so being done sends it, and the question stays up while it goes (and to try again).
    private func move(_ change: () -> Void) {
        change()
        if draft.done && !draft.reviews {
            onAnswers(draft, prompt)
            draft.edit(0)
        }
        text = draft.done ? "" : draft.texts[draft.step]
        typing = !text.isEmpty
        focused = false
    }
}

/// A multi-choice option: a box that ticks.
private struct CheckRow: View {
    let label: String
    let detail: String?
    let checked: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: checked ? "checkmark.square.fill" : "square")
                VStack(alignment: .leading, spacing: 2) {
                    Text(label).foregroundStyle(.primary)
                    if let detail, !detail.isEmpty {
                        Text(detail).font(.caption).foregroundStyle(.secondary)
                    }
                }
                .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }
            .padding(.vertical, 2)
        }
        .buttonStyle(.bordered)
        .accessibilityIdentifier("choice-\(label)")
        .accessibilityAddTraits(checked ? .isSelected : [])
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
