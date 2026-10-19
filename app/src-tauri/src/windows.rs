//! Several windows, each with project tabs (docs/superpowers/specs/2026-10-19-workbench-layout-design.md).
//! Rust keeps what each window has open, so ⌘K can focus a window that has a project, and it
//! decides which window sends a "waiting for you" notification: every window watches the same
//! sessions, and only the first to ask for a given wait gets to notify.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, WebviewUrl, WebviewWindowBuilder, Window};
use tauri_plugin_store::StoreExt;

/// A window closed this long before the app quits counts as part of quitting (⌘Q closes every
/// window, then the app ends), so it comes back at the next launch. One closed earlier was
/// closed on purpose and doesn't.
const QUIT_GRACE: Duration = Duration::from_secs(3);

/// What the next launch reopens, per window: its tabs (the page's layout, as JSON) and where it
/// was (logical x, y, width, height).
#[derive(Clone, Serialize, Deserialize)]
pub struct Saved {
    layout: String,
    bounds: Option<[f64; 4]>,
}

struct Open {
    label: String,
    saved: Saved,
    closed: Option<Instant>,
}

#[derive(Default)]
pub struct Windows {
    inner: Mutex<Inner>,
    next: AtomicU64,
}

#[derive(Default)]
struct Inner {
    /// Window label -> the "<server key>\n<folder>" of each of its tabs.
    projects: HashMap<String, Vec<String>>,
    /// Window label -> the "<server key>/<session>"s on screen (one per terminal split), only
    /// while that window has focus.
    viewing: HashMap<String, Vec<String>>,
    /// Waits already announced: "<server key>/<session>/<wait start>".
    noticed: HashSet<String>,
    /// Window label -> the "<server key>/<session>" of every split in every one of its tabs, kept
    /// while the window is in the background too, so other windows can say "in another window".
    shown: HashMap<String, Vec<String>>,
    /// Window labels, the one focused most recently last: where windows overlap, a drop goes
    /// to the one most likely on top.
    focus_order: Vec<String>,
    /// Every window's tabs and place, in the order the windows opened, for the next launch.
    open: Vec<Open>,
    /// What the last run left, until the first window takes it (restore_windows).
    previous: Option<Vec<Saved>>,
}

/// The windows to save: open ones, and ones closed within QUIT_GRACE.
fn kept(open: &[Open], now: Instant) -> Vec<Saved> {
    open.iter().filter(|o| o.closed.is_none_or(|t| now.duration_since(t) < QUIT_GRACE)).map(|o| o.saved.clone()).collect()
}

const STORE: &str = "windows.json";

impl Windows {
    /// At startup: what the last run's windows were, for restore_windows.
    pub fn load(&self, app: &AppHandle) {
        let saved = app
            .store(STORE)
            .ok()
            .and_then(|s| s.get("windows"))
            .and_then(|v| serde_json::from_value::<Vec<Saved>>(v).ok())
            .unwrap_or_default();
        self.inner.lock().unwrap().previous = Some(saved);
    }

    /// Writes what the next launch reopens. Live windows' places are read fresh.
    fn persist(&self, app: &AppHandle) {
        let list = {
            let mut inner = self.inner.lock().unwrap();
            for o in inner.open.iter_mut().filter(|o| o.closed.is_none()) {
                if let Some(w) = app.get_window(&o.label) {
                    o.saved.bounds = bounds(&w).or(o.saved.bounds);
                }
            }
            kept(&inner.open, Instant::now())
        };
        if let Ok(store) = app.store(STORE) {
            store.set("windows", serde_json::json!(list));
            let _ = store.save();
        }
    }

