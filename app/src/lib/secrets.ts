// Give a Secret (a session's right-click): what the dialog's button does for the name and value
// typed so far. The same rules as blimpd's secrets.ts, so a bad name is caught before anything is sent.

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX = 16384;

// do: "save" saves the value then tells Claude; "tell" only tells (a saved name, no value typed);
// none: not yet. error: why not, in words for the person typing.
export function secretStep(name: string, value: string, saved: string[]): { do?: "save" | "tell"; label: string; error?: string } {
  const n = name.trim();
  const label = !value && saved.includes(n) ? "Tell Claude" : "Save and Tell Claude";
  if (n && !NAME.test(n)) return { label, error: "A name is a letter, then letters, digits or _ (like API_KEY)." };
  if (value.length > MAX) return { label, error: `A secret is at most ${MAX} characters.` };
  if (!n) return { label };
  if (value) return { do: "save", label };
  return saved.includes(n) ? { do: "tell", label } : { label };
}
