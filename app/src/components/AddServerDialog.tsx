import { useEffect, useRef, useState } from "react";
import { errorText, inTauri, serverKey, sshHosts, tryConnect, type Server } from "../lib/connection";
import { connectHint, isNotSetUp } from "../lib/hints";
import { installServer } from "../lib/updates";
import { Dialog } from "./Dialog";

// Host is anything ssh accepts, including a Host alias from ~/.ssh/config (offered as suggestions).
// The server is tried before it's saved, so a typo or a missing blimpd shows here, with what to
// do about it, instead of as a saved server that's offline. known: the saved servers' keys.
export function AddServerDialog(props: { known: string[]; onAdd: (s: Server) => void; onClose?: () => void }) {
  const [host, setHost] = useState("");
  const [user, setUser] = useState("");
  const [port, setPort] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [hosts, setHosts] = useState<string[]>([]);
  // What's going on: trying the server, installing blimpd there, or the try failed (error says why).
  // was: an install's error from before it was pressed, for Cancel to put back.
  const [busy, setBusy] = useState<{ what: "connect" | "install"; host: string; was?: string } | null>(null);
  const [failed, setFailed] = useState<Server | null>(null);
  // The try under way; a newer one, a cancel or closing makes the old one's answer moot.
  const trying = useRef<{ cancel: () => void } | null>(null);
  const turn = useRef(0);

  useEffect(() => {
    void sshHosts().then(setHosts);
    // A window closed or reloaded mid-try never unmounts this; its tunnel would stay until quit.
    const gone = () => trying.current?.cancel();
    window.addEventListener("pagehide", gone);
    return () => {
      window.removeEventListener("pagehide", gone);
      gone();
    };
  }, []);

  // A field changed after a failed try: what failed, and its buttons, no longer match the fields,
  // so the next press tries what is on screen.
  const edit = (set: (v: string) => void) => (e: { target: { value: string } }) => {
    set(e.target.value);
    if (!failed) return;
    setFailed(null);
    setError("");
  };

  // The server in the fields, or null with the error said.
  const parse = (): Server | null => {
    const h = host.trim();
    if (!h) return setError("Enter the server's host name or SSH alias."), null;
    const p = port.trim() ? Number(port) : undefined;
    if (p !== undefined && !(Number.isInteger(p) && p > 0 && p < 65536)) return setError("Port must be a number from 1 to 65535."), null;
    const s: Server = { host: h, ...(user.trim() && { user: user.trim() }), ...(p && { port: p }), ...(name.trim() && { name: name.trim() }) };
    if (props.known.includes(serverKey(s))) return setError("This server is already in your list."), null;
    return s;
  };

  const attempt = (s: Server) => {
    const me = ++turn.current;
    setError("");
    setFailed(null);
    setBusy({ what: "connect", host: s.host });
    const t = tryConnect(s);
    trying.current = t;
    t.done.then(
      () => {
        if (me !== turn.current) return;
        trying.current = null;
        props.onAdd(s);
      },
      (e) => {
        if (me !== turn.current) return;
        trying.current = null;
        setBusy(null);
        setFailed(s);
        setError(errorText(e));
      },
    );
  };

  const submit = () => {
    const s = parse();
    if (s) attempt(s);
  };

  const addAnyway = () => {
    const s = parse();
    if (s) props.onAdd(s);
  };

  // Stops a try (its tunnel goes too), or stops waiting for an install: the form goes back to how
  // it was before Install blimpd was pressed. The install's ssh can't be stopped from here; it runs
  // on in the background until it ends, or ssh gives up on a server gone quiet (about a minute).
  const stop = () => {
    turn.current++;
    trying.current?.cancel();
    trying.current = null;
    if (busy?.what === "install") setError(busy.was ?? "");
    setBusy(null);
  };

  const install = async (s: Server) => {
    const me = ++turn.current;
    const was = error;
    setError("");
    setBusy({ what: "install", host: s.host, was });
    try {
      const done = await installServer(s);
      if (me !== turn.current) return;
      // Cancel in the Mac's own dialog: back to the failed try, as it was before the click.
      if (!done) return void (setBusy(null), setError(was));
      attempt(s);
    } catch (e) {
      if (me !== turn.current) return;
      setBusy(null);
      setError(errorText(e));
    }
  };

  const close = () => {
    stop();
    props.onClose?.();
  };

  const hint = failed && error ? connectHint(error, failed) : "";
  const form = (
    <form
      className="addserver"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) submit();
      }}
    >
      <h2>Add a server</h2>
      <p className="dialog-note">blimp connects with your SSH keys and settings. Host is a name from your SSH config, a Tailscale name, or an address.</p>
      <label>
        <span>Host</span>
        <input
          autoFocus
          value={host}
          onChange={edit(setHost)}
          placeholder="myserver.example.com"
          spellCheck={false}
          autoCapitalize="off"
          list={hosts.length ? "ssh-hosts" : undefined}
          readOnly={!!busy}
        />
        {hosts.length > 0 && (
          <datalist id="ssh-hosts">
            {hosts.map((h) => (
              <option key={h} value={h} />
            ))}
          </datalist>
        )}
      </label>
      <div className="field-row">
        <label>
          <span>User</span>
          <input value={user} onChange={edit(setUser)} placeholder="optional" spellCheck={false} autoCapitalize="off" readOnly={!!busy} />
        </label>
        <label className="narrow">
          <span>Port</span>
          <input value={port} onChange={edit(setPort)} placeholder="22" inputMode="numeric" readOnly={!!busy} />
        </label>
      </div>
      <label>
        <span>Name</span>
        <input value={name} onChange={edit(setName)} placeholder="optional, shown in the app" spellCheck={false} autoCapitalize="off" readOnly={!!busy} />
      </label>
      {busy && (
        <p className="dialog-note srv-trying" role="status">
          {busy.what === "connect" ? `Connecting to ${busy.host}…` : `Installing blimpd on ${busy.host}…`}
        </p>
      )}
      {error && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
      {hint && (
        <p className="dialog-note srv-hint" role="alert">
          {hint}
        </p>
      )}
      <div className="dialog-actions">
        {/* On the first-run form (no onClose) it shows only while something runs, and stops that. */}
        {(props.onClose || busy) && (
          <button type="button" onClick={props.onClose ? close : stop}>
            Cancel
          </button>
        )}
        {failed && !busy && (
          <>
            {inTauri() && isNotSetUp(error) && (
              <button type="button" onClick={() => void install(failed)}>
                Install blimpd
              </button>
            )}
            <button type="button" onClick={addAnyway}>
              Add anyway
            </button>
            <button type="submit" className="primary">
              Try again
            </button>
          </>
        )}
        {!failed && (
          <button type="submit" className="primary" disabled={!!busy}>
            Add server
          </button>
        )}
      </div>
    </form>
  );
  // With no servers yet there is nothing to go back to, so the form sits in the window itself.
  return props.onClose ? <Dialog onClose={close}>{form}</Dialog> : <div className="welcome">{form}</div>;
}
