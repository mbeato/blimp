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

@Test func crlfGivesTheSameBlocks() {
    let lf = "# Hi\n\n- a\n- b\n\n```\nx\n\ny\n```\ntext"
    #expect(MarkdownBlock.parse(lf.replacingOccurrences(of: "\n", with: "\r\n")) == MarkdownBlock.parse(lf))
    #expect(MarkdownBlock.parse(lf).count == 4)
}

@Test func starAndPlusBulletsAndBlankLinesInCode() {
    #expect(MarkdownBlock.parse("* a\n* b") == [.bullets(["a", "b"])])
    #expect(MarkdownBlock.parse("+ a\n+ b") == [.bullets(["a", "b"])])
    #expect(MarkdownBlock.parse("```\nx\n\ny\n```") == [.code(language: "", text: "x\n\ny")])
}
