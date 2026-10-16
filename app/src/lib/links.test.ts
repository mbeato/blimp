import { expect, test } from "bun:test";
import { followsLink, webUrl } from "./links";

test("only http and https links are web links", () => {
  expect(webUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
  expect(webUrl("http://example.com")).toBe("http://example.com/");
  for (const href of ["javascript:alert(1)", "JavaScript:alert(1)", "file:///etc/passwd", "data:text/html,<b>x</b>", "vscode://x", "notes.md", "/abs", "#top", ""])
    expect(webUrl(href)).toBeNull();
});

test("a terminal link opens on ⌘-click on the Mac, Ctrl-click elsewhere, never on a plain click", () => {
  const click = (mods: { metaKey?: boolean; ctrlKey?: boolean }) => ({ metaKey: false, ctrlKey: false, ...mods });
  expect(followsLink(click({ metaKey: true }), true)).toBe(true);
  expect(followsLink(click({ ctrlKey: true }), true)).toBe(false);
  expect(followsLink(click({}), true)).toBe(false);
  expect(followsLink(click({ ctrlKey: true }), false)).toBe(true);
  expect(followsLink(click({ metaKey: true }), false)).toBe(false);
  expect(followsLink(click({}), false)).toBe(false);
});
