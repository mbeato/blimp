import type { ReactNode } from "react";
import { changeSettings, DEFAULTS, useSettings, type Settings } from "../lib/settings";
import { appVersion } from "../lib/version";
import { Dialog } from "./Dialog";

// Settings (⌘,): every change applies at once, in every window, and is kept on this Mac.
export function SettingsDialog(props: { onClose: () => void }) {
  const s = useSettings();
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
        <section>
          <h3>Updates</h3>
          {check("autoUpdate", "Check for updates automatically", `This is blimp ${appVersion}. blimp > Check for Updates… checks now.`)}
        </section>
      </div>
    </Dialog>
  );
}

function Row(props: { label: string; note?: string; children: ReactNode }) {
  return (
    <label className="settings-row">
      <span className="settings-label">
        {props.label}
        {props.note && <span className="settings-note">{props.note}</span>}
      </span>
      {props.children}
    </label>
  );
}
