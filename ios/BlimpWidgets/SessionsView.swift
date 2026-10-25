// What each widget shows (BlimpWidgets.swift says where it comes from): the counts, the rows (a tap on one opens its
// chat), "All quiet", or why there's nothing to show. Greyed with "as of" when it's the last summary, not a new one.
// Each state has its own symbol, so a widget reads right when iOS tints it one colour.
import BlimpKit
import SwiftUI
import WidgetKit

struct SessionsView: View {
    @Environment(\.widgetFamily) private var family
    let entry: Entry

    var body: some View {
        switch entry.status {
        case .notSetUp:
            MessageView(text: "Open blimp to set up its widgets")
        case .needsUpdate:
            MessageView(text: "Update blimpd for widgets")
        case .fresh, .stale:
            if let summary = entry.summary {
                content(summary, stale: entry.status == .stale).opacity(entry.status == .stale ? 0.5 : 1)
            } else {
                MessageView(text: "Can't reach the server")
            }
        }
    }

    @ViewBuilder private func content(_ s: WidgetSummary, stale: Bool) -> some View {
        switch family {
        case .accessoryInline:
            Text(verbatim: WidgetText.line(s.counts)).widgetURL(link(s))
        case .accessoryCircular:
            CircleView(counts: s.counts).widgetURL(link(s))
        case .accessoryRectangular:
            RectangleView(summary: s, stale: stale).widgetURL(link(s))
        case .systemSmall:
            SmallView(summary: s, stale: stale).widgetURL(link(s))
        case .systemLarge:
            RowsView(summary: s, rows: 9, stale: stale)
        default:
            RowsView(summary: s, rows: 4, stale: stale)
        }
    }

    /// The oldest that needs you, else just the app.
    private func link(_ s: WidgetSummary) -> URL {
        s.rows.first(where: { $0.state == .needs }).map { WidgetLink.url(session: $0.session) } ?? WidgetLink.app
    }
}

struct MessageView: View {
    let text: String

    var body: some View {
        Text(verbatim: text).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
            .widgetURL(WidgetLink.app)
    }
}

/// "as of 10:42": the summary is the last one the widget had, not a new one.
struct AsOf: View {
    let at: Double

    var body: some View {
        Text("as of \(Date(timeIntervalSince1970: at / 1000), style: .time)").font(.caption2).foregroundStyle(.secondary)
    }
}

/// "All quiet", and when the last session finished.
struct QuietView: View {
    let lastFinished: Double?

    var body: some View {
        Text(verbatim: WidgetText.quiet).font(.subheadline.weight(.medium))
        if let t = lastFinished {
            Text("Last finished \(Date(timeIntervalSince1970: t / 1000), style: .relative) ago").font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct SmallView: View {
    let summary: WidgetSummary
    let stale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if WidgetText.isQuiet(summary.counts) {
                QuietView(lastFinished: summary.lastFinished)
            } else {
                ForEach(WidgetText.countLines(summary.counts), id: \.self) { Text(verbatim: $0).font(.subheadline.weight(.medium)) }
            }
            Spacer(minLength: 0)
            if stale { AsOf(at: summary.at) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct RowsView: View {
    let summary: WidgetSummary
    let rows: Int
    let stale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(verbatim: "blimp").font(.headline)
                Spacer()
                if !WidgetText.isQuiet(summary.counts) {
                    Text(verbatim: WidgetText.line(summary.counts)).font(.caption.weight(.medium)).foregroundStyle(.secondary)
                }
            }
            if WidgetText.isQuiet(summary.counts) { QuietView(lastFinished: summary.lastFinished) }
            ForEach(summary.rows.prefix(rows)) { RowView(row: $0) }
            Spacer(minLength: 0)
            if stale { AsOf(at: summary.at) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A session: its state's symbol, its title, a working one's time, its project's two letters. A tap opens its chat.
struct RowView: View {
    let row: WidgetSummary.Row

    var body: some View {
        Link(destination: WidgetLink.url(session: row.session)) {
            HStack(spacing: 6) {
                Text(verbatim: WidgetText.symbol(row.state)).font(.caption.bold()).frame(width: 12)
                Text(verbatim: row.title).font(.caption).lineLimit(1)
                Spacer(minLength: 4)
                if row.state == .working { ElapsedView(since: row.since) }
                Text(verbatim: WidgetText.letters(dir: row.dir)).font(.caption2.bold()).foregroundStyle(.secondary)
            }
        }
    }
}

/// A working row's time: a timer that counts up by itself under an hour, then "3h" or "2d".
struct ElapsedView: View {
    let since: Double

    var body: some View {
        if let text = WidgetText.elapsed(since: since, now: Date.now.timeIntervalSince1970 * 1000) {
            Text(verbatim: text).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
        } else {
            Text(Date(timeIntervalSince1970: since / 1000), style: .timer)
                .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                .multilineTextAlignment(.trailing).frame(width: 40)
        }
    }
}

/// The lock screen's rectangle: the counts, then the top two titles.
struct RectangleView: View {
    let summary: WidgetSummary
    let stale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(verbatim: WidgetText.line(summary.counts)).font(.headline).widgetAccentable()
            ForEach(summary.rows.prefix(2)) { row in
                Text(verbatim: "\(WidgetText.symbol(row.state)) \(row.title)").font(.caption).lineLimit(1)
            }
            if stale { AsOf(at: summary.at) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The lock screen's circle: the needs-you count with ?, else the working count with ●, else ✓.
struct CircleView: View {
    let counts: WidgetSummary.Counts

    var body: some View {
        let c = WidgetText.circle(counts)
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                Text(verbatim: c.symbol).font(.caption.bold())
                if let n = c.count { Text(verbatim: "\(n)").font(.title3.bold()).widgetAccentable() }
            }
        }
    }
}
