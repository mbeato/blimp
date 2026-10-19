import { useEffect, useRef, useState } from "react";
import { errorText, type ServerLink } from "../lib/connection";
import { canUpdate, checkForUpdate, onCheckForUpdates, updateServer, type AppUpdate } from "../lib/updates";
import { appVersion, compareVersions } from "../lib/version";

// How often the app looks for a new version, after the first look a few seconds after it opens.
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

// Bars under the tabs: a newer blimp is ready (Restart to update), and a server whose blimpd is
// older than this app (Update server). Only in the Mac app. onNotice: for Check for Updates…
// when there's nothing new, or a check that failed.
export function UpdateBars(props: { links: ServerLink[]; onNotice: (msg: string) => void }) {
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  const [later, setLater] = useState(false);
  const [installing, setInstalling] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState("");
  // Servers being updated, and the ones put off until the next launch.
  const [updating, setUpdating] = useState<Set<string>>(new Set());
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const notice = useRef(props.onNotice);
  notice.current = props.onNotice;

  const look = async (asked: boolean) => {
    try {
      const u = await checkForUpdate();
      setUpdate(u);
      if (u) setLater(false);
      else if (asked) notice.current(`blimp ${appVersion} is the newest version.`);
    } catch (e) {
      if (asked) notice.current(`Couldn't check for updates: ${errorText(e)}`);
    }
  };

  useEffect(() => {
    if (!canUpdate()) return;
    const first = setTimeout(() => void look(false), 4000);
    const every = setInterval(() => void look(false), CHECK_EVERY_MS);
    let off = () => {};
    void onCheckForUpdates(() => void look(true)).then((f) => (off = f));
    return () => (clearTimeout(first), clearInterval(every), off());
  }, []);

  if (!canUpdate()) return null;

  const install = async () => {
    if (!update) return;
    setError("");
    setInstalling({ done: 0, total: 0 });
    try {
      await update.install((done, total) => setInstalling({ done, total }));
    } catch (e) {
      setInstalling(null);
      setError(errorText(e));
    }
  };

  const behind = props.links.filter((l) => l.status === "connected" && l.version && compareVersions(l.version, appVersion) < 0 && !skipped.has(l.key));
  const updateOne = async (l: ServerLink) => {
    setUpdating((s) => new Set(s).add(l.key));
    try {
      await updateServer(l.key);
      notice.current(`blimpd on ${l.key} is updated.`);
      // blimpd restarted; the link sees its events socket drop and reconnects to the new one.
      l.retryNow();
    } catch (e) {
      notice.current(errorText(e));
    } finally {
      setUpdating((s) => {
        const n = new Set(s);
        n.delete(l.key);
        return n;
      });
    }
  };

  const pct = installing?.total ? Math.round((installing.done / installing.total) * 100) : null;
  return (
    <>
      {update && !later && (
        <div className="update-bar" role="status">
          <span>
            {installing ? (pct === null ? `Downloading blimp ${update.version}…` : `Downloading blimp ${update.version}… ${pct}%`) : `blimp ${update.version} is ready.`}
            {error && <span className="update-error"> Couldn't update: {error}</span>}
          </span>
          {!installing && (
            <>
              <button className="primary" onClick={() => void install()}>
                Restart to update
              </button>
              <button onClick={() => setLater(true)}>Later</button>
            </>
          )}
        </div>
      )}
      {behind.map((l) => (
        <div key={l.key} className="update-bar" role="status">
          <span>
            blimpd on {l.key} is {l.version}; this app is {appVersion}.{" "}
            {updating.has(l.key) ? "Updating…" : "Update it so the newest features work there. Sessions keep running."}
          </span>
          {!updating.has(l.key) && (
            <>
              <button className="primary" onClick={() => void updateOne(l)}>
                Update server
              </button>
              <button onClick={() => setSkipped((s) => new Set(s).add(l.key))}>Later</button>
            </>
          )}
        </div>
      ))}
    </>
  );
}
