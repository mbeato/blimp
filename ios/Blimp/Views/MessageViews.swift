// How each chat message looks: your prompts as bubbles, Claude's replies as native Markdown (a long
// one folded, with Show more). Tool steps aren't shown; the working row says the latest one.
import BlimpKit
import SwiftUI

struct MessageRow: View {
    let message: ChatMessage

    var body: some View {
        switch message.role {
        case .user: UserBubble(text: message.text ?? "")
        case .assistant: AssistantText(text: message.text ?? "")
        case .tool: EmptyView()
        case .compacted:
            Text("Session compacted")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .accessibilityIdentifier("message.compacted")
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

/// A step smaller than your bubbles. A reply taller than about 12 lines folds to that height, with
/// Show more; read aloud still reads all of it.
struct AssistantText: View {
    let text: String
    @State private var open = false
    @State private var height: CGFloat = 0
    @ScaledMetric(relativeTo: .callout) private var foldHeight: CGFloat = 250

    var body: some View {
        // a little over the fold, so folding never hides just a line or two
        let long = height > foldHeight * 1.2
        let folded = long && !open
        VStack(alignment: .leading, spacing: 6) {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(MarkdownBlock.parse(text).enumerated()), id: \.offset) { _, block in
                    BlockView(block: block)
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

/// The end of the chat while Claude works, or waits on something only the Mac can answer: Stop presses Esc.
struct WorkingRow: View {
    let waiting: Bool
    /// The newest tool step, said after "working…".
    let step: ChatMessage?
    let stopping: Bool
    /// nil where the phone can't type into the session (Open on Mac): no Stop.
    let onStop: (() -> Void)?

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
            if let onStop {
                Button("Stop", systemImage: "stop.fill", action: onStop)
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.small)
                    .tint(.red)
                    .disabled(stopping)
                    .fixedSize()
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
