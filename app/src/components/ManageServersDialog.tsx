import { useState } from "react";
import { errorText, type ServerLink } from "../lib/connection";
import { connectHint, isNotSetUp } from "../lib/hints";
import { blimpdBehind, canUpdate, installServer, updateLink } from "../lib/updates";
import { Dialog } from "./Dialog";
import { ServerDot } from "./ServerSwitcher";

// Manage servers: each saved server's name, address and state, with what can be done about it.
// A name is only what the app shows; the address (the key) stays, so renaming leaves the tunnel,
// the tabs and the recent folders as they are.
export function ManageServersDialog(props: {
  links: ServerLink[]; // in saved order
  onRename: (link: ServerLink, name: string) => void;
  onRemove: (link: ServerLink) => void;
  onAdd: () => void;
  onNotice: (msg: string) => void;
  onClose: () => void;
}) {
  return (
    <Dialog className="servers" onClose={props.onClose}>
      <div className="dialog-head">
        <h2>Servers</h2>
      </div>
      <div className="srv-blocks">
        {props.links.map((l) => (
          <ServerBlock key={l.id} link={l} onRename={(n) => props.onRename(l, n)} onRemove={() => props.onRemove(l)} onNotice={props.onNotice} />
        ))}
      </div>
      <div className="dialog-actions srv-foot">
        <button onClick={props.onAdd}>Add server…</button>
      </div>
    </Dialog>
  );
}

function ServerBlock(props: { link: ServerLink; onRename: (name: string) => void; onRemove: () => void; onNotice: (msg: string) => void }) {
  const l = props.link;
  const saved = l.server.name ?? "";
  // edited: typed in since it last matched the saved name. Until then the field follows the saved
  // name (a rename in another window shows here), and leaving it never writes an old name back.
  const [field, setField] = useState({ name: saved, edited: false });
  const [was, setWas] = useState(saved);
  if (saved !== was) {
    setWas(saved);
    if (!field.edited) setField({ name: saved, edited: false });
  }
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState<"" | "Updating…" | "Installing blimpd…">("");
  const n = l.sessions?.length ?? 0;
  const hint = l.status === "offline" ? connectHint(l.error, l.server) : "";

  // Saved on Enter or on leaving the field (closing the dialog too); empty goes back to the
  // default name.
  const save = () => {
    if (!field.edited) return;
    const name = field.name.trim();
    setField({ name, edited: false });
    if (name !== saved.trim()) props.onRename(name);
  };
  const update = async () => {
    setBusy("Updating…");
    await updateLink(l, props.onNotice);
    setBusy("");
  };
  const install = async () => {
    setBusy("Installing blimpd…");
    try {
      // false: Cancel in the Mac's own dialog, and nothing to say.
      if (!(await installServer(l.server))) return;
      props.onNotice(`blimpd is installed on ${l.name}.`);
      l.retryNow();
    } catch (e) {
      props.onNotice(errorText(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <section className="srv-block" aria-label={l.name}>
      <label className="srv-field">
        <span>Name</span>
        <input
          value={field.name}
          placeholder={l.server.host}
          aria-label="Name"
          spellCheck={false}
          autoCapitalize="off"
          onChange={(e) => setField({ name: e.target.value, edited: true })}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            save();
          }}
        />
      </label>
      <div className="srv-address">{l.key}</div>
      <div className={"srv-state" + (l.status === "offline" ? " srv-state-offline" : "")}>
        <ServerDot status={l.status} />
        <span>
          {l.status === "connected"
            ? ["connected", l.version && `blimpd ${l.version}`, n === 1 ? "1 session" : `${n} sessions`].filter(Boolean).join(" · ")
            : l.status === "connecting"
              ? "connecting…"
              : l.error || "offline"}
        </span>
      </div>
      {hint && <p className="srv-hint">{hint}</p>}
      {asking ? (
        <div className="srv-ask">
          <p>Remove {l.name}? Its tabs close. Sessions on the server keep running.</p>
          <div className="dialog-actions">
            <button onClick={() => setAsking(false)}>Cancel</button>
            <button className="primary danger" autoFocus onClick={props.onRemove}>
              Remove
            </button>
          </div>
        </div>
      ) : (
        <div className="dialog-actions srv-actions">
          {busy && <span className="srv-busy">{busy}</span>}
          {l.status !== "connected" && !busy && <button onClick={() => l.retryNow()}>Try again</button>}
          {canUpdate() && l.status === "offline" && isNotSetUp(l.error) && !busy && <button onClick={() => void install()}>Install blimpd</button>}
          {canUpdate() && blimpdBehind(l) && !busy && <button onClick={() => void update()}>Update server</button>}
          <button onClick={() => setAsking(true)}>Remove…</button>
        </div>
      )}
    </section>
  );
}
