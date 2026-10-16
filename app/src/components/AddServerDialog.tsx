import { useState } from "react";
import type { Server } from "../lib/connection";
import { Dialog } from "./Dialog";

// Host is anything ssh accepts, including a Host alias from ~/.ssh/config.
export function AddServerDialog(props: { onAdd: (s: Server) => void; onClose?: () => void }) {
  const [host, setHost] = useState("");
  const [user, setUser] = useState("");
  const [port, setPort] = useState("");
  const [error, setError] = useState("");

  const submit = () => {
    const h = host.trim();
    if (!h) return setError("Enter the server's host name or SSH alias.");
    const p = port.trim() ? Number(port) : undefined;
    if (p !== undefined && !(Number.isInteger(p) && p > 0 && p < 65536)) return setError("Port must be a number from 1 to 65535.");
    props.onAdd({ host: h, ...(user.trim() && { user: user.trim() }), ...(p && { port: p }) });
  };

  const form = (
    <form
      className="addserver"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h2>Add a server</h2>
      <p className="dialog-note">blimp connects with your SSH keys and settings. The server needs blimpd installed.</p>
      <label>
        <span>Host</span>
        <input autoFocus value={host} onChange={(e) => setHost(e.target.value)} placeholder="myserver.example.com" spellCheck={false} autoCapitalize="off" />
      </label>
      <div className="field-row">
        <label>
          <span>User</span>
          <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="optional" spellCheck={false} autoCapitalize="off" />
        </label>
        <label className="narrow">
          <span>Port</span>
          <input value={port} onChange={(e) => setPort(e.target.value)} placeholder="22" inputMode="numeric" />
        </label>
      </div>
      {error && <p className="dialog-error">{error}</p>}
      <div className="dialog-actions">
        {props.onClose && (
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
        )}
        <button type="submit" className="primary">
          Add server
        </button>
      </div>
    </form>
  );
  // With no servers yet there is nothing to go back to, so the form sits in the window itself.
  return props.onClose ? <Dialog onClose={props.onClose}>{form}</Dialog> : <div className="welcome">{form}</div>;
}
