// What Claude is waiting on, above the input: a permission with its command (or a plan with its text) and a button
// per choice, a question dialog a question at a time (QuestionFlow), or, when the phone can't answer it, the
// question read-only and a pointer to the Mac. The buttons wait until blimpd has read Claude's real options
// ("Loading choices…"), a tap gives a haptic and "Sent…", then "Answered" once blimpd typed it. "Don't ask
// again" is a small link of its own; "No, and tell Claude why" declines and sends the reason in one step.
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
    /// The answer is on its way ("Sent…"), or blimpd typed it ("Answered").
    var sending = false
    var answered = false
    /// The folder Claude works in, under a permission's command.
    var folder: String? = nil
    /// No, and why: Esc on this prompt, then the words typed as a message. Returns why it didn't go, nil once
    /// typed. nil: not offered.
    var onDeny: (@MainActor (String, Prompt) async -> String?)? = nil
    /// Esc, as on the Mac; nil for folder trust, where Esc would end Claude.
    let onDismiss: (() -> Void)?
    /// The choice's index, and the prompt it was shown in: a permission, or one single-choice question.
    let onPick: (Int, Prompt) -> Void
    /// Every question's answer, for any other question dialog (or a typed answer to one question).
    let onAnswers: (QuestionDraft, Prompt) -> Void
    @State private var height: CGFloat = 0
    /// Taps on a choice, for the haptic.
    @State private var taps = 0

    var body: some View {
        // As tall as it needs, up to a point; a long question scrolls instead of hiding the chat.
        ScrollView {
            content
                .frame(maxWidth: .infinity, alignment: .leading)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(height: min(height, maxHeight))
        .sensoryFeedback(.impact(weight: .medium), trigger: taps)
        .sensoryFeedback(.success, trigger: answered) { _, new in new }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Circle().fill(.orange).frame(width: 8, height: 8)
                Text("Claude is waiting").font(.footnote).foregroundStyle(.secondary)
                Spacer()
                status
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

    @ViewBuilder private var status: some View {
        if answered {
            Label("Answered", systemImage: "checkmark.circle.fill")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.green)
                .accessibilityIdentifier("promptAnswered")
        } else if sending {
            Text("Sent…").font(.footnote).foregroundStyle(.secondary).accessibilityIdentifier("promptSent")
        }
    }

    @ViewBuilder private var answerable: some View {
        switch prompt.kind {
        case .permission:
            if PromptChoices.isPlan(prompt) {
                plan
            } else {
                summary
                command
            }
            ChoicesGate(prompt: prompt) {
                buttons
                if let onDeny, PromptChoices.deniable(prompt) {
                    DenyField(plan: PromptChoices.isPlan(prompt), busy: busy) { text in await onDeny(text, prompt) }
                        .id(prompt.at)
                }
            }
        case .trust:
            trust
            buttons
        case .question:
            QuestionFlow(prompt: prompt, highlight: highlight, onPick: { taps += 1; onPick($0, $1) }, onAnswers: { taps += 1; onAnswers($0, $1) })
                .disabled(busy)
                .id(prompt.at)
        case .other:
            EmptyView()
        }
    }

    /// The choices as tall buttons, the likely one first; "don't ask again" as a small link under them.
    private var buttons: some View {
        let split = PromptChoices.split(prompt)
        return VStack(alignment: .leading, spacing: 8) {
            ForEach(split.buttons, id: \.self) { i in
                ChoiceButton(label: prompt.choices[i], detail: nil, style: Self.style(i, prompt.choices[i]), marked: highlight == i) { pick(i) }
            }
            ForEach(split.links, id: \.self) { i in
                Button(prompt.choices[i]) { pick(i) }
                    .font(.footnote)
                    .buttonStyle(.borderless)
                    .multilineTextAlignment(.leading)
                    .accessibilityIdentifier("choice-\(prompt.choices[i])")
            }
        }
        .controlSize(.large)
        .disabled(busy)
    }

    private func pick(_ i: Int) {
        taps += 1
        onPick(i, prompt)
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
            command
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

    /// The command, file or address it asks about, whole, and the folder; a red line when it pushes, deploys,
    /// deletes or forces.
    @ViewBuilder private var command: some View {
        if let input = prompt.input, !input.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text(input)
                    .font(.system(.footnote, design: .monospaced))
                    .lineLimit(12)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
                    .accessibilityIdentifier("promptInput")
                if let folder, !folder.isEmpty {
                    Text("in " + folder).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
            }
        }
        if prompt.risky == true {
            Label("This can push, deploy, delete or force. Check it first.", systemImage: "exclamationmark.triangle.fill")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.red)
                .accessibilityIdentifier("promptRisky")
        }
    }

    /// ExitPlanMode: the plan Claude wants to go ahead with, as Markdown.
    @ViewBuilder private var plan: some View {
        Text("Claude's plan").font(.callout.weight(.semibold))
        if let text = prompt.plan, !text.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(MarkdownBlock.parse(text).enumerated()), id: \.offset) { _, block in
                    BlockView(block: block).tint(.blue)
                }
            }
            .font(.callout)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
        }
    }
}

