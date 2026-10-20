// How each chat message looks: your prompts as bubbles, Claude's replies as native Markdown,
// tools as one grey line that opens to show what went in and came out.
import BlimpKit
import SwiftUI

struct MessageRow: View {
    let message: ChatMessage
    let expanded: Bool
    let onToggle: () -> Void

    var body: some View {
        switch message.role {
        case .user: UserBubble(text: message.text ?? "")
        case .assistant: AssistantText(text: message.text ?? "")
        case .tool: ToolLine(message: message, expanded: expanded, onToggle: onToggle)
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
                .foregroundStyle(.white)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 18))
        }
    }
}

struct AssistantText: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(MarkdownBlock.parse(text).enumerated()), id: \.offset) { _, block in
                BlockView(block: block)
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct BlockView: View {
    let block: MarkdownBlock

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
        case .code(_, let s), .table(let s):
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

/// Monospace text in a rounded box that scrolls sideways, so long lines keep their shape.
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
    }
}

struct ToolLine: View {
    let message: ChatMessage
    let expanded: Bool
    let onToggle: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(action: onToggle) {
                HStack(spacing: 6) {
                    Image(systemName: Self.symbol(message.name))
                    Text(Inline.summary(message.summary ?? message.name ?? "Tool")).lineLimit(1)
                    Spacer(minLength: 0)
                }
                .font(.footnote)
                .foregroundStyle(message.error == true ? Color.red : Color.secondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if expanded { box }
        }
    }

    @ViewBuilder private var box: some View {
        let input = message.input.flatMap { $0.isEmpty ? nil : $0 }
        let output = message.output.flatMap { $0.isEmpty ? nil : $0 }
        if input != nil || output != nil {
            CodeBox {
                if let input { Text(input) }
                if input != nil, output != nil { Divider() }
                if let output { Text(output).foregroundStyle(message.error == true ? .red : .primary) }
            }
        }
    }

    static func symbol(_ tool: String?) -> String {
        switch tool {
        case "Bash": "terminal"
        case "Edit", "Write": "pencil"
        case "Read": "doc.text"
        case "Grep", "Glob": "magnifyingglass"
        case "Task", "Agent": "person.2"
        default: "wrench"
        }
    }
}

struct WorkingRow: View {
    var body: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text("working…").foregroundStyle(.secondary)
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
