// The parts of a chat beyond its messages: Run under a command Claude handed over (with a sheet that shows
// the whole command before it runs, then "Send result to Claude" once it ended), the recap drawer ("where
// was I?"), the sheet that gives Claude a secret, the context gauge, the "since you left" line and the
// chip to the next session waiting. The rules are in BlimpKit (ChatRules, RecapCard, ContextText, SecretRule,
// SecretText).
import BlimpKit
import SwiftUI

// MARK: - Run

/// What Claude's latest reply needs for Run on its code blocks: blimpd's commands for it, the chat, and how
/// to ask before running one (the confirm sheet).
struct RunContext {
    let offered: [String]
    let chat: ChatModel
    let onAsk: (String) -> Void
}

/// Under a code block blimpd offers to run: Run, then how the run goes, then Send result to Claude.
struct RunControls: View {
    let command: String
    let chat: ChatModel
    let onAsk: (String) -> Void

    var body: some View {
        let status = chat.runStatus(command)
        HStack(spacing: 10) {
            switch status {
            case .ready:
                Button("Run", systemImage: "play.fill") { onAsk(command) }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.small)
                    .accessibilityIdentifier("runButton")
            case .ended(let run, let exit):
                Text(status.words ?? "").foregroundStyle(exit == 0 ? Color.secondary : Color.red)
                Button("Send result to Claude") { Task { await chat.sendResult(of: run) } }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.small)
                    .accessibilityIdentifier("sendRunResult")
            case .starting, .running, .sending, .sent:
                Text(status.words ?? "").foregroundStyle(.secondary).accessibilityIdentifier("runStatus")
            }
        }
        .font(.footnote)
        .sensoryFeedback(trigger: status) { _, new in
            if case .running = new { return .start }
            if case .sent = new { return .success }
            return nil
        }
    }
}

/// The command a Run tap is for, until the sheet runs it or is cancelled.
struct RunConfirm: Identifiable {
    let command: String
    var id: String { command }
}

