import Testing
@testable import BlimpKit

@Test func speaksTheReplyNotTheCode() {
    let md = """
    ## Fixed

    I changed `parse` in [the parser](https://x.dev/p) and **src/app/lib/parser.ts**.

    ```ts
    const a = 1
    ```
    | a | b |
    |---|---|
    - first point
    - second point
    See https://example.com/docs for more
    """
    #expect(SpokenText.from(markdown: md) ==
        "Fixed. I changed parse in the parser and parser.ts. code skipped. code skipped. first point. second point. See link for more.")
}

@Test func longInlineCodeIsSkipped() {
    #expect(SpokenText.from(markdown: "Run `bun test --filter something-very-long-and-specific-here` now") == "Run code skipped now.")
}

@Test func promptSpoken() throws {
    let p = Prompt(kind: .permission, at: 1, answerable: true, tool: "Bash", summary: "Ran `bun test`",
                   options: ["Yes", "Yes, and don't ask again for bun test commands in /home/u/blimp", "No"], questions: nil)
    #expect(p.spoken == "Claude wants to run bun test. Yes, Yes, and don't ask again, or No?")
}

@Test func longCommandIsNotReadInFull() {
    let long = Prompt(kind: .permission, at: 1, answerable: true, tool: "Bash",
                      summary: "Ran `bun test --filter something-very-long-and-specific-here-and-more`", options: ["Yes", "No"], questions: nil)
    #expect(long.spoken == "Claude wants to run a command. Yes or No?")
    let edit = Prompt(kind: .permission, at: 1, answerable: true, tool: "Edit",
                      summary: "Edited `/home/u/a/b/x.ts`", options: ["Yes", "No"], questions: nil)
    #expect(edit.spoken == "Claude wants to edit x.ts. Yes or No?")
}

@Test func questionGetsABreakBeforeItsOptions() {
    let q = Question(question: "Which colour", header: nil, multiSelect: false,
                     options: [QuestionOption(label: "Red", description: nil), QuestionOption(label: "Green", description: nil)])
    let p = Prompt(kind: .question, at: 1, answerable: true, tool: nil, summary: nil, options: nil, questions: [q])
    #expect(p.spoken == "Which colour. Red or Green?")
}

@Test func linksWithCodeAndImages() {
    #expect(SpokenText.from(markdown: "See [`parse`](https://x.dev/p) now") == "See parse now.")
    #expect(SpokenText.from(markdown: "Look ![a chart](https://x.dev/c.png) here") == "Look a chart here.")
    #expect(SpokenText.from(markdown: "Look ![](https://x.dev/c.png) here") == "Look here.")
}
