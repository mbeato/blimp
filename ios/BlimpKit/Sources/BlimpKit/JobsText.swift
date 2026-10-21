// Background work Claude started (Session.jobs): what a session's row says about it and the words for each
// job, with the Mac's rules (app/src/lib/jobs.ts). Times are ms, like blimpd's.
import Foundation

public enum JobsText {
    /// A finished job is mentioned this long (blimpd keeps them as long).
    public static let recent: Double = 30 * 60_000

    /// The row's caption: "2 jobs · 14m" while some run (how long the oldest of them has), else "job done"
    /// for 30 minutes after one finished or failed. A stopped one isn't news (Claude or a restart stopped
    /// it), so it's left out. nil: nothing to say.
    public static func caption(_ jobs: [Job]?, now: Double) -> String? {
        let running = (jobs ?? []).filter { $0.status == .running }
        if let oldest = running.map(\.startedAt).min() {
            return (running.count == 1 ? "1 job" : "\(running.count) jobs") + " · " + duration(now - oldest)
        }
        let finished = (jobs ?? []).contains { ($0.status == .done || $0.status == .failed) && now - ($0.endedAt ?? 0) < recent }
        return finished ? "job done" : nil
    }

    /// How long something has run: "<1m", "12m", "1h 5m", "2h", "2d".
    public static func duration(_ ms: Double) -> String {
        let m = Int((max(0, ms) / 60_000).rounded(.down))
        if m < 1 { return "<1m" }
        if m < 60 { return "\(m)m" }
        let h = m / 60
        if h < 24 { return m % 60 == 0 ? "\(h)h" : "\(h)h \(m % 60)m" }
        return "\(h / 24)d"
    }

    /// A job's state in its line: how long it has run, or how it ended ("done · exit 0", "failed · exit 1", "stopped").
    public static func state(_ job: Job, now: Double) -> String {
        if job.status == .running { return duration(now - job.startedAt) }
        let word = job.status == .unknown ? "ended" : job.status.rawValue
        return job.exit.map { "\(word) · exit \($0)" } ?? word
    }

    /// The job's kind as a word: Command, Monitor, Agent, Workflow.
    public static func kindWord(_ kind: JobKind) -> String {
        switch kind {
        case .bash: "Command"
        case .monitor: "Monitor"
        case .agent: "Agent"
        case .workflow: "Workflow"
        case .other: "Job"
        }
    }
}
