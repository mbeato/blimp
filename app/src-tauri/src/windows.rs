//! Several windows, one project each (docs/superpowers/specs/2026-10-19-workbench-layout-design.md).
//! Rust keeps what each window shows, so ⌘K can focus a window already showing a project, and it
//! decides which window sends a "waiting for you" notification: every window watches the same
//! sessions, and only the first to ask for a given wait gets to notify.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[derive(Default)]
pub struct Windows {
    inner: Mutex<Inner>,
    next: AtomicU64,
}

#[derive(Default)]
struct Inner {
    /// Window label -> "<server key>\n<folder>" it shows.
    projects: HashMap<String, String>,
    /// Window label -> "<server key>/<session>" on screen, only while that window has focus.
    viewing: HashMap<String, String>,
    /// Waits already announced: "<server key>/<session>/<wait start>".
    noticed: HashSet<String>,
}

impl Windows {
    /// A window closed: forget what it showed.
    pub fn forget(&self, label: &str) {
        let mut inner = self.inner.lock().unwrap();
        inner.projects.remove(label);
        inner.viewing.remove(label);
    }
}

/// Opens a new window. `init` is the state it starts in (server, folder, session) as a query
/// string; it reaches the page as a JSON string, so nothing in it can run as script.
pub fn create(app: &AppHandle, windows: &Windows, init: &str) -> Result<(), String> {
    let n = windows.next.fetch_add(1, Ordering::Relaxed) + 1;
    let init = serde_json::to_string(init).map_err(|e| e.to_string())?;
    WebviewWindowBuilder::new(app, format!("w-{n}"), WebviewUrl::App("index.html".into()))
        .title("blimp")
        .inner_size(1400.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .initialization_script(format!("window.__blimpInit = {init};"))
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// The window says which project it shows (None: still on Home with no folder yet).
#[tauri::command]
pub fn set_window_project(window: WebviewWindow, windows: State<'_, Windows>, project: Option<String>) {
    let mut inner = windows.inner.lock().unwrap();
    match project {
        Some(p) => inner.projects.insert(window.label().to_string(), p),
        None => inner.projects.remove(window.label()),
    };
}

/// Focuses the window already showing `project` and hands it `init` ("select-session"), or
/// opens a new window starting from `init`.
#[tauri::command]
pub fn open_window(
    app: AppHandle,
    windows: State<'_, Windows>,
    project: Option<String>,
    init: String,
) -> Result<(), String> {
    let existing = project.and_then(|p| {
        let inner = windows.inner.lock().unwrap();
        inner.projects.iter().find(|(_, v)| **v == p).map(|(k, _)| k.clone())
    });
    if let Some(w) = existing.and_then(|label| app.get_webview_window(&label)) {
        let _ = w.unminimize();
        let _ = w.set_focus();
        return w.emit_to(w.label(), "select-session", init).map_err(|e| e.to_string());
    }
    create(&app, &windows, &init)
}

/// What this window shows while it has focus (None when it loses focus).
#[tauri::command]
pub fn set_viewing(window: WebviewWindow, windows: State<'_, Windows>, session: Option<String>) {
    let mut inner = windows.inner.lock().unwrap();
    match session {
        Some(s) => inner.viewing.insert(window.label().to_string(), s),
        None => inner.viewing.remove(window.label()),
    };
}

/// Whether this window should announce a wait: no if a focused window shows that session,
/// or another window already announced this wait.
#[tauri::command]
pub fn claim_notice(windows: State<'_, Windows>, session: String, key: String) -> bool {
    let mut inner = windows.inner.lock().unwrap();
    if inner.viewing.values().any(|v| *v == session) {
        return false;
    }
    inner.noticed.insert(key)
}
