//! Browser tabs: one native web view per tab, a child of the window that opened it, placed over
//! the tab's area by the page (it sends the rectangle). A web view, not an iframe: most sites
//! refuse to be framed, and an iframe can't tell its address or go back.
//!
//! These views get no IPC: capabilities name only the app's own web views (`main`, `w-*`), and a
//! view may only go to web addresses, never the app's own (`tauri://`), where it would count as
//! the app. Logins in them persist, in a data store of their own.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use serde::{Deserialize, Serialize};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, Webview, WebviewUrl, Window};

#[derive(Default)]
pub struct Browsers {
    next: AtomicU64,
}

/// Where the tab's area is in the window's page (logical pixels).
#[derive(Deserialize)]
pub struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// What the page hears about a view (`browser` events, to the window that has it).
#[derive(Clone, Serialize)]
struct Change {
    label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    loading: Option<bool>,
    /// A link here asked for a new window: open this address in a new tab.
    #[serde(skip_serializing_if = "Option::is_none")]
    open: Option<String>,
}

/// What Send to session takes from a page.
#[derive(Serialize, Deserialize, Debug, PartialEq)]
pub struct Read {
    url: String,
    title: String,
    /// The selection, if there was one; else the page's readable text.
    text: String,
    selection: bool,
}

/// Most of a long page, not all of it: what a session reads should stay a reasonable size.
const MAX_TEXT: usize = 200_000;

/// An address typed in the bar or asked for by the page: http or https, with a host.
fn web_url(s: &str) -> Result<Url, String> {
    let url = Url::parse(s.trim()).map_err(|_| format!("Not a web address: {s}"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none_or(str::is_empty) || !may_load(&url) {
        return Err(format!("Only http and https addresses open in a browser tab: {s}"));
    }
    Ok(url)
}

/// Where a view (or a frame in it) may go: web addresses, and the blank, blob and data pages
/// sites make for their own frames. Never the app's own pages (`tauri://localhost`, or
/// `http://tauri.localhost` on Windows) or its IPC, where the view would count as the app.
fn may_load(url: &Url) -> bool {
    match url.scheme() {
        "http" | "https" => !url.host_str().is_some_and(|h| h.ends_with(".localhost") && h != "localhost"),
        "blob" | "data" => true,
        _ => url.as_str() == "about:blank" || url.as_str() == "about:srcdoc",
    }
}

/// What a view tells sites it is: Safari, at the version installed, which runs on the same
/// system WebKit as these views. Without it a view sends WebKit's bare user agent, with no Safari
/// in it, and sites like Google serve the pages they keep for unknown old browsers.
#[cfg(target_os = "macos")]
fn user_agent() -> &'static str {
    static UA: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    UA.get_or_init(|| {
        let version = plist::Value::from_file("/Applications/Safari.app/Contents/Info.plist")
            .ok()
            .and_then(|p| p.as_dictionary()?.get("CFBundleShortVersionString")?.as_string().map(str::to_string));
        safari_ua(version.as_deref())
    })
}

/// Safari's user agent (its OS part is frozen at 10_15_7, as Safari's own is) at `version`, if
/// that looks like one.
#[cfg(any(target_os = "macos", test))]
fn safari_ua(version: Option<&str>) -> String {
    let v = version.filter(|v| v.split('.').all(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))).unwrap_or("26.0");
    format!("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/{v} Safari/605.1.15")
}

