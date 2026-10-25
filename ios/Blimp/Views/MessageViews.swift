// How each chat message looks: your prompts as bubbles, Claude's replies as native Markdown (a long
// one folded, with Show more, except the newest). Tool steps aren't shown; the working row says the latest
// one. In Claude's latest reply, a code block blimpd offers to run has Run under it (ChatExtras.swift).
import BlimpKit
import SwiftUI

struct MessageRow: View {
    let message: ChatMessage
    /// A long reply folds; the chat's newest reply doesn't.
    var fold = true
    /// For Claude's latest reply in an open chat: Run on its commands.
    var runs: RunContext?

    var body: some View {
        switch message.role {
        case .user: UserBubble(text: message.text ?? "")
        case .assistant: AssistantText(text: message.text ?? "", fold: fold, runs: runs)
        case .tool: EmptyView()
        case .compacted:
            Text("Session compacted")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .accessibilityIdentifier("message.compacted")
        case .shell: ShellRun(command: message.input ?? "", output: message.output)
        }
    }
}

/// A ! command you ran: the command as your bubble, what it printed under it in monospace (more
/// than 12 lines fold, with Show more). No output yet: it's still running.
struct ShellRun: View {
    let command: String
    let output: String?
    @State private var open = false

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            UserBubble(text: "! " + command)
            if let output, !output.isEmpty {
                let long = output.split(separator: "\n", omittingEmptySubsequences: false).count > 12
                VStack(alignment: .leading, spacing: 6) {
                    Text(output)
                        .font(.system(.footnote, design: .monospaced))
                        .lineLimit(long && !open ? 12 : nil)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("message.shell.output")
                    if long {
                        Button(open ? "Show less" : "Show more") { open.toggle() }
                            .font(.footnote.weight(.semibold))
                            .buttonStyle(.plain)
                            .foregroundStyle(Color.accentColor)
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
            }
        }
    }
}

struct UserBubble: View {
    let text: String

    var body: some View {
        HStack {
            Spacer(minLength: 48)
            Text(text)
                .accessibilityIdentifier("message.user")
                .textSelection(.enabled)
                .foregroundStyle(Color(.systemBackground))
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(Color.primary, in: RoundedRectangle(cornerRadius: 18))
        }
    }
}

/// A step smaller than your bubbles. A reply taller than about 12 lines folds to that height, with
/// Show more (unless fold is off: the newest reply); read aloud still reads all of it.
struct AssistantText: View {
    let text: String
    var fold = true
    var runs: RunContext?
    @State private var open = false
    @State private var height: CGFloat = 0
    @ScaledMetric(relativeTo: .callout) private var foldHeight: CGFloat = 250

    var body: some View {
        // a little over the fold, so folding never hides just a line or two
        let long = fold && height > foldHeight * 1.2
        let folded = long && !open
        VStack(alignment: .leading, spacing: 6) {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(MarkdownBlock.parse(text).enumerated()), id: \.offset) { _, block in
                    BlockView(block: block, runs: runs)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
            .frame(maxHeight: folded ? foldHeight : nil, alignment: .top)
            .clipped()
            .mask {
                if folded {
                    LinearGradient(stops: [.init(color: .black, location: 0.7), .init(color: .clear, location: 1)],
                                   startPoint: .top, endPoint: .bottom)
                } else {
                    Color.black
                }
            }
            if long {
                Button(open ? "Show less" : "Show more") { open.toggle() }
                    .font(.footnote.weight(.semibold))
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.accentColor)
            }
        }
        .font(.callout)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
        // Links in a reply stay blue under the app's monochrome tint.
        .tint(.blue)
    }
}

struct BlockView: View {
    let block: MarkdownBlock
    var runs: RunContext?

