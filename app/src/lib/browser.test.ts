import { expect, test } from "bun:test";
import { HOME, hostOf, searchUrl, serverTabTarget, typedUrl } from "./browser";

test("typed addresses", () => {
  expect(typedUrl("https://example.com/x")).toBe("https://example.com/x");
  expect(typedUrl("  example.com/docs ")).toBe("https://example.com/docs");
  expect(typedUrl("localhost:5173")).toBe("http://localhost:5173");
  expect(typedUrl("127.0.0.1:8080/a")).toBe("http://127.0.0.1:8080/a");
  expect(typedUrl("devbox:3000")).toBe("http://devbox:3000");
  expect(typedUrl("  ")).toBeNull();
});

test("anything that isn't an address is a Google search", () => {
  expect(HOME).toBe("https://www.google.com/");
  expect(searchUrl("rust lifetimes")).toBe("https://www.google.com/search?q=rust%20lifetimes");
  expect(typedUrl(" hello world ")).toBe(searchUrl("hello world"));
  expect(typedUrl("words")).toBe(searchUrl("words"));
  expect(typedUrl("c++ & rust?")).toBe("https://www.google.com/search?q=c%2B%2B%20%26%20rust%3F");
  for (const odd of ["javascript:alert(1)", "file:///etc/passwd", "tauri://localhost"]) expect(typedUrl(odd)).toBe(searchUrl(odd));
});

test("the server's localhost:<port> opens on the Mac through a forward; other addresses as they are", () => {
  expect(serverTabTarget("http://localhost:3000/login?x=1")).toEqual({ port: 3000 });
  expect(serverTabTarget("http://127.0.0.1:5173/")).toEqual({ port: 5173 });
  expect(serverTabTarget("https://example.com/a")).toEqual({ url: "https://example.com/a" });
  expect(serverTabTarget("http://localhost/")).toEqual({ url: "http://localhost/" });
  expect(serverTabTarget("not a url")).toEqual({ url: "not a url" });
});

test("hosts as labels", () => {
  expect(hostOf("https://docs.x.dev/a")).toBe("docs.x.dev");
  expect(hostOf("http://127.0.0.1:3000/")).toBe("127.0.0.1:3000");
  expect(hostOf("nonsense")).toBe("nonsense");
});