/// Shows its content (a prompt's buttons) once blimpd has read Claude's real options, or has stopped looking;
/// until then "Loading choices…", so a tap never lands on the hook's stand-in Yes or No. Shared with the inbox's
/// Needs you rows.
struct ChoicesGate<Content: View>: View {
    let prompt: Prompt
    let content: Content
    /// The prompt (its `at`) whose wait is over.
    @State private var waited: Double? = nil

    init(prompt: Prompt, @ViewBuilder content: () -> Content) {
        self.prompt = prompt
        self.content = content()
    }

    var body: some View {
        Group {
            // (no wait left: shown at once, not after a frame of "Loading choices…")
            if waited == prompt.at || PromptReady.wait(prompt, now: Date().timeIntervalSince1970 * 1000) == 0 {
                content
            } else {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Loading choices…").font(.footnote).foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("loadingChoices")
            }
        }
        .task(id: prompt.at) {
            let ms = PromptReady.wait(prompt, now: Date().timeIntervalSince1970 * 1000)
            if ms > 0 { try? await Task.sleep(for: .milliseconds(Int(ms))) }
            if !Task.isCancelled { waited = prompt.at }
        }
    }
}

/// "No, and tell Claude why…" (for a plan: what to change): a field, then Send declines the prompt and types the
/// reason, in one step.
private struct DenyField: View {
    let plan: Bool
    let busy: Bool
    /// nil once blimpd typed it, else why not.
    let send: @MainActor (String) async -> String?
    @State private var open = false
    @State private var text = ""
    @State private var sending = false
    @State private var sent = false
    @State private var failure: String? = nil
    @FocusState private var focused: Bool

    init(plan: Bool, busy: Bool, send: @escaping @MainActor (String) async -> String?) {
        self.plan = plan
        self.busy = busy
        self.send = send
    }

    var body: some View {
        if open {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .bottom) {
                    TextField(plan ? "What should change?" : "Why not?", text: $text, axis: .vertical)
                        .lineLimit(1...5)
                        .textFieldStyle(.roundedBorder)
                        .focused($focused)
                        .onAppear { focused = true }
                        .accessibilityIdentifier("denyField")
                    Button("Send", action: go)
                        .buttonStyle(.borderedProminent)
                        .foregroundStyle(Color(.systemBackground))
                        .disabled(sending || sent || text.allSatisfy(\.isWhitespace))
                        .accessibilityIdentifier("denySend")
                }
                if sent {
                    Text("Sent. Claude reads it once the prompt is gone.").font(.caption).foregroundStyle(.secondary)
                } else if let failure {
                    Text(failure).font(.caption).foregroundStyle(.red)
                }
            }
        } else {
            Button {
                open = true
            } label: {
                Label(plan ? "No, tell Claude what to change…" : "No, and tell Claude why…", systemImage: "text.bubble")
                    .font(.callout)
            }
            .buttonStyle(.borderless)
            .disabled(busy)
            .accessibilityIdentifier("denyWithReason")
        }
    }

    private func go() {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty, !sending else { return }
        sending = true
        failure = nil
        Task {
            let error = await send(words)
            sending = false
            if let error { failure = error } else { sent = true }
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
                        .foregroundStyle(Color(.systemBackground))
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
                    .foregroundStyle(Color(.systemBackground))
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
        case .prominent: Button(action: action) { text }.buttonStyle(.borderedProminent).foregroundStyle(Color(.systemBackground))
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
