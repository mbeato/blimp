// A project's inbox, what opening a project shows, above the box that starts a new chat (StartView). In a fixed
// order: after a while away, one line on what changed since (a tap shows only that); Needs you, the project's
// sessions waiting on you, oldest first, with its answers in the row (Allow and Deny, a question's choices, or a
// button into the chat; another project's are in its own inbox); then the project's sessions finished and not
// read yet, those working (how long, a clock after 30 minutes), and the rest folded as "+3 other". A tap opens
// one; a swipe left or press and hold has its actions (RowMenu).
import BlimpKit
import SwiftUI

struct InboxView: View {
    let dir: String
    let inbox: Inbox
    /// The project's sessions waiting on you, oldest first (Inbox.needsYou).
    let needs: [InboxLine]
    /// Every running session: the rows' parents.
    let sessions: [Session]
    /// Back after a while away: when the app went to the background (ms). nil: not long enough to say.
    let left: Double?
    let actions: RowActions
    let onPick: (DrawerRow.Item) -> Void
    /// Opens a session by name: the one a row's Resume started.
    let onOpen: (String) -> Void
    @State private var showOther = false
    @State private var onlyChanged = false

    var body: some View {
        // Each minute, for the ages.
        TimelineView(.everyMinute) { context in
            list(now: context.date.timeIntervalSince1970 * 1000)
        }
    }