    /// A window closed: forget what it showed, and tell the others. Its tabs stay saved for a
    /// moment, in case this is the app quitting (QUIT_GRACE).
    pub fn forget(&self, app: &AppHandle, label: &str) {
        let shown = {
            let mut inner = self.inner.lock().unwrap();
            inner.projects.remove(label);
            inner.viewing.remove(label);
            inner.shown.remove(label);
            inner.focus_order.retain(|l| l != label);
            if let Some(o) = inner.open.iter_mut().find(|o| o.label == label) {
                o.closed = Some(Instant::now());
            }
            inner.shown.clone()
        };
        let _ = app.emit("shown", shown);
        self.persist(app);
    }

    /// The app is ending: save once more (windows closed on purpose earlier drop out now).
    pub fn exiting(&self, app: &AppHandle) {
        self.persist(app);
    }

    /// A window moved or was resized: remember where it is (written with the next save, so a
    /// drag doesn't write the file at every step).
    pub fn moved(&self, window: &tauri::Window) {
        let b = bounds(window);
        let mut inner = self.inner.lock().unwrap();
        if let Some(o) = inner.open.iter_mut().find(|o| o.label == window.label() && o.closed.is_none()) {
            o.saved.bounds = b.or(o.saved.bounds);
        }
    }

    /// A window got focus.
    pub fn focused(&self, label: &str) {
        let mut inner = self.inner.lock().unwrap();
        inner.focus_order.retain(|l| l != label);
        inner.focus_order.push(label.to_string());
    }
}

/// Opens a new window. `init` is the state it starts in (a place, or a whole layout) as a query
/// string; it reaches the page as a JSON string, so nothing in it can run as script.
/// `at`: its top-left corner on screen (logical pixels), else where the system puts it.
pub fn create(app: &AppHandle, windows: &Windows, init: &str, at: Option<(f64, f64)>) -> Result<(), String> {
    create_sized(app, windows, init, at, None)
}