    var body: some View {
        switch block {
        case .paragraph(let s):
            Text(Inline.text(s)).accessibilityIdentifier("message.assistant")
        case .heading(let level, let s):
            Text(Inline.text(s)).font(Self.font(level)).bold()
        case .bullets(let items):
            ListView(markers: items.map { _ in "•" }, items: items)
        case .numbered(let start, let items):
            ListView(markers: items.indices.map { "\(start + $0)." }, items: items)
        case .code(let language, let s):
            if let runs, let command = RunnableCommand.offered(language: language, text: s, runnable: runs.offered) {
                VStack(alignment: .leading, spacing: 6) {
                    CodeBox { Text(s) }
                    RunControls(command: command, chat: runs.chat, onAsk: runs.onAsk)
                        .tint(Color.primary)
                }
            } else {
                CodeBox { Text(s) }
            }
        case .table(let s):
            CodeBox { Text(s) }
        case .quote(let s):
            Text(Inline.text(s))
                .foregroundStyle(.secondary)
                .padding(.leading, 12)
                .overlay(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 1.5).fill(.tertiary).frame(width: 3)
                }
        case .rule:
            Divider()
        }
    }

    private static func font(_ level: Int) -> Font {
        switch level {
        case 1: .title2
        case 2: .title3
        case 3: .headline
        default: .subheadline
        }
    }
}

private struct ListView: View {
    let markers: [String]
    let items: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(items.indices, id: \.self) { i in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(markers[i]).foregroundStyle(.secondary).monospacedDigit()
                    Text(Inline.text(items[i]))
                }
            }
        }
    }
}

/// Monospace text in a rounded box that scrolls sideways, so long lines keep their shape. A swipe in it scrolls it
/// and doesn't pull the drawer.
struct CodeBox<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        ScrollView(.horizontal) {
            VStack(alignment: .leading, spacing: 8) { content }
                .font(.system(.footnote, design: .monospaced))
                .textSelection(.enabled)
                .padding(10)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
        .scrollsSideways()
    }
}

/// While Claude works, or waits on something only the Mac can answer: Stop presses Esc. Pinned above the box
/// where the phone can type into the session, else at the end of the chat.
struct WorkingRow: View {
    let waiting: Bool
    /// The newest tool step, said after "working…".
    let step: ChatMessage?
    let stopping: Bool
    /// nil where the phone can't type into the session (Open on Mac): no Stop.
    let onStop: (() -> Void)?
    /// With text in the box while Claude works: Esc, then the text as a new message.
    var onStopAndSend: (() -> Void)?

    var body: some View {
        HStack(spacing: 8) {
            if waiting {
                Circle().fill(.orange).frame(width: 8, height: 8)
            } else {
                ProgressView().controlSize(.small)
            }
            Text(waiting ? "waiting…" : "working…").foregroundStyle(.secondary)
            if !waiting, let step {
                Text(Inline.summary(step.summary ?? step.name ?? "Tool"))
                    .foregroundStyle(step.error == true ? Color.red : Color.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            if let onStop {
                Button("Stop", systemImage: "stop.fill", action: onStop)
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.small)
                    .tint(.red)
                    .disabled(stopping)
                    .fixedSize()
            }
            if let onStopAndSend {
                Button("Stop and send", systemImage: "arrow.uturn.right", action: onStopAndSend)
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.small)
                    .disabled(stopping)
                    .fixedSize()
                    .accessibilityIdentifier("stopAndSend")
            }
        }
        .font(.footnote)
    }
}

/// Inline Markdown (bold, code, links) for one block. Only http and https links stay links.
enum Inline {
    static func text(_ s: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        guard var a = try? AttributedString(markdown: s, options: options) else { return AttributedString(s) }
        var unsafe: [Range<AttributedString.Index>] = []
        for run in a.runs {
            if let link = run.link, !safe(link) { unsafe.append(run.range) }
        }
        for range in unsafe { a[range].link = nil }
        return a
    }

    /// A tool's one-line summary from blimpd ("Ran `ls`"): what's in backticks as code, without the
    /// backticks; nothing else is Markdown (a glob's `**` isn't bold).
    static func summary(_ s: String) -> AttributedString {
        let parts = s.components(separatedBy: "`")
        guard parts.count >= 3, parts.count % 2 == 1 else { return AttributedString(s) }
        var out = AttributedString()
        for (i, p) in parts.enumerated() {
            var a = AttributedString(p)
            if i % 2 == 1 { a.inlinePresentationIntent = .code }
            out += a
        }
        return out
    }

    static func safe(_ url: URL) -> Bool {
        ["http", "https"].contains(url.scheme?.lowercased() ?? "")
    }
}
