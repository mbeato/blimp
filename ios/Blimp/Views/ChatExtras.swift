// The parts of a chat beyond its messages: Run under a command Claude handed over (with a sheet that shows
// the whole command before it runs, then "Send result to Claude" once it ended), the return card ("where
// was I?"), the sheet that gives Claude a secret, the context gauge, the "since you left" line and the
// chip to the next session waiting. The rules are in BlimpKit (ChatRules, RecapCard, ContextText, SecretRule).
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

// MARK: - Return card

enum RecapLoad: Equatable {
    case loading
    case shown(Recap)
    /// Asked for from the menu, and it didn't come: why, in blimpd's words.
    case failed(String)
}

/// At the top of the chat: what the session is for, what's done, what's open. A tap shows the lines in full.
struct RecapCardView: View {
    let load: RecapLoad
    let onClose: () -> Void
    @State private var full = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text("Where this is").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Spacer(minLength: 0)
                Button("Close", systemImage: "xmark", action: onClose)
                    .labelStyle(.iconOnly)
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("recapClose")
            }
            switch load {
            case .loading:
                Text("…").foregroundStyle(.secondary)
            case .failed(let why):
                Text(why).font(.footnote).foregroundStyle(.secondary)
            case .shown(let r):
                Text(r.goal).font(.subheadline.weight(.semibold)).lineLimit(full ? nil : 2)
                part("Done", r.done)
                part("Open", r.open)
            }
        }
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
        .contentShape(Rectangle())
        .onTapGesture { full.toggle() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("recapCard")
        .padding(.horizontal)
        .padding(.top, 6)
    }

    @ViewBuilder private func part(_ heading: String, _ lines: [String]) -> some View {
        if !lines.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                Text(heading).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                ForEach(lines.indices, id: \.self) { i in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("•").foregroundStyle(.secondary)
                        Text(lines[i]).lineLimit(full ? nil : 1)
                    }
                    .font(.footnote)
                }
            }
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
                    Text("Saved in a file on your server (~/.blimp/secrets). Claude is told where it is, not what it is.")
                }
                Section {
                    Button {
                        Task { await save() }
                    } label: {
                        if saving { ProgressView() } else { Text("Save and Tell Claude") }
                    }
                    .disabled(!SecretRule.validName(name) || !SecretRule.validValue(value) || saving)
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
