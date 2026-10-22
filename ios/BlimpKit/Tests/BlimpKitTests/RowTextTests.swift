import Foundation
import Testing
@testable import BlimpKit

// The same cases as the Mac's (app/src/lib/jobs.test.ts, handoff.test.ts, work.test.ts), plus the phone's
// running time in the jobs caption.

private let minute: Double = 60_000
private let now: Double = 1_000_000_000

private func job(_ id: String, _ status: JobStatus = .running, started: Double = now - 5 * minute, ended: Double? = nil, exit: Int? = nil) -> Job {
    Job(id: id, kind: .bash, label: "Job \(id)", startedAt: started, status: status, endedAt: ended, exit: exit)
}

private func row(_ name: String, state: SessionState = .done, title: String? = nil, id: String? = "s", handoff: Handoff? = nil,
                 work: Work? = nil, run: Run? = nil) -> Session {
    var s = Session(name: name, created: 1, dir: "/w", kind: "claude", label: nil, sessionId: id, title: title ?? name.uppercased(),
                    updatedAt: nil, state: state, stateSince: nil, prompt: nil)
    s.handoff = handoff
    s.work = work
    s.run = run
    return s
}

@Test func aSessionWithoutJobsHasNoJobsCaption() {
    #expect(JobsText.caption(nil, now: now) == nil)
    #expect(JobsText.caption([], now: now) == nil)
}

@Test func theJobsCaptionCountsTheJobsThatRunAndHowLongTheOldestHas() {
    #expect(JobsText.caption([job("a")], now: now) == "1 job · 5m")
    #expect(JobsText.caption([job("a", started: now - 14 * minute), job("b"), job("c", .done, ended: now - minute)], now: now) == "2 jobs · 14m")
    #expect(JobsText.caption([job("a", started: now - 20_000)], now: now) == "1 job · <1m")
}

@Test func withNoneRunningAJobThatFinishedInTheLast30MinutesIsJobDone() {
    #expect(JobsText.caption([job("a", .done, ended: now - 29 * minute, exit: 0)], now: now) == "job done")
    #expect(JobsText.caption([job("a", .failed, ended: now - minute, exit: 1)], now: now) == "job done")
}

@Test func aJobThatFinishedOver30MinutesAgoOrWasStoppedIsntMentioned() {
    #expect(JobsText.caption([job("a", .done, ended: now - 31 * minute)], now: now) == nil)
    #expect(JobsText.caption([job("a", .stopped, ended: now - minute)], now: now) == nil)
}

@Test func howLongAJobHasRunReadsAsMinutesThenHoursAndMinutesThenDays() {
    #expect(JobsText.duration(20_000) == "<1m")
    #expect(JobsText.duration(12 * minute + 59_000) == "12m")
    #expect(JobsText.duration(65 * minute) == "1h 5m")
    #expect(JobsText.duration(120 * minute) == "2h")
    #expect(JobsText.duration(50 * 60 * minute) == "2d")
    #expect(JobsText.duration(-5) == "<1m")
}

@Test func aJobsStateIsItsRunningTimeOrHowItEndedWithItsExitCode() {
    #expect(JobsText.state(job("a", started: now - 12 * minute), now: now) == "12m")
    #expect(JobsText.state(job("a", .done, exit: 0), now: now) == "done · exit 0")
    #expect(JobsText.state(job("a", .done), now: now) == "done")
    #expect(JobsText.state(job("a", .failed, exit: 1), now: now) == "failed · exit 1")
    #expect(JobsText.state(job("a", .failed), now: now) == "failed")
    #expect(JobsText.state(job("a", .stopped), now: now) == "stopped")
    #expect(JobsText.kindWord(.bash) == "Command" && JobsText.kindWord(.monitor) == "Monitor")
    #expect(JobsText.kindWord(.agent) == "Agent" && JobsText.kindWord(.workflow) == "Workflow")
}

@Test func tokenCountsReadAs950And620kAnd1M() {
    let shown = [950, 620_000, 255_009, 200_000, 1_000_000, 1_048_576, 1_500_000].map(ContextText.tokens)
    #expect(shown == ["950", "620k", "255k", "200k", "1M", "1M", "1.5M"])
}

@Test func theContextMeterShowsFromHalfFullAndInRedFrom80Percent() {
    #expect(ContextText.meter(nil) == nil)
    #expect(ContextText.meter(ContextWindow(used: 499_000, limit: 1_000_000)) == nil)
    #expect(ContextText.meter(ContextWindow(used: 10, limit: 0)) == nil)
    #expect(ContextText.meter(ContextWindow(used: 620_000, limit: 1_000_000))
        == ContextMeter(percent: 62, fraction: 0.62, high: false, label: "Context 62% (620k of 1M tokens)"))
    // Shown as 80%, so red too.
    #expect(ContextText.meter(ContextWindow(used: 795_000, limit: 1_000_000))
        == ContextMeter(percent: 80, fraction: 0.795, high: true, label: "Context 80% (795k of 1M tokens)"))
    #expect(ContextText.meter(ContextWindow(used: 160_000, limit: 200_000))?.label == "Context 80% (160k of 200k tokens)")
    // Over the window (an old limit for a model): the gauge stops at full.
    #expect(ContextText.meter(ContextWindow(used: 250_000, limit: 200_000))
        == ContextMeter(percent: 125, fraction: 1, high: true, label: "Context 125% (250k of 200k tokens)"))
}

@Test func aRowSaysWritingHandoffThenHandedOffOnceItsIdleAndWaitingWins() {
    #expect(HandoffText.words(row("a")) == nil)
    #expect(HandoffText.words(row("a", state: .working, handoff: Handoff(state: .writing))) == "Writing handoff")
    #expect(HandoffText.words(row("a", state: .working, handoff: Handoff(state: .started, child: "b"))) == nil)
    #expect(HandoffText.words(row("a", handoff: Handoff(state: .started, child: "b"))) == "Handed off")
    #expect(HandoffText.words(row("a", state: .waiting, handoff: Handoff(state: .writing))) == nil)
    #expect(HandoffText.words(row("a", handoff: Handoff(state: .failed, error: "x"))) == nil)
}

@Test func aHandoffAnOlderBlimpdCantDoSaysToUpdateIt() {
    #expect(HandoffText.failure("not found") == "This server's blimpd is too old to continue in a new session. Update it first.")
    #expect(HandoffText.failure("no session named x") == "Couldn't continue in a new session: no session named x")
}

@Test func theBranchCaptionAndLineSayWhichBranchAndAWorktree() {
    #expect(WorkText.branch(row("a")) == nil)
    #expect(WorkText.branchLine(row("a", work: Work(root: "/w"))) == nil)
    #expect(WorkText.branch(row("a", work: Work(branch: "feat-x"))) == "feat-x")
    #expect(WorkText.branchLine(row("a", work: Work(branch: "feat-x"))) == "On branch feat-x")
    #expect(WorkText.branchLine(row("a", work: Work(branch: "feat-x", worktree: true))) == "On branch feat-x (worktree)")
}

@Test func theRealListsJobsAndContextReadAsTheMacsDo() throws {
    guard case .sessions(let list) = EventsMessage.decode(Data(sessions03.utf8)) else { Issue.record("no sessions"); return }
    #expect(JobsText.caption(list[0].jobs, now: 1792624236489) == "1 job · 18m")
    #expect(ContextText.meter(list[0].context)?.label == "Context 62% (621k of 1M tokens)")
    #expect(ContextText.meter(list[1].context) == nil)
}
