import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Api, Kind, Secret } from "../lib/api";
import { errorText, type ServerLink } from "../lib/connection";
import { changeSettings, DEFAULTS, useSettings, type Settings } from "../lib/settings";
import { relTime } from "../lib/time";
import { appVersion } from "../lib/version";
import { Dialog } from "./Dialog";

// Settings (⌘,): every change applies at once, in every window, and is kept on this Mac.
// Models is the exception: keys and sign-ins belong to each server, where sessions run.
// at: open scrolled to that section (the session chevron's "Models and keys…").
// onCodexSignIn: start Codex's sign-in in a session on that server.
export function SettingsDialog(props: { onClose: () => void; at?: "models"; links: ServerLink[]; onCodexSignIn: (l: ServerLink) => void }) {
  const s = useSettings();
  const models = useRef<HTMLElement>(null);
  useEffect(() => {
    if (props.at === "models") models.current?.scrollIntoView({ block: "start" });
  }, []);
  const set = (patch: Partial<Settings>) => void changeSettings(patch);
  const check = (k: keyof Settings, label: string, note?: string) => (
    <Row label={label} note={note}>
      <input type="checkbox" aria-label={label} checked={s[k] as boolean} onChange={(e) => set({ [k]: e.target.checked })} />
    </Row>
  );
  const size = (k: "terminalFontSize" | "editorFontSize", label: string) => (
    <Row label={label}>
      <input type="number" aria-label={label} min={9} max={28} value={s[k]} onChange={(e) => e.target.value && set({ [k]: Number(e.target.value) })} />
    </Row>
  );
  return (
    <Dialog className="settings" onClose={props.onClose}>
      <div className="settings-head">
        <h2>Settings</h2>
        <button className="link-button" onClick={() => set(DEFAULTS)}>
          Reset all
        </button>
      </div>
      <div className="settings-body">
        <section>
          <h3>Appearance</h3>
          <Row label="Theme">
            <select aria-label="Theme" value={s.theme} onChange={(e) => set({ theme: e.target.value as Settings["theme"] })}>
              <option value="system">Same as the system</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </Row>
          {size("terminalFontSize", "Terminal text size")}
          {size("editorFontSize", "Editor text size")}
        </section>
        <section>
          <h3>Terminal</h3>
          <Row label="Cursor">
            <select aria-label="Cursor" value={s.cursorStyle} onChange={(e) => set({ cursorStyle: e.target.value as Settings["cursorStyle"] })}>
              <option value="block">Block</option>
              <option value="bar">Bar</option>
              <option value="underline">Underline</option>
            </select>
          </Row>
          {check("cursorBlink", "Blinking cursor")}
          <Row label="Scrollback" note="Lines each terminal keeps">
            <input type="number" aria-label="Scrollback" min={1000} max={100000} step={1000} value={s.scrollback} onChange={(e) => e.target.value && set({ scrollback: Number(e.target.value) })} />
          </Row>
          {check("optionIsMeta", "Option key as Meta", "Option+letter sends Esc+letter, for shell shortcuts. Off: Option types characters like é.")}
        </section>
        <section>
          <h3>Editor</h3>
          {check("autosave", "Autosave", "Off: changes wait for ⌘S (closing a file still saves it first)")}
          {check("wordWrap", "Wrap long lines")}
          {check("minimap", "Minimap")}
        </section>
        <section>
          <h3>Notifications</h3>
          {check("notifications", "Notify when a session waits for you")}
          {check("dockBadge", "Dock badge with the number waiting")}
        </section>
        <section ref={models} aria-label="Models">
          <h3>Models</h3>
          {props.links.length === 0 && <p className="settings-note">Connect to a server to set its keys.</p>}
          {props.links.map((l) => (
            <Models key={l.key} link={l} named={props.links.length > 1} onCodexSignIn={() => props.onCodexSignIn(l)} />
          ))}
        </section>
        <section>
          <h3>Updates</h3>
          {check("autoUpdate", "Check for updates automatically", `This is blimp ${appVersion}. blimp > Check for Updates… checks now.`)}
        </section>
      </div>
    </Dialog>
  );
}

// One server's keys and sign-ins. A key typed here is sent once (PUT /keys/zai) and the field
// cleared: the app never keeps it, and the server never sends it back.
function Models(props: { link: ServerLink; named: boolean; onCodexSignIn: () => void }) {
  const api = props.link.api!;
  const [zai, setZai] = useState<boolean | null>(null);
  const [kinds, setKinds] = useState<Kind[] | null>(null);
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const load = () => {
    api.keys().then((k) => setZai(k.zai), (e) => setError(errorText(e)));
    api.kinds().then(setKinds, () => {});
  };
  useEffect(load, [api]);
  const change = async (f: () => Promise<void>) => {
    try {
      await f();
      setError("");
      load();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const save = () =>
    key.trim() &&
    change(async () => {
      await api.setZaiKey(key.trim());
      setKey("");
    });
  const codex = kinds?.find((k) => k.id === "codex");
  return (
    <div className="models" data-server={props.link.key}>
      {props.named && <h4>{props.link.key}</h4>}
      <Row div label="Z.ai key" note={`For Claude Code on GLM. ${zai === null ? "" : zai ? "Set" : "Not set"}`}>
        <input
          type="password"
          aria-label="Z.ai key"
          placeholder={zai ? "Replace key" : "Paste key"}
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void save()}
        />
        <button disabled={!key.trim()} onClick={() => void save()}>
          Save
        </button>
        {zai && <button onClick={() => void change(() => api.removeZaiKey())}>Remove</button>}
      </Row>
      <Row div label="Codex" note={!codex ? "" : !codex.available ? "Not installed" : codex.note === "signed in" ? "Signed in" : "Not signed in"}>
        {codex?.available && <button onClick={props.onCodexSignIn}>Sign in</button>}
      </Row>
      <Secrets api={api} />
      <p className="settings-note">Your own kinds of session live in ~/.blimp/kinds.json on the server.</p>
      {error && <p className="settings-error">{error}</p>}
    </div>
  );
}

// The secrets given to that server's sessions (a session's right-click, Give a Secret…): names only,
// each with Remove. Nothing shows for a blimpd without secrets (older: 404).
function Secrets(props: { api: Api }) {
  const [list, setList] = useState<Secret[] | null>(null);
  const [error, setError] = useState("");
  const load = () => void props.api.secrets().then(setList, () => setList(null));
  useEffect(load, [props.api]);
  if (!list) return null;
  const remove = (name: string) =>
    props.api.removeSecret(name).then(
      () => (setError(""), load()),
      (e) => setError(errorText(e)),
    );
  return (
    <div className="secrets">
      <Row div label="Secrets" note={list.length ? "Claude reads them from files on the server" : "None yet. Give one from a session's right-click menu."}>
        {null}
      </Row>
      {list.map((s) => (
        <Row div key={s.name} label={s.name} note={`Saved ${relTime(s.mtime)}`}>
          <button aria-label={`Remove ${s.name}`} onClick={() => void remove(s.name)}>
            Remove
          </button>
        </Row>
      ))}
      {error && <p className="settings-error">{error}</p>}
    </div>
  );
}

// div: for rows with buttons, where a click on the text mustn't press one.
function Row(props: { label: string; note?: string; div?: boolean; children: ReactNode }) {
  const Tag = props.div ? "div" : "label";
  return (
    <Tag className="settings-row">
      <span className="settings-label">
        {props.label}
        {props.note && <span className="settings-note">{props.note}</span>}
      </span>
      {props.children}
    </Tag>
  );
}
