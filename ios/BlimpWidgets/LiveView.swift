// The live panel (docs/superpowers/specs/2026-10-26-phone-live-activity-design.md): one Live Activity, on the lock
// screen and in the Dynamic Island. On top the turn started from the phone, with "Step n of m", a bar and the step in
// progress when Claude keeps a task list; then what needs you, what's new and what's working (the widgets' rows), and
// the counts. blimpd sends what it shows (BlimpKit's LiveState); the timers count up by themselves. A tap opens the
// turn's chat, else the oldest that needs you, else the app. The widgets' symbols, so it reads in one colour.
import ActivityKit
import BlimpKit
import SwiftUI
import WidgetKit

struct LiveWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: BlimpActivityAttributes.self) { context in
            LivePanel(state: context.state).padding(14).widgetURL(LiveText.link(context.state))
        } dynamicIsland: { context in
            let state = context.state
            let compact = LiveText.compact(state.counts)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Text(verbatim: "blimp").font(.headline)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(verbatim: WidgetText.line(state.counts)).font(.caption.weight(.medium))
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        if let turn = state.turn { TurnView(turn: turn) }
                        ForEach(state.rows.prefix(state.turn == nil ? 3 : 2)) { LiveRowView(row: $0) }
                    }
                }
            } compactLeading: {
                Text(verbatim: compact.leading).font(.caption.bold())
            } compactTrailing: {
                if let turn = state.turn {
                    Text(Date(timeIntervalSince1970: turn.since / 1000), style: .timer)
                        .font(.caption.monospacedDigit()).multilineTextAlignment(.trailing).frame(width: 44)
                } else {
                    Text(verbatim: compact.trailing).font(.caption.bold())
                }
            } minimal: {
                Text(verbatim: LiveText.minimal(state.counts)).font(.caption.bold())
            }
            .widgetURL(LiveText.link(state))
        }
    }
}

/// The lock screen's panel: the turn, the rows, then "blimp" and the counts.
struct LivePanel: View {
    let state: LiveState

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let turn = state.turn { TurnView(turn: turn) }
            ForEach(state.rows) { LiveRowView(row: $0) }
            HStack {
                Text(verbatim: "blimp").font(.caption.bold())
                Spacer()
                Text(verbatim: WidgetText.line(state.counts)).font(.caption.weight(.medium)).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The turn started from the phone: its state's symbol, title, project's two letters and a timer from its prompt; with
/// a task list, "Step 4 of 7", the bar, and the step in progress.
struct TurnView: View {
    let turn: LiveState.Turn

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(verbatim: WidgetText.symbol(turn.state)).font(.subheadline.bold()).frame(width: 14)
                Text(verbatim: turn.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                Spacer(minLength: 4)
                Text(verbatim: WidgetText.letters(dir: turn.dir)).font(.caption2.bold()).foregroundStyle(.secondary)
                Text(Date(timeIntervalSince1970: turn.since / 1000), style: .timer)
                    .font(.caption.monospacedDigit()).multilineTextAlignment(.trailing).frame(width: 52)
            }
            if let steps = turn.steps {
                HStack(spacing: 8) {
                    ProgressView(value: LiveText.progress(steps)).tint(Color.primary)
                    Text(verbatim: LiveText.step(steps)).font(.caption.weight(.medium)).fixedSize()
                }
                .padding(.leading, 20)
                if let current = steps.current {
                    Text(verbatim: current).font(.caption).foregroundStyle(.secondary).lineLimit(1).padding(.leading, 20)
                }
            }
        }
    }
}

/// A session under the turn, as a widget's row (RowView) but without a link of its own: the panel has one.
struct LiveRowView: View {
    let row: WidgetSummary.Row

    var body: some View {
        HStack(spacing: 6) {
            Text(verbatim: WidgetText.symbol(row.state)).font(.caption.bold()).frame(width: 14)
            Text(verbatim: row.title).font(.caption).lineLimit(1)
            Spacer(minLength: 4)
            if row.state == .working { ElapsedView(since: row.since) }
            Text(verbatim: WidgetText.letters(dir: row.dir)).font(.caption2.bold()).foregroundStyle(.secondary)
        }
    }
}
