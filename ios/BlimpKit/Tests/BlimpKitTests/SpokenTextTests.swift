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
    #expect(p.spoken == "Claude wants to run bun test. Yes, Yes, and don't ask again for, or No?")
}
