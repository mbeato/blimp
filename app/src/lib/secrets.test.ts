import { expect, test } from "bun:test";
import { secretStep } from "./secrets";

test("a new name with a value is saved, then Claude is told", () => {
  expect(secretStep("API_KEY", "sk-1", [])).toEqual({ do: "save", label: "Save and Tell Claude" });
});

test("a saved name with no value only tells Claude; with a value it's replaced", () => {
  expect(secretStep("API_KEY", "", ["API_KEY"])).toEqual({ do: "tell", label: "Tell Claude" });
  expect(secretStep("API_KEY", "sk-2", ["API_KEY"])).toEqual({ do: "save", label: "Save and Tell Claude" });
});

test("nothing to do yet with no name, or a new name with no value; spaces around the name don't count", () => {
  expect(secretStep("", "sk-1", [])).toEqual({ label: "Save and Tell Claude" });
  expect(secretStep("NEW", "", ["API_KEY"])).toEqual({ label: "Save and Tell Claude" });
  expect(secretStep("  API_KEY ", "", ["API_KEY"])).toEqual({ do: "tell", label: "Tell Claude" });
});

test("a name the server would refuse says why, before anything is sent", () => {
  for (const bad of ["1KEY", "MY-KEY", "my key", "_X", "K".repeat(65)])
    expect(secretStep(bad, "v", [])).toEqual({ label: "Save and Tell Claude", error: "A name is a letter, then letters, digits or _ (like API_KEY)." });
});

test("a value over 16384 characters says so", () => {
  expect(secretStep("K", "x".repeat(16385), []).error).toBe("A secret is at most 16384 characters.");
  expect(secretStep("K", "x".repeat(16384), []).do).toBe("save");
});
