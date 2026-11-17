import { Fragment } from "react";
import { COMMANDS, keyLabel, OTHER_KEYS, type Menu } from "../lib/commands";
import { Dialog } from "./Dialog";

const MENUS: Menu[] = ["blimp", "File", "View", "Server", "Window", "Help"];

// Help > Keyboard Shortcuts: every command with a key, by the menu it's in, made from the table
// (lib/commands.ts) so it can't go out of date; then the keys that aren't commands.
export function ShortcutsDialog(props: { onClose: () => void }) {
  const groups: { title: string; rows: { keys: string; title: string }[] }[] = [
    ...MENUS.map((m) => ({ title: m, rows: COMMANDS.filter((c) => c.menu === m && c.key).map((c) => ({ keys: keyLabel(c.key!), title: c.title })) })),
    ...[...new Set(OTHER_KEYS.map((k) => k.group))].map((g) => ({ title: g, rows: OTHER_KEYS.filter((k) => k.group === g) })),
  ].filter((g) => g.rows.length);
  return (
    <Dialog className="shortcuts" onClose={props.onClose}>
      <div className="shortcuts-head">
        <h2>Keyboard shortcuts</h2>
      </div>
      <div className="shortcuts-body">
        {groups.map((g) => (
          <section key={g.title} aria-label={g.title}>
            <h3>{g.title}</h3>
            <dl className="keys shortcuts-keys">
              {g.rows.map((r) => (
                <Fragment key={r.keys + r.title}>
                  <dt>{r.keys}</dt>
                  <dd>{r.title}</dd>
                </Fragment>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
