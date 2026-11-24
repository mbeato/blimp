import { useState } from "react";
import { type Server } from "../lib/connection";
import { AddServerDialog } from "./AddServerDialog";
import { useThisMac } from "./ThisMac";

// The Mac app's first open, with no saved servers: where sessions run. This Mac needs no SSH and
// no server; A server… is the Add a server form, with Back to come here again.
export function FirstRun(props: { onAdd: (s: Server) => void }) {
  const [form, setForm] = useState(false);
  const mac = useThisMac(props.onAdd);
  if (form) return <AddServerDialog known={[]} onAdd={props.onAdd} onBack={() => setForm(false)} />;
  return (
    <div className="welcome">
      <div className="addserver firstrun">
        <h2>Where should blimp run your sessions?</h2>
        <div className="dialog-actions firstrun-choices">
          <button className="primary" autoFocus disabled={!!mac.busy} aria-describedby="firstrun-mac" onClick={mac.run}>
            This Mac
          </button>
          <p id="firstrun-mac" className="dialog-note">
            Sessions run on this Mac. They pause while it sleeps.
          </p>
          <button disabled={!!mac.busy} aria-describedby="firstrun-server" onClick={() => setForm(true)}>
            A server…
          </button>
          <p id="firstrun-server" className="dialog-note">
            A Linux server or another Mac, over SSH. Sessions keep running when this Mac is off.
          </p>
        </div>
        {mac.busy && (
          <p className="dialog-note srv-trying" role="status">
            {mac.busy === "connect" ? "Connecting to this Mac…" : "Setting up this Mac…"}
          </p>
        )}
        {mac.error && (
          <p className="dialog-error" role="alert">
            {mac.error}
          </p>
        )}
      </div>
    </div>
  );
}