fn is_label(s: &str) -> bool {
    s.strip_prefix("b-").is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// The view `label`, if it's a browser view of this window (a window can't touch another's).
fn view(window: &Window, label: &str) -> Result<Webview, String> {
    if !is_label(label) {
        return Err(format!("Not a browser tab: {label}"));
    }
    window
        .app_handle()
        .get_webview(label)
        .filter(|v| v.window().label() == window.label())
        .ok_or_else(|| "That browser tab is closed.".into())
}

fn emit(app: &AppHandle, owner: &str, s: Change) {
    let _ = app.emit_to(owner, "browser", s);
}

/// Opens a browser view at `url` over `rect` of the caller's window. Returns its label.
#[tauri::command]
pub fn browser_open(app: AppHandle, window: Window, browsers: State<'_, Browsers>, url: String, rect: Rect) -> Result<String, String> {
    let url = web_url(&url)?;
    let label = format!("b-{}", browsers.next.fetch_add(1, Ordering::Relaxed) + 1);
    let owner = window.label().to_string();
    let (a, o, l) = (app.clone(), owner.clone(), label.clone());
    let (a2, o2, l2) = (app.clone(), owner.clone(), label.clone());
    let (a3, o3, l3) = (app.clone(), owner.clone(), label.clone());
    let b = WebviewBuilder::new(&label, WebviewUrl::External(url))
        .on_navigation(may_load)
        .on_page_load(move |v, p| {
            let url = v.url().map(|u| u.to_string()).unwrap_or_else(|_| p.url().to_string());
            emit(&a, &o, Change { label: l.clone(), url: Some(url), title: None, loading: Some(matches!(p.event(), PageLoadEvent::Started)), open: None });
        })
        .on_document_title_changed(move |_, title| emit(&a2, &o2, Change { label: l2.clone(), url: None, title: Some(title), loading: None, open: None }))
        // A link that opens a new window opens in a new tab instead.
        .on_new_window(move |url, _| {
            if web_url(url.as_str()).is_ok() {
                emit(&a3, &o3, Change { label: l3.clone(), url: None, title: None, loading: None, open: Some(url.to_string()) });
            }
            NewWindowResponse::Deny
        });
    #[cfg(target_os = "macos")]
    let b = b.user_agent(user_agent());
    #[cfg(target_os = "macos")]
    let b = b.data_store_identifier(*b"blimp-browser-v1"); // macOS 14+; older ones use the default store
    #[cfg(not(target_os = "macos"))]
    let b = match app.path().app_data_dir() {
        Ok(d) => b.data_directory(d.join("browser")),
        Err(_) => b,
    };
    window
        .add_child(b, LogicalPosition::new(rect.x, rect.y), LogicalSize::new(rect.w.max(1.0), rect.h.max(1.0)))
        .map_err(|e| e.to_string())?;
    Ok(label)
}

/// The tab's area moved or changed size.
#[tauri::command]
pub fn browser_bounds(window: Window, label: String, rect: Rect) -> Result<(), String> {
    let v = view(&window, &label)?;
    let bounds = tauri::Rect { position: LogicalPosition::new(rect.x, rect.y).into(), size: LogicalSize::new(rect.w.max(1.0), rect.h.max(1.0)).into() };
    v.set_bounds(bounds).map_err(|e| e.to_string())
}

/// Shows or hides the view: hidden while its tab isn't in front, or something of the page's
/// (a dialog, a menu) is over it, since a native view is drawn above all of the page.
#[tauri::command]
pub fn browser_show(window: Window, label: String, shown: bool) -> Result<(), String> {
    let v = view(&window, &label)?;
    if shown { v.show() } else { v.hide() }.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_go(window: Window, label: String, url: String) -> Result<(), String> {
    let url = web_url(&url)?;
    view(&window, &label)?.navigate(url).map_err(|e| e.to_string())
}

/// Back, Forward or Reload.
#[tauri::command]
pub fn browser_nav(window: Window, label: String, action: String) -> Result<(), String> {
    let v = view(&window, &label)?;
    match action.as_str() {
        "back" => v.eval("history.back()"),
        "forward" => v.eval("history.forward()"),
        "reload" => v.reload(),
        _ => return Err(format!("Unknown browser action: {action}")),
    }
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_close(window: Window, label: String) -> Result<(), String> {
    view(&window, &label)?.close().map_err(|e| e.to_string())
}

/// The page's selection, else the text of its article or main part, else of its body.
const READ_SCRIPT: &str = r#"(() => {
  const sel = String(window.getSelection() || "").trim();
  const part = document.querySelector("article, main, [role=main]") || document.body;
  return JSON.stringify({ title: document.title, selection: !!sel, text: sel || (part ? part.innerText : "") });
})()"#;

/// What the script gave back: the page's JSON, itself JSON-encoded as a string by the web view.
fn parse_read(raw: &str, url: String) -> Result<Read, String> {
    #[derive(Deserialize)]
    struct Got {
        title: String,
        selection: bool,
        text: String,
    }
    let inner: String = serde_json::from_str(raw).map_err(|_| "The page didn't answer.".to_string())?;
    let got: Got = serde_json::from_str(&inner).map_err(|_| "The page didn't answer.".to_string())?;
    let text = match got.text.char_indices().nth(MAX_TEXT) {
        Some((i, _)) => got.text[..i].to_string(),
        None => got.text,
    };
    Ok(Read { url, title: got.title, text, selection: got.selection })
}

/// The page's address (as the view has it, not as the page says), title and text.
#[tauri::command]
pub async fn browser_read(window: Window, label: String) -> Result<Read, String> {
    let v = view(&window, &label)?;
    let url = v.url().map_err(|e| e.to_string())?.to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    v.eval_with_callback(READ_SCRIPT, move |r| {
        let _ = tx.send(r);
    })
    .map_err(|e| e.to_string())?;
    let raw = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(5)))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "The page didn't answer in time.".to_string())?;
    parse_read(&raw, url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_addresses_open() {
        assert!(web_url("https://example.com/a?b").is_ok());
        assert!(web_url(" http://127.0.0.1:5173/ ").is_ok());
        for bad in ["tauri://localhost/", "http://tauri.localhost/", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "about:blank", "http://", "example.com", ""] {
            assert!(web_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_view_never_goes_to_the_app_itself() {
        let ok = |s: &str| may_load(&Url::parse(s).unwrap());
        assert!(ok("https://example.com/") && ok("http://127.0.0.1:3000/") && ok("about:blank") && ok("about:srcdoc"));
        assert!(ok("blob:https://example.com/1234") && ok("data:text/html,hi"));
        assert!(ok("http://localhost:8080/"));
        assert!(!ok("tauri://localhost/") && !ok("http://tauri.localhost/x") && !ok("https://tauri.localhost/") && !ok("http://ipc.localhost/cmd"));
        assert!(!ok("file:///Users/me/.ssh/id_ed25519") && !ok("ipc://localhost/x") && !ok("asset://localhost/x") && !ok("about:config"));
    }

    #[test]
    fn sites_see_safari() {
        let ua = |v| safari_ua(v);
        assert_eq!(ua(Some("18.5")), "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15");
        assert!(ua(Some("26.0.1")).contains(" Version/26.0.1 Safari/"));
        for odd in [None, Some(""), Some("18."), Some("18.5 beta"), Some("x")] {
            assert!(ua(odd).contains(" Version/26.0 Safari/"), "{odd:?}");
        }
    }

    #[test]
    fn labels_are_browser_views_only() {
        assert!(is_label("b-1") && is_label("b-42"));
        for bad in ["main", "w-1", "b-", "b-1x", "b--1", "", "B-1"] {
            assert!(!is_label(bad), "{bad}");
        }
    }

    #[test]
    fn reads_what_the_page_gave_back() {
        let page = serde_json::json!({ "title": "T", "selection": false, "text": "hello" }).to_string();
        let raw = serde_json::to_string(&page).unwrap();
        assert_eq!(
            parse_read(&raw, "https://x/".into()).unwrap(),
            Read { url: "https://x/".into(), title: "T".into(), text: "hello".into(), selection: false }
        );
        let long = serde_json::to_string(&serde_json::json!({ "title": "", "selection": true, "text": "é".repeat(MAX_TEXT + 5) }).to_string()).unwrap();
        assert_eq!(parse_read(&long, String::new()).unwrap().text.chars().count(), MAX_TEXT);
        assert!(parse_read("null", String::new()).is_err());
        assert!(parse_read("\"not json\"", String::new()).is_err());
    }
}
