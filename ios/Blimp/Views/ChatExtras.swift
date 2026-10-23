// The parts of a chat beyond its messages: Run under a command Claude handed over (with a sheet that shows
// the whole command before it runs, then "Send result to Claude" once it ended), the context gauge, the "since
// you left" line and the chip to the next session waiting. The rules are in BlimpKit (ChatRules, ContextText).
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