fn create_sized(app: &AppHandle, windows: &Windows, init: &str, at: Option<(f64, f64)>, size: Option<(f64, f64)>) -> Result<(), String> {
    let n = windows.next.fetch_add(1, Ordering::Relaxed) + 1;
    let init = serde_json::to_string(init).map_err(|e| e.to_string())?;
    let mut b = WebviewWindowBuilder::new(app, format!("w-{n}"), WebviewUrl::App("index.html".into()))
        .title("blimp")
        .inner_size(1400.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .initialization_script(format!("window.__blimpInit = {init};"));
    if let Some((x, y)) = at {
        b = b.position(x, y);
    }
    if let Some((w, h)) = size {
        b = b.inner_size(w, h);
    }
    b.build().map(|_| ()).map_err(|e| e.to_string())
}

fn bounds(w: &Window) -> Option<[f64; 4]> {
    let scale = w.scale_factor().ok()?;
    let p = w.outer_position().ok()?.to_logical::<f64>(scale);
    let s = w.inner_size().ok()?.to_logical::<f64>(scale);
    Some([p.x, p.y, s.width, s.height])
}

/// Whether a saved place is still on one of the screens (a screen may have been unplugged).
fn on_screen(app: &AppHandle, b: &[f64; 4]) -> bool {
    app.available_monitors().unwrap_or_default().iter().any(|m| {
        let p = m.position().to_logical::<f64>(m.scale_factor());
        let s = m.size().to_logical::<f64>(m.scale_factor());
        b[0] >= p.x - 40.0 && b[1] >= p.y - 40.0 && b[0] < p.x + s.width - 100.0 && b[1] < p.y + s.height - 100.0
    })
}

fn percent(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

/// The window's tabs changed (the page's layout, as JSON): saved for the next launch.
#[tauri::command]
pub fn save_window_layout(app: AppHandle, window: Window, windows: State<'_, Windows>, layout: String) {
    {
        let mut inner = windows.inner.lock().unwrap();
        let label = window.label().to_string();
        match inner.open.iter_mut().find(|o| o.label == label) {
            Some(o) => o.saved.layout = layout,
            None => inner.open.push(Open { label, saved: Saved { layout, bounds: bounds(&window) }, closed: None }),
        }
    }
    windows.persist(&app);
}

/// Once per launch, for the first window: the last run's windows. The caller becomes the first
/// of them (its tabs are returned, and it moves to where that window was); the others open where
/// they were. None: nothing to restore (or already done), so the caller starts as usual.
#[tauri::command]
pub fn restore_windows(app: AppHandle, window: Window, windows: State<'_, Windows>) -> Option<String> {
    let mut list = windows.inner.lock().unwrap().previous.take()?;
    if list.is_empty() {
        return None;
    }
    let first = list.remove(0);
    if let Some(b) = first.bounds.filter(|b| on_screen(&app, b)) {
        let _ = window.set_position(LogicalPosition::new(b[0], b[1]));
        let _ = window.set_size(LogicalSize::new(b[2], b[3]));
    }
    for s in list {
        let b = s.bounds.filter(|b| on_screen(&app, b));
        let _ = create_sized(&app, &windows, &format!("layout={}", percent(&s.layout)), b.map(|b| (b[0], b[1])), b.map(|b| (b[2], b[3])));
    }
    Some(first.layout)
}

/// Whether the point (logical screen pixels) is on the window, and where in its page if so.
fn page_point(w: &Window, x: f64, y: f64) -> Option<(f64, f64)> {
    let scale = w.scale_factor().ok()?;
    let pos = w.outer_position().ok()?.to_logical::<f64>(scale);
    let size = w.outer_size().ok()?.to_logical::<f64>(scale);
    if x < pos.x || y < pos.y || x >= pos.x + size.width || y >= pos.y + size.height || !w.is_visible().unwrap_or(false) {
        return None;
    }
    let inner = w.inner_position().ok()?.to_logical::<f64>(scale);
    Some((x - inner.x, y - inner.y))
}

/// The window says which projects its tabs have open.
#[tauri::command]
pub fn set_window_projects(window: Window, windows: State<'_, Windows>, projects: Vec<String>) {
    let mut inner = windows.inner.lock().unwrap();
    inner.projects.insert(window.label().to_string(), projects);
}

/// Opens a new window starting from `init` (a place or a layout, as a query string).
#[tauri::command]
pub fn open_window(app: AppHandle, windows: State<'_, Windows>, init: String) -> Result<(), String> {
    create(&app, &windows, &init, None)
}

/// A session dragged out of this window and let go at (x, y) on screen (logical pixels).
/// Over another blimp window: that window gets "drop-session" (the place, and the point in its
/// page) and comes forward; returns true. Over none: a new window opens there; returns false.
#[tauri::command]
pub fn drop_session(
    app: AppHandle,
    window: Window,
    windows: State<'_, Windows>,
    init: String,
    x: f64,
    y: f64,
) -> Result<bool, String> {
    let order = windows.inner.lock().unwrap().focus_order.clone();
    let mut all: Vec<Window> = app.windows().into_values().filter(|w| w.label() != window.label()).collect();
    // Most recently focused first.
    all.sort_by_key(|w| std::cmp::Reverse(order.iter().position(|l| l == w.label())));
    for w in all {
        if let Some((px, py)) = page_point(&w, x, y) {
            let _ = w.set_focus();
            w.emit_to(w.label(), "drop-session", serde_json::json!({ "init": init, "x": px, "y": py }))
                .map_err(|e| e.to_string())?;
            return Ok(true);
        }
    }
    create(&app, &windows, &init, Some((x - 60.0, y - 16.0)))?;
    Ok(false)
}

/// Focuses another window that has `project` in a tab and hands it `init` ("select-session").
/// false: no other window has it, and the caller opens it in a tab of its own.
#[tauri::command]
pub fn focus_project(
    app: AppHandle,
    window: Window,
    windows: State<'_, Windows>,
    project: String,
    init: String,
) -> Result<bool, String> {
    let label = {
        let inner = windows.inner.lock().unwrap();
        inner
            .projects
            .iter()
            .find(|(k, v)| *k != window.label() && v.contains(&project))
            .map(|(k, _)| k.clone())
    };
    let Some(w) = label.and_then(|l| app.get_window(&l)) else {
        return Ok(false);
    };
    let _ = w.unminimize();
    let _ = w.set_focus();
    w.emit_to(w.label(), "select-session", init).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Every session this window has in a split, in any tab. Every window gets the new map ("shown"),
/// and so does the caller, as the return value.
#[tauri::command]
pub fn set_shown(
    app: AppHandle,
    window: Window,
    windows: State<'_, Windows>,
    sessions: Vec<String>,
) -> HashMap<String, Vec<String>> {
    let shown = {
        let mut inner = windows.inner.lock().unwrap();
        inner.shown.insert(window.label().to_string(), sessions);
        inner.shown.clone()
    };
    let _ = app.emit("shown", shown.clone());
    shown
}

/// A click on a session another window shows: that window comes forward and shows it
/// ("select-session" with `init`). false: no other window shows it.
#[tauri::command]
pub fn focus_session(
    app: AppHandle,
    window: Window,
    windows: State<'_, Windows>,
    session: String,
    init: String,
) -> Result<bool, String> {
    let label = {
        let inner = windows.inner.lock().unwrap();
        inner.shown.iter().find(|(k, v)| *k != window.label() && v.contains(&session)).map(|(k, _)| k.clone())
    };
    let Some(w) = label.and_then(|l| app.get_window(&l)) else {
        return Ok(false);
    };
    let _ = w.unminimize();
    let _ = w.set_focus();
    w.emit_to(w.label(), "select-session", init).map_err(|e| e.to_string())?;
    Ok(true)
}

/// This window took a session another window showed (dragged it into a split here): those
/// windows stop showing it ("release-session"), so it's never on screen twice.
#[tauri::command]
pub fn take_session(app: AppHandle, window: Window, windows: State<'_, Windows>, session: String) {
    let labels: Vec<String> = {
        let inner = windows.inner.lock().unwrap();
        inner.shown.iter().filter(|(k, v)| *k != window.label() && v.contains(&session)).map(|(k, _)| k.clone()).collect()
    };
    for l in labels {
        let _ = app.emit_to(l.as_str(), "release-session", session.clone());
    }
}

/// What this window shows while it has focus (empty when it loses focus).
#[tauri::command]
pub fn set_viewing(window: Window, windows: State<'_, Windows>, sessions: Vec<String>) {
    let mut inner = windows.inner.lock().unwrap();
    if sessions.is_empty() {
        inner.viewing.remove(window.label());
    } else {
        inner.viewing.insert(window.label().to_string(), sessions);
    }
}

/// Whether this window should announce a wait: no if a focused window shows that session,
/// or another window already announced this wait.
#[tauri::command]
pub fn claim_notice(windows: State<'_, Windows>, session: String, key: String) -> bool {
    let mut inner = windows.inner.lock().unwrap();
    if inner.viewing.values().any(|v| v.contains(&session)) {
        return false;
    }
    inner.noticed.insert(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open(label: &str, closed: Option<Instant>) -> Open {
        Open { label: label.into(), saved: Saved { layout: label.into(), bounds: None }, closed }
    }

    #[test]
    fn closed_windows_drop_out_unless_the_app_is_quitting() {
        let now = Instant::now();
        let list = [open("main", None), open("w-1", Some(now - Duration::from_secs(1))), open("w-2", Some(now - Duration::from_secs(60)))];
        let names: Vec<String> = kept(&list, now).into_iter().map(|s| s.layout).collect();
        assert_eq!(names, ["main", "w-1"]);
    }

    #[test]
    fn layouts_go_into_a_query_safely() {
        assert_eq!(percent(r#"{"a":"b c&d"}"#), "%7B%22a%22%3A%22b%20c%26d%22%7D");
    }
}
