// The assistant's jobs bar, on top of its chat (docs/superpowers/specs/2026-10-26-assistant-design.md, section 4):
// folded, one line of counts ("1 needs you · 2 working · 1 done"); a tap unfolds a row per job, each with its mark,
// "project · reason" and what it asks or its note. A row opens that job's chat, whose back arrow comes back here. No
// job to show: no bar. Folded each time the chat opens.
import BlimpKit
import SwiftUI

struct JobsBar: View {
    let rows: [AssistantJobRow]
    /// Opens a job's chat, by its session's name.
    let onOpen: (String) -> Void
    @State private var open = false

    var body: some View {
        if let counts = AssistantJobs.counts(rows) {
            VStack(alignment: .leading, spacing: 0) {
                Button {
                    withAnimation(.snappy) { open.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .rotationEffect(.degrees(open ? 90 : 0))
                        Text(counts).font(.subheadline)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal)
                    .padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .foregroundStyle(.primary)
                .accessibilityLabel("Jobs, \(counts)")
                .accessibilityHint(open ? "Folds the jobs away" : "Shows each job")
                .accessibilityIdentifier("jobsBar")
                if open {
                    ForEach(rows) { row($0) }
                }
                Divider()
            }
            .background(.bar)
        }
    }

    private func row(_ r: AssistantJobRow) -> some View {
        Button { onOpen(r.session) } label: {
            HStack(alignment: .top, spacing: 8) {
                MarkView(mark: r.mark)
                VStack(alignment: .leading, spacing: 2) {
                    Text(r.project + " · " + r.reason).font(.subheadline).lineLimit(1)
                    if let words = r.words {
                        Text(words).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .foregroundStyle(.primary)
        .accessibilityIdentifier("job-" + r.session)
    }
}