/// Run is a command on your server: the whole command, and the folder it runs in, before it does.
struct RunConfirmSheet: View {
    let command: String
    let folder: String
    let onRun: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                Text("It runs on your server, in \(folder). Claude gets its result only if you send it.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                ScrollView {
                    Text(command)
                        .font(.system(.footnote, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                        .accessibilityIdentifier("runCommand")
                }
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
                Button {
                    onRun()
                    dismiss()
                } label: {
                    Text("Run").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .accessibilityIdentifier("runConfirm")
            }
            .padding()
            .navigationTitle("Run this command?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.accessibilityIdentifier("runCancel")
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

// MARK: - Recap drawer

enum RecapLoad: Equatable {
    case loading
    case shown(Recap)
    /// Asked for from the drawer, and it didn't come: why, in blimpd's words.
    case failed(String)
}

/// The chat's drawer from the right: "Recap" and the session's title, then what it's for and a section each for
/// Stuck, In progress, Next and Done (BlimpKit's Recap.sections), with refresh and ×. It never opens by itself: its toolbar button opens it, and so does a swipe left
/// anywhere in the chat (HomeView's `recapPull`), which it follows as the left drawer does (DrawerView). A swipe
/// right on it, a tap beside it or × closes it. Closed, it isn't there at all, so VoiceOver and the tests don't find it.
struct RecapDrawer: View {
    @Binding var open: Bool
    /// How far a swipe in the chat that's opening it has gone (HomeView), nil while there's none.
    let pull: CGFloat?
    let title: String
    let chat: ChatModel
    /// A swipe right that's pushing it back: how far it has gone (at least 0), nil while there's none.
    @State private var push: CGFloat?
    /// Whether the swipe going on is sideways (decided once, at its start), so scrolling the card never moves it.
    @State private var sideways: Bool?

    var body: some View {
        GeometryReader { geo in
            let width = min(geo.size.width * 0.84, 340)
            // How far out it is, 0 (closed) to width (open): where the finger has it while one moves it.
            let out = pull.map { min(width, max(0, $0)) } ?? (open ? min(width, max(0, width - (push ?? 0))) : 0)
            let still = pull == nil && push == nil
            ZStack(alignment: .trailing) {
                if open || pull != nil {
                    Color.black.opacity(0.3 * out / width)
                        .ignoresSafeArea()
                        .onTapGesture { open = false }
                        .accessibilityHidden(true)
                        .transition(.opacity)
                    panel
                        .frame(width: width)
                        .background(Color(.systemGroupedBackground).ignoresSafeArea())
                        .offset(x: width - out)
                        .transition(.move(edge: .trailing))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
            .simultaneousGesture(closing(width: width), including: open ? .all : .none)
            .allowsHitTesting(open)
            .animation(.snappy, value: open)
            .animation(.snappy, value: still)
        }
    }

    private func closing(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 10)
            .onChanged { v in
                if sideways == nil { sideways = abs(v.translation.width) > abs(v.translation.height) }
                if sideways == true { push = max(0, v.translation.width) }
            }
            .onEnded { v in
                defer { sideways = nil }
                guard sideways == true else { return }
                // Let go past a third of the way, or flung right: it closes; else back open.
                let close = v.translation.width > width / 3 || v.predictedEndTranslation.width > width * 0.6
                withAnimation(.snappy) {
                    if close { open = false }
                    push = nil
                }
            }
    }

    private var panel: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Recap").font(.title3.bold())
                    Text(title).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                }
                .accessibilityElement(children: .combine)
                Spacer(minLength: 0)
                Button("Refresh", systemImage: "arrow.clockwise") { chat.loadRecap(auto: false) }
                    .disabled(chat.recapLoad == .loading)
                    .accessibilityIdentifier("recapRefresh")
                Button("Close", systemImage: "xmark") { open = false }
                    .accessibilityIdentifier("recapClose")
            }
            .labelStyle(.iconOnly)
            .padding(.horizontal)
            .padding(.top, 12)
            .padding(.bottom, 8)
            List {
                switch chat.recapLoad {
                case .loading, nil:
                    Text("…").foregroundStyle(.secondary)
                case .failed(let why):
                    Text(why).font(.subheadline).foregroundStyle(.secondary)
                case .shown(let r):
                    Section {
                        Text(r.goal).font(.headline)
                    }
                    ForEach(r.sections, id: \.kind) { section in
                        Section {
                            ForEach(section.lines.indices, id: \.self) { i in
                                Text(section.lines[i]).font(.subheadline)
                            }
                        } header: {
                            Label(section.title, systemImage: Self.symbol(section.kind))
                                .foregroundStyle(section.kind == .stuck ? Color.red : Color.secondary)
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .listSectionSpacing(.compact)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("recapDrawer")
        .accessibilityAddTraits(.isModal)
    }

    /// Each section's mark: Stuck a stop sign (only it is red, as it needs you), In progress a half-full circle,
    /// Next and Open an empty one, Done a tick.
    private static func symbol(_ kind: RecapSection.Kind) -> String {
        switch kind {
        case .stuck: "exclamationmark.octagon"
        case .doing: "circle.lefthalf.filled"
        case .next, .open: "circle"
        case .done: "checkmark.circle"
        }
    }
}

// MARK: - Secret

/// Give Claude a secret: blimpd saves it in a file on the server and tells Claude where, never what it is.
/// The value lives only in this sheet's state and the one request, and is cleared when the sheet goes.
struct SecretSheet: View {
    /// Saves and tells; nil once done (the chat gives the haptic), else why not.
    let onSave: @MainActor (String, String) async -> String?
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var value = ""
    @State private var saving = false
    @State private var error: String?
    @State private var recent = SecretSheet.recentNames()

    nonisolated private static let recentKey = "secrets.recentNames"

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("OPENAI_API_KEY", text: $name)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .font(.body.monospaced())
                        .accessibilityIdentifier("secretName")
                    if !recent.isEmpty {
                        ScrollView(.horizontal) {
                            HStack {
                                ForEach(recent, id: \.self) { n in
                                    Button(n) { name = n }
                                        .buttonStyle(.bordered)
                                        .buttonBorderShape(.capsule)
                                        .controlSize(.small)
                                }
                            }
                        }
                        .scrollIndicators(.hidden)
                    }
                } header: {
                    Text("Name")
                } footer: {
                    if !name.isEmpty, !SecretRule.validName(name) {
                        Text("A letter first, then letters, digits or _, at most 64.")
                    }
                }
                Section {
                    SecureField("Value", text: $value)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("secretValue")
                } header: {
                    Text("Value")
                } footer: {
                    if brokenKey {
                        Text("This key needs its line breaks. Give it from the Mac.").foregroundStyle(.red)
                    } else {
                        Text("Saved in a file on your server (~/.blimp/secrets). Claude is told where it is, not what it is.")
                    }
                }
                Section {
                    Button {
                        Task { await save() }
                    } label: {
                        if saving { ProgressView() } else { Text("Save and Tell Claude") }
                    }
                    .disabled(!SecretRule.validName(name) || !SecretRule.validValue(value) || brokenKey || saving)
                    .accessibilityIdentifier("secretSave")
                    if let error {
                        Text(error).font(.footnote).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Give a Secret")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .onDisappear { value = "" }
    }

    /// A PEM or SSH key pasted here: this field drops its line breaks, so it would be saved broken.
    private var brokenKey: Bool { SecretText.lostLineBreaks(value) }

    private func save() async {
        saving = true
        error = nil
        let n = name
        let failed = await onSave(n, value)
        saving = false
        if let failed {
            error = failed
            return
        }
        value = ""
        Self.remember(n)
        dismiss()
    }

    // Names used before, newest first: names only, never values.
    nonisolated private static func recentNames() -> [String] {
        UserDefaults.standard.stringArray(forKey: recentKey) ?? []
    }

    private static func remember(_ n: String) {
        UserDefaults.standard.set(Array(([n] + recentNames().filter { $0 != n }).prefix(5)), forKey: recentKey)
    }
}

// MARK: - Small parts

/// The toolbar's context gauge: a ring filling up, and the percent (red from 80%).
struct ContextRing: View {
    let meter: ContextMeter

    var body: some View {
        HStack(spacing: 4) {
            ZStack {
                Circle().stroke(.quaternary, lineWidth: 3)
                Circle()
                    .trim(from: 0, to: meter.fraction)
                    .stroke(meter.high ? Color.red : Color.secondary, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            .frame(width: 16, height: 16)
            Text("\(meter.percent)%").font(.caption.monospacedDigit())
        }
        .foregroundStyle(meter.high ? Color.red : Color.primary)
    }
}

/// Above the first message that came while you were away.
struct SinceYouLeftLine: View {
    var body: some View {
        HStack(spacing: 8) {
            Rectangle().fill(Color.blue.opacity(0.5)).frame(height: 1)
            Text("Since you left").font(.caption.weight(.semibold)).foregroundStyle(.blue).fixedSize()
            Rectangle().fill(Color.blue.opacity(0.5)).frame(height: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("sinceYouLeft")
    }
}
