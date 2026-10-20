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
        .numbered(start: 1, items: ["one", "two"]),
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

@Test func aNumberedListKeepsItsNumbersAndFoldsIndentedLinesIntoTheItem() {
    // Claude's usual shape: an item, its indented sub-bullets, the next item. One list, numbered 1, 2.
    #expect(MarkdownBlock.parse("1. Foo\n   - sub\n   more\n2. Bar") == [.numbered(start: 1, items: ["Foo - sub more", "Bar"])])
    // A list that continues after a paragraph starts at its own number.
    #expect(MarkdownBlock.parse("1. a\n\nThen:\n\n2. b\n3. c") == [
        .numbered(start: 1, items: ["a"]), .paragraph("Then:"), .numbered(start: 2, items: ["b", "c"]),
    ])
}
