import { expect, test } from "bun:test";
import { pageFile, pageFileName, pageTitle, shownUrl, typedUrl } from "./browser";

const portTab = { port: { port: 3000, host: "127.0.0.1" as const }, base: "http://127.0.0.1:53211" };
const plain = { base: null };

test("a port tab shows its forward as the server's localhost:<port>", () => {
  expect(shownUrl(portTab, "http://127.0.0.1:53211")).toBe("localhost:3000/");
  expect(shownUrl(portTab, "http://127.0.0.1:53211/a?b=1")).toBe("localhost:3000/a?b=1");
  expect(shownUrl(portTab, "http://127.0.0.1:532110/x")).toBe("http://127.0.0.1:532110/x");
  expect(shownUrl(portTab, "https://github.com/")).toBe("https://github.com/");
  expect(shownUrl(plain, null)).toBe("");
});

test("typed addresses", () => {
  expect(typedUrl(plain, "https://example.com/x")).toBe("https://example.com/x");
  expect(typedUrl(plain, "  example.com/docs ")).toBe("https://example.com/docs");
  expect(typedUrl(plain, "localhost:5173")).toBe("http://localhost:5173");
  expect(typedUrl(plain, "127.0.0.1:8080/a")).toBe("http://127.0.0.1:8080/a");
  expect(typedUrl(plain, "devbox:3000")).toBe("http://devbox:3000");
  // The port tab's own port goes through its forward.
  expect(typedUrl(portTab, "localhost:3000/login")).toBe("http://127.0.0.1:53211/login");
  expect(typedUrl(portTab, "localhost:3000")).toBe("http://127.0.0.1:53211/");
  expect(typedUrl(portTab, "localhost:4000")).toBe("http://localhost:4000");
  for (const bad of ["", "hello world", "javascript:alert(1)", "file:///etc/passwd", "tauri://localhost", "words"]) expect(typedUrl(plain, bad)).toBeNull();
});

test("tab titles", () => {
  expect(pageTitle({ url: "https://example.com/a", title: "" })).toBe("example.com");
  expect(pageTitle({ url: "https://example.com/a", title: "Example" })).toBe("Example");
  expect(pageTitle({ port: portTab.port, url: null, title: "" })).toBe("localhost:3000");
  expect(pageTitle({ url: null, title: "" })).toBe("New tab");
});

test("the file Send to session uploads", () => {
  expect(pageFile({ url: "https://x.dev/a", title: "A", text: "  body\n", selection: false })).toBe("# A\n\nhttps://x.dev/a\n\n## Text\n\nbody\n");
  expect(pageFile({ url: "https://x.dev/a", title: "", text: "pick", selection: true })).toContain("# https://x.dev/a\n\nhttps://x.dev/a\n\n## Selected text\n\npick\n");
  expect(pageFileName("https://docs.x.dev/a/b")).toBe("page-docs.x.dev.md");
  expect(pageFileName("http://[::1]:3000/")).toBe("page-1.md");
  expect(pageFileName("nonsense")).toBe("page.md");
});