    private func list(now: Double) -> some View {
        let shown = onlyChanged ? left.map { inbox.changed(since: $0) } ?? inbox : inbox
        return List {
            if let left, let words = InboxText.since(left, inbox: inbox, needs: needs) {
                Section { since(left, words) }
            }
            if !needs.isEmpty {
                Section {
                    ForEach(needs) { line in
                        NeedsRow(line: line, now: now, actions: actions, onPick: onPick)
                            .modifier(RowMenu(item: line.item, edge: .trailing, actions: actions, onOpen: onOpen))
                    }
                } header: {
                    Text("Needs you").foregroundStyle(.orange)
                }
            }
            heading("Finished, not read yet", shown.done, kind: .done, now: now)
            heading("Working", shown.working, kind: .working, now: now)
            if !shown.other.isEmpty {
                Section {
                    Button { showOther.toggle() } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "chevron.right").font(.caption2.weight(.bold)).rotationEffect(.degrees(showOther ? 90 : 0))
                            Text("+\(shown.other.count) other")
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .foregroundStyle(.secondary)
                    .accessibilityLabel(showOther ? "\(shown.other.count) other sessions, open" : "\(shown.other.count) other sessions, folded")
                    .accessibilityIdentifier("inbox-other")
                    if showOther {
                        ForEach(shown.other) { row($0, kind: .other, now: now) }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .animation(.snappy, value: showOther)
        .overlay {
            if inbox.isEmpty && needs.isEmpty {
                VStack(spacing: 8) {
                    FlightPath()
                    Text(Drawer.name(of: dir)).font(.title2.bold())
                    Text("What should Claude do here?").foregroundStyle(.secondary)
                }
            }
        }
    }

    /// "Since 11:40 PM: 4 finished, 1 asking, 2 working"; a tap shows only what changed since, and again all.
    private func since(_ left: Double, _ words: String) -> some View {
        Button { onlyChanged.toggle() } label: {
            HStack {
                Text("Since \(Date(timeIntervalSince1970: left / 1000).formatted(date: .omitted, time: .shortened)): \(words)")
                    .font(.subheadline)
                Spacer(minLength: 4)
                Text(onlyChanged ? "Show all" : "Show these").font(.caption).foregroundStyle(Color.accentColor)
            }
        }
        .foregroundStyle(.primary)
        .accessibilityIdentifier("inbox-since")
    }

    @ViewBuilder private func heading(_ title: String, _ lines: [InboxLine], kind: LineRow.Kind, now: Double) -> some View {
        if !lines.isEmpty {
            Section {
                ForEach(lines) { row($0, kind: kind, now: now) }
            } header: {
                Text(title)
            }
        }
    }

    private func row(_ line: InboxLine, kind: LineRow.Kind, now: Double) -> some View {
        Button { onPick(line.item) } label: { LineRow(line: line, kind: kind, now: now, sessions: sessions) }
            .foregroundStyle(.primary)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("inbox-" + line.id)
            .modifier(RowMenu(item: line.item, edge: .trailing, actions: actions, onOpen: onOpen))
    }
}

/// A session finished and not read yet (a blue dot, Haiku's words, how long ago), working (how long, a clock
/// after 30 minutes) or one of the rest; under it its handoff, branch and jobs.
private struct LineRow: View {
    enum Kind { case done, working, other }

    let line: InboxLine
    let kind: Kind
    let now: Double
    let sessions: [Session]

    var body: some View {
        let caption = line.session.map { RowCaption($0, all: sessions, now: now) }
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            mark
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline) {
                    Text(line.title).lineLimit(kind == .done ? 2 : 1)
                    Spacer(minLength: 4)
                    Text(age).font(.caption).foregroundStyle(.secondary).monospacedDigit()
                }
                if let words = line.words {
                    Text(words).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                }
                if let text = caption?.text {
                    Text(text).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var mark: some View {
        switch kind {
        case .done:
            Circle().fill(.blue).frame(width: 9, height: 9).accessibilityLabel("New reply")
        case .working:
            if now - line.since >= InboxText.long {
                Image(systemName: "clock").font(.caption).foregroundStyle(.secondary).accessibilityLabel("Working a long time")
            } else {
                ProgressView().controlSize(.small)
            }
        case .other:
            MarkView(mark: line.session?.mark ?? Mark.none)
        }
    }

    private var age: String {
        switch kind {
        case .done: InboxText.finished(since: line.activity, now: now)
        case .working: InboxText.working(since: line.since, now: now)
        case .other: InboxText.ago(line.activity, now: now)
        }
    }
}

/// A session waiting on you: what it asks, since when, its command (red when risky), and the
/// answer in the row once blimpd has read the real options: Allow and Deny (a risky Allow asks once more), a
/// question's choices as chips, or a button into its chat. A tap gives a haptic and "Sent…", then "Answered".
private struct NeedsRow: View {
    let line: InboxLine
    let now: Double
    let actions: RowActions
    let onPick: (DrawerRow.Item) -> Void
    @Environment(Store.self) private var store
    @State private var taps = 0
    @State private var confirmAllow = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { onPick(line.item) } label: { label }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("inbox-" + line.id)
            if let s = line.session, let p = prompt {
                answers(s, p)
            }
        }
        .padding(.vertical, 2)
        .sensoryFeedback(.impact(weight: .medium), trigger: taps)
        .sensoryFeedback(.success, trigger: answered) { _, new in new }
    }

    /// The prompt it waits on, while it does.
    private var prompt: Prompt? {
        guard let s = line.session, s.state == .waiting else { return nil }
        return s.prompt
    }

    private var answered: Bool {
        guard let s = line.session, let p = prompt else { return false }
        return actions.phase(s.name, p) == .answered
    }

    private var label: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline) {
                Text(line.title).lineLimit(2)
                Spacer(minLength: 4)
                Text(InboxText.asked(since: line.since, now: now)).font(.caption).foregroundStyle(.secondary).monospacedDigit()
            }
            if let words = line.words {
                Text(Inline.summary(words)).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }
            if let input = prompt?.input, !input.isEmpty {
                Text(input)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(prompt?.risky == true ? Color.red : Color.secondary)
                    .lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    @ViewBuilder private func answers(_ s: Session, _ p: Prompt) -> some View {
        let phase = actions.phase(s.name, p)
        switch RowAnswer.of(p) {
        case .allowDeny(let allow, let deny):
            ChoicesGate(prompt: p) {
                HStack(spacing: 8) {
                    Button {
                        if p.risky == true { confirmAllow = true } else { send(s, p, .pick(at: p.at, pick: allow, label: p.choices[allow])) }
                    } label: {
                        Text("Allow").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .foregroundStyle(Color(.systemBackground))
                    .accessibilityIdentifier("inbox-allow-" + s.name)
                    Button { send(s, p, Self.deny(p, deny)) } label: {
                        Text("Deny").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("inbox-deny-" + s.name)
                }
                .controlSize(.large)
                .disabled(phase != nil)
            }
            .confirmationDialog("Allow this?", isPresented: $confirmAllow, titleVisibility: .visible) {
                Button("Allow", role: .destructive) { send(s, p, .pick(at: p.at, pick: allow, label: p.choices[allow])) }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("It can push, deploy, delete or force: " + (p.input ?? p.summary ?? ""))
            }
        case .chips(let labels):
            ChoicesGate(prompt: p) {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { chips(s, p, labels) }
                    VStack(alignment: .leading, spacing: 6) { chips(s, p, labels) }
                }
                .disabled(phase != nil)
            }
        case .open(let title):
            Button(title) { onPick(line.item) }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("inbox-answer-" + s.name)
        case .none:
            EmptyView()
        }
        if phase == .answered {
            Label("Answered", systemImage: "checkmark.circle.fill").font(.caption.weight(.semibold)).foregroundStyle(.green)
        } else if phase == .sending {
            Text("Sent…").font(.caption).foregroundStyle(.secondary)
        } else if let failure = actions.failed(s.name, p) {
            Text(failure).font(.caption).foregroundStyle(.red)
        }
    }

    private func chips(_ s: Session, _ p: Prompt, _ labels: [String]) -> some View {
        ForEach(Array(labels.enumerated()), id: \.offset) { i, label in
            Button(label) { send(s, p, .pick(at: p.at, pick: i, label: label)) }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .accessibilityIdentifier("inbox-choice-\(s.name)-\(i)")
        }
    }

    /// Deny is Claude's own "No" when it has one, else Esc on this prompt (as Dismiss is).
    private static func deny(_ p: Prompt, _ pick: Int?) -> PromptAnswer {
        guard let pick else { return .stop(at: p.at) }
        return .pick(at: p.at, pick: pick, label: p.choices[pick])
    }

    private func send(_ s: Session, _ p: Prompt, _ answer: PromptAnswer) {
        taps += 1
        Task { await actions.answer(s.name, p, answer, api: store.api) }
    }
}
