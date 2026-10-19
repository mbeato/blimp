import Testing
@testable import BlimpKit

@Test func blocks() {
    let md = """
    # Done

    I fixed **two** things:
    - the `parser`
    - the tests, which
      were flaky
    1. one
    2. two

    ```ts
    const x = 1;
    # not a heading
    ```
    > quoted
    > more
    | a | b |
    |---|---|
    ---
    last line
    """
    #expect(MarkdownBlock.parse(md) == [
        .heading(level: 1, text: "Done"),
        .paragraph("I fixed **two** things:"),
        .bullets(["the `parser`", "the tests, which were flaky"]),
        .numbered(["one", "two"]),
        .code(language: "ts", text: "const x = 1;\n# not a heading"),
        .quote("quoted\nmore"),
        .table("| a | b |\n|---|---|"),
        .rule,
        .paragraph("last line"),
    ])
}

@Test func anUnclosedCodeBlockRunsToTheEnd() {
    #expect(MarkdownBlock.parse("```\nabc") == [.code(language: "", text: "abc")])
}
