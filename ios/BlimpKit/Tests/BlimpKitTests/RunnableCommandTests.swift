import Foundation
import Testing
@testable import BlimpKit

// The same cases as blimpd's (test/runnable.test.ts): the phone and blimpd must agree on what a command is.

private func all(_ texts: [String]) -> [String] { RunnableCommand.all(in: texts) }

@Test func aBashBlockIsOneCommandWholeWithItsPromptsTakenOff() {
    #expect(all(["Run this:\n\n```bash\n$ cd ~/blimp\n$ bun test ./test\n```\n\nThen tell me."]) == ["cd ~/blimp\nbun test ./test"])
}

@Test func shShellZshAndConsoleBlocksCountOtherLanguagesAndPlainBlocksDont() {
    let block = { (lang: String, cmd: String) in "```" + lang + "\n" + cmd + "\n```" }
    let text = [block("sh", "a"), block("shell", "b"), block("zsh", "c"), block("console", "d"), block("ts", "e"), block("", "f"), block("Bash", "g")].joined(separator: "\n\n")
    #expect(all([text]) == ["g", "d", "c", "b", "a"])
}

@Test func inlineCodeThatStartsWithACommandWordCountsOneLineEach() {
    let text = "Try `bun run e2e copy.spec.ts`, or `npm test`. The file is `src/x.ts` and `bunx` alone isn't one; `python3 -m http.server` and `cd app && bun i` are."
    #expect(all([text]) == ["cd app && bun i", "python3 -m http.server", "npm test", "bun run e2e copy.spec.ts"])
}

@Test func inlineBangCommandIsACommandWhateverItsFirstWord() {
    let text = "Run this yourself: `! bash /private/tmp/claude-501/x.sh`, then `! gh workflow run deploy.yml --ref main`. Not `!important` or `!=`."
    #expect(all([text]) == ["gh workflow run deploy.yml --ref main", "bash /private/tmp/claude-501/x.sh"])
}

@Test func aBareCdIsLeftOut() {
    #expect(all(["Go `cd app`, `cd \"my dir\"` or `! cd ~/x`, then `cd app; ls`."]) == ["cd app; ls"])
}

@Test func aBlockWithPromptsAndOutputGivesOnlyThePromptedLinesAndTheirContinuations() {
    #expect(all(["```console\n$ npm test\n> x@1 test\n> jest\nPASS\n```"]) == ["npm test"])
    #expect(all(["```bash\n$ ls\nfile1\nfile2\n$ docker run \\\n  -it x\nhello\n```"]) == ["ls\ndocker run \\\n  -it x"])
    #expect(all(["```bash\ncd app\nbun i\n```"]) == ["cd app\nbun i"])
}

@Test func blocksAndInlineCodeInTheOrderTheyCome() {
    #expect(all(["Try `npm a`, then:\n\n```bash\nnpm b\n```\n\nor `npm c`."]) == ["npm c", "npm b", "npm a"])
}

@Test func inlineCodeInsideAFencedBlockIsntReadAgain() {
    #expect(all(["```bash\necho `node -v`\n```"]) == ["echo `node -v`"])
}

@Test func newestFirstAcrossTheTextsAtMostFiveTheSameCommandOnce() {
    #expect(all(["`npm a`", "`npm b`\n`npm c`", "`npm d` `npm e` `npm f` `npm b`"]) == ["npm b", "npm f", "npm e", "npm d", "npm c"])
}

@Test func aBlockOver4000CharactersAnEmptyOneAndAnUnclosedOneAreLeftOut() {
    let long = "```bash\n" + String(repeating: "x", count: 4001) + "\n```"
    #expect(all([long, "```bash\n\n```", "```bash\necho never closed"]) == [])
    #expect(all(["```bash\n" + String(repeating: "x", count: 4000) + "\n```"]) == [String(repeating: "x", count: 4000)])
}

@Test func aLongerFenceClosesOnlyOnOneAsLongAndAnIndentedFenceCounts() {
    #expect(all(["````bash\necho ```\n````\n\n  ```sh\n  ls -la\n  ```"]) == ["ls -la", "echo ```"])
}

@Test func noTextsNoCommands() {
    #expect(all([]) == [])
}

@Test func aCodeBlockOnScreenOffersRunOnlyForACommandBlimpdListed() {
    // As MarkdownBlock.parse gives a block: the text after the fence, and the lines inside.
    #expect(RunnableCommand.block(language: "bash", text: "$ bun test ./test") == "bun test ./test")
    #expect(RunnableCommand.block(language: "sh title=x", text: "ls\n") == "ls")
    #expect(RunnableCommand.block(language: "ts", text: "let x = 1") == nil)
    #expect(RunnableCommand.block(language: "bash", text: "") == nil)
    let runnable = ["npm run e2e", "bun test ./test"]
    #expect(RunnableCommand.offered(language: "bash", text: "$ bun test ./test", runnable: runnable) == "bun test ./test")
    #expect(RunnableCommand.offered(language: "bash", text: "rm -rf build", runnable: runnable) == nil)
    #expect(RunnableCommand.offered(language: "bash", text: "bun test ./test", runnable: nil) == nil)
    // Each block of a parsed reply, the way the chat finds them.
    let reply = "Done. Run this to check:\n\n```bash\n$ bun test ./test\n```\n\nor `npm run e2e`."
    let offered = MarkdownBlock.parse(reply).compactMap { b -> String? in
        guard case .code(let lang, let text) = b else { return nil }
        return RunnableCommand.offered(language: lang, text: text, runnable: all([reply]))
    }
    #expect(offered == ["bun test ./test"])
}

@Test func aCommandOnOneLineForAButton() {
    #expect(RunnableCommand.oneLine("cd app\n  bun i\n\nbun test") == "cd app ⏎ bun i ⏎ bun test")
}

@Test func aCommandsRunIsTheNewestOneSinceTheReplyBegan() throws {
    guard case .sessions(let list) = EventsMessage.decode(Data(sessions03.utf8)) else { Issue.record("no sessions"); return }
    let s = try #require(list.first { $0.name == "web-1" })
    #expect(s.latestRun(of: "bun test ./test", in: list)?.name == "web-run")
    #expect(s.latestRun(of: "npm run e2e", in: list) == nil)
    // A run from before the reply began is an older reply's.
    var later = s
    later.runnableAt = 1792623936490
    #expect(later.latestRun(of: "bun test ./test", in: list) == nil)
}
