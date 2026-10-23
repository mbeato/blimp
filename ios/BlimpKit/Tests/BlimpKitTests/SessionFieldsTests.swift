import Foundation
import Testing
@testable import BlimpKit

// What blimpd 0.3 sends, printed by its own listSessions over a made-up transcript (the test fixtures'
// real lines), a hook file, a run, a handoff and a checkout on a branch, with the paths shortened and
// two titles set by hand. web-1 waits on a risky permission, has a running and a failed job, offers two
// commands, has handed off to web-3 and clashes with web-2 (a field the app no longer reads: it decodes all the
// same); web-run is a run of one of its commands.
let sessions03 = #"""
{"type":"sessions","sessions":[
{"name":"web-1","pid":42,"clients":1,"created":1792617036,"dir":"/home/u/web","cmd":"claude","kind":"claude","sessionId":"s1","transcript":"/home/u/.claude/projects/p/s1.jsonl","title":"Fix the phone login","status":"waiting","updatedAt":1792624236489,"state":"waiting","stateSince":1792624236489,"prompt":{"kind":"permission","tool":"Bash","summary":"Ran `git push --force origin feat-x`","options":["Yes","No"],"keys":["1","\u001b"],"answerable":true,"input":"git push --force origin feat-x","risky":true,"at":1792624235489},"unread":true,"jobs":[{"id":"b1lysb74d","kind":"bash","label":"Run isolated blimpd benchmark","startedAt":1792623156489,"status":"running","outputFile":"/tmp/claude-1000/-home-u-web/s1/tasks/b1lysb74d.output"},{"id":"b5bbkbpfm","kind":"bash","label":"Watch the phone run for the fix","startedAt":1792623276489,"status":"failed","outputFile":"/tmp/claude-1000/-home-u-web/s1/tasks/b5bbkbpfm.output","endedAt":1792623336489,"exit":1}],"context":{"used":621072,"limit":1000000},"git":{"cwd":"/home/u/web","branch":"feat-x"},"runnable":["npm run e2e","bun test ./test"],"runnableAt":1792623456489,"handoff":{"state":"started","child":"web-3","file":"notes/2026-10-22/HANDOFF-web.md"},"work":{"branch":"feat-x","root":"/home/u/web","prs":[{"number":42,"title":"Phone answers prompts","state":"OPEN","url":"https://github.com/x/y/pull/42"}],"clash":[{"session":"web-2","reason":"branch"},{"session":"web-2","reason":"files","files":["app/src/lib/browser.ts"]}]}},
{"name":"web-2","pid":43,"clients":0,"created":1792617037,"dir":"/home/u/web","cmd":"claude","kind":"claude","sessionId":"s2","transcript":"/home/u/.claude/projects/p/s2.jsonl","title":"Tidy the README","status":"idle","updatedAt":1792624236489,"state":"done","stateSince":1792624236489,"unread":false,"context":{"used":102816,"limit":1000000},"git":{"cwd":"/home/u/web","branch":"feat-x"},"work":{"branch":"feat-x","root":"/home/u/web","prs":[{"number":42,"title":"Phone answers prompts","state":"OPEN","url":"https://github.com/x/y/pull/42"}],"clash":[{"session":"web-1","reason":"branch"},{"session":"web-1","reason":"files","files":["app/src/lib/browser.ts"]}],"worktree":true}},
{"name":"web-run","pid":45,"clients":0,"created":1792617039,"dir":"/home/u/web","cmd":"","kind":"run","label":"Run","title":"bun test ./test","status":"","state":"unknown","unread":false,"run":{"command":"bun test ./test","parent":"web-1","cwd":"/home/u/web","startedAt":1792623936489,"endedAt":1792623996489,"exit":1}},
{"name":"web-3","pid":44,"clients":0,"created":1792624176,"dir":"/home/u/web","cmd":"claude","kind":"claude","title":"(new session)","status":"","state":"unknown","unread":false,"parent":"web-1"}
]}
"""#

let planPrompt03 = #"""
{"kind":"permission","tool":"ExitPlanMode","summary":"ExitPlanMode","options":["Yes, and use auto mode","Yes, manually approve edits","No, keep planning"],"keys":["1","2","\u001b"],"answerable":true,"plan":"## Plan\n\n1. Add the toggle\n2. Test it","at":1792624235489}
"""#

private func list03() throws -> [Session] {
    guard case .sessions(let list) = EventsMessage.decode(Data(sessions03.utf8)) else { throw DecodeFailed() }
    return list
}
private struct DecodeFailed: Error {}

@Test func decodesEveryFieldBlimpd03Adds() throws {
    let list = try list03()
    #expect(list.map(\.name) == ["web-1", "web-2", "web-run", "web-3"])
    let s = list[0]
    #expect(s.jobs?.map(\.id) == ["b1lysb74d", "b5bbkbpfm"])
    #expect(s.jobs?[0] == Job(id: "b1lysb74d", kind: .bash, label: "Run isolated blimpd benchmark", startedAt: 1792623156489, status: .running,
                             outputFile: "/tmp/claude-1000/-home-u-web/s1/tasks/b1lysb74d.output"))
    #expect(s.jobs?[1].status == .failed && s.jobs?[1].exit == 1 && s.jobs?[1].endedAt == 1792623336489)
    #expect(s.context == ContextWindow(used: 621072, limit: 1000000))
    #expect(s.git == Git(cwd: "/home/u/web", branch: "feat-x"))
    #expect(s.runnable == ["npm run e2e", "bun test ./test"])
    #expect(s.runnableAt == 1792623456489)
    #expect(s.handoff == Handoff(state: .started, child: "web-3", file: "notes/2026-10-22/HANDOFF-web.md"))
    #expect(s.work?.branch == "feat-x" && s.work?.root == "/home/u/web" && s.work?.worktree == nil)
    #expect(s.work?.prs == [PullRequest(number: 42, title: "Phone answers prompts", state: "OPEN", url: "https://github.com/x/y/pull/42")])
    #expect(s.parent == nil && s.run == nil)
    let p = try #require(s.prompt)
    #expect(p.input == "git push --force origin feat-x")
    #expect(p.risky == true)
    #expect(p.plan == nil)
    #expect(list[1].work?.worktree == true)
    let run = try #require(list[2].run)
    #expect(list[2].kind == "run" && list[2].label == "Run" && list[2].title == "bun test ./test")
    #expect(run == Run(command: "bun test ./test", parent: "web-1", cwd: "/home/u/web", startedAt: 1792623936489, endedAt: 1792623996489, exit: 1))
    #expect(run.ended)
    #expect(list[3].parent == "web-1")
    #expect(list[3].jobs == nil && list[3].context == nil && list[3].work == nil && list[3].handoff == nil)
}

@Test func decodesAPlanApprovalWithItsPlanAndScreenOptions() throws {
    let p = try JSONDecoder().decode(Prompt.self, from: Data(planPrompt03.utf8))
    #expect(p.tool == "ExitPlanMode")
    #expect(p.plan == "## Plan\n\n1. Add the toggle\n2. Test it")
    #expect(p.choices == ["Yes, and use auto mode", "Yes, manually approve edits", "No, keep planning"])
    #expect(p.input == nil && p.risky == nil)
}

@Test func aNewFieldThatDoesntDecodeIsNilNotADroppedSession() throws {
    let json = #"{"name":"x","created":1,"dir":"/","kind":"claude","title":"t","state":"done","context":{"used":"lots"},"git":7,"handoff":{"state":"pondering"},"#
        + #""runnable":"npm test","work":{"branch":3},"run":{"command":"ls"},"#
        + #""jobs":[{"id":"a","kind":"bash","label":"l","startedAt":1,"status":"running"},{"id":"b"},{"id":"c","kind":"teleport","label":"l","startedAt":2,"status":"paused"}]}"#
    let s = try JSONDecoder().decode(Session.self, from: Data(json.utf8))
    #expect(s.context == nil && s.git == nil && s.runnable == nil && s.work == nil && s.run == nil)
    // A state or kind this app doesn't know yet still decodes.
    #expect(s.handoff?.state == .unknown)
    #expect(s.jobs?.map(\.id) == ["a", "c"])
    #expect(s.jobs?.last?.kind == .other && s.jobs?.last?.status == .unknown)
}

@Test func anOlderBlimpdsSessionHasNoneOfTheNewFields() throws {
    let s = try JSONDecoder().decode(Session.self, from: Data(sessionJSON.utf8))
    #expect(s.jobs == nil && s.context == nil && s.git == nil && s.handoff == nil && s.parent == nil)
    #expect(s.runnable == nil && s.runnableAt == nil && s.run == nil && s.work == nil)
    #expect(s.prompt?.input == nil && s.prompt?.plan == nil && s.prompt?.risky == nil)
}

@Test func decodesAHandoffAsPostReturnsIt() throws {
    #expect(try JSONDecoder().decode(Handoff.self, from: Data(#"{"state":"writing"}"#.utf8)) == Handoff(state: .writing))
    let failed = try JSONDecoder().decode(Handoff.self, from: Data(#"{"state":"failed","error":"Claude didn't write a handoff in 20 minutes"}"#.utf8))
    #expect(failed.error == "Claude didn't write a handoff in 20 minutes")
}
