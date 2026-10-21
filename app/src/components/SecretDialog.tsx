import { useEffect, useState } from "react";
import { type Api, ApiError } from "../lib/api";
import { errorText } from "../lib/connection";
import { secretStep } from "../lib/secrets";
import { Dialog } from "./Dialog";

// Give a Secret (a Claude session's right-click): a key or password goes to the server once, in a
// request body (PUT /secrets/<name>), and Claude is told where it is, not what it is. The value
// lives only in this field: cleared once it's saved, never logged, never stored, never typed into
// the terminal. A name already saved can be given to another session without typing it again.
// The value is a masked textarea, not a password field: a password field drops line breaks, which
// would quietly break a PEM or SSH key.
export function SecretDialog(props: { api: Api; session: string; title: string; onClose: () => void }) {
  const [saved, setSaved] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // A blimpd from before secrets has no /secrets (404): nothing here would work.
  const [old, setOld] = useState(false);
  useEffect(() => {
    props.api.secrets().then(
      (s) => setSaved(s.map((x) => x.name)),
      (e) => setOld(e instanceof ApiError && e.status === 404),
    );
  }, [props.api]);
  const step = old ? { label: "Save and Tell Claude", error: "This server's blimpd is too old for secrets. Update it first." } : secretStep(name, value, saved);

  const submit = async () => {
    if (!step.do || busy) return;
    const n = name.trim();
    setBusy(true);
    setError("");
    try {
      if (step.do === "save") {
        await props.api.setSecret(n, value);
        setValue("");
        setSaved((s) => (s.includes(n) ? s : [...s, n]));
      }
      await props.api.tellSecret(n, props.session);
      props.onClose();
    } catch (e) {
      // Saved but not told (Claude is asking something, say): Tell Claude tries again.
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog onClose={props.onClose}>
      {/* The same layout as Add a server. */}
      <form
        className="addserver"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2>Give a secret to {props.title}</h2>
        <p className="dialog-note">It's kept in a file on the server only you can read. Claude is told where it is, never what it is.</p>
        <label>
          <span>Name</span>
          <input autoFocus aria-label="Name" list="secret-names" value={name} onChange={(e) => setName(e.target.value)} placeholder="API_KEY" spellCheck={false} autoCapitalize="off" autoComplete="off" />
          <datalist id="secret-names">
            {saved.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </label>
        <label>
          <span>Value</span>
          <textarea
            className="secret-value"
            aria-label="Value"
            rows={3}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            // Enter sends, as it did in a one-line field; Shift+Enter starts a new line.
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder={saved.includes(name.trim()) ? "Saved (paste to replace)" : "Paste it here"}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
          />
        </label>
        {(step.error || error) && <p className="dialog-error">{step.error || error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!step.do || busy}>
            {step.label}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
