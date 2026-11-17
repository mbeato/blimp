//! The macOS menu bar. The focused window's page describes it (set_menu, plain JSON made from
//! the page's command table by app/src/lib/menu.ts) and Rust draws it: the page has no
//! core:menu permission, so it can't build menus itself, and what a menu item may hold stays
//! small and checked here. A click goes back to that window as one "menu" event carrying the
//! item's id; Rust does two ids itself (clicked).

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Window};

const MAX_ITEMS: usize = 400;
const MAX_DEPTH: usize = 3;
const MAX_TITLE: usize = 200;

/// One entry of the description. Anything else in it (a field or a kind this doesn't name)
/// refuses the whole description.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Item {
    // {} rather than a unit variant: serde ignores extra fields on a unit variant.
    Separator {},
    /// A system item: AppKit does it, and it never reaches Rust or the page.
    Native { name: Native },
    /// checked present: a check item. key: as muda writes it ("Cmd+Shift+BracketLeft").
    Command { id: String, title: String, key: Option<String>, enabled: bool, checked: Option<bool> },
    /// role: the menu macOS fills in itself (the open windows; the Help search box).
    Submenu { title: String, enabled: bool, role: Option<Role>, items: Vec<Item> },
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Native {
    About,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Minimize,
    Zoom,
    Fullscreen,
    BringAllToFront,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Role {
    Window,
    Help,
}

/// A description the page sent, checked: menus only at the top, ids `[a-z0-9:-]{1,64}`,
/// titles of 1 to 200 characters with no control characters, at most 400 entries and 3 menus
/// deep. A key this menu doesn't take only loses the key (accelerator).
pub fn validate(spec: Value) -> Result<Vec<Item>, String> {
    let mut menus: Vec<Item> = serde_json::from_value(spec).map_err(|e| format!("Not a menu: {e}"))?;
    if menus.iter().any(|m| !matches!(m, Item::Submenu { .. })) {
        return Err("The menu bar holds menus only.".into());
    }
    let mut count = 0;
    for m in &mut menus {
        check(m, 1, &mut count)?;
    }
    Ok(menus)
}

fn check(item: &mut Item, depth: usize, count: &mut usize) -> Result<(), String> {
    *count += 1;
    if *count > MAX_ITEMS {
        return Err(format!("A menu has at most {MAX_ITEMS} items."));
    }
    match item {
        Item::Command { id, title, key, .. } => {
            let ok = (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b':' || b == b'-');
            if !ok {
                return Err("A menu item's id isn't one.".into());
            }
            check_title(title)?;
            *key = key.take().filter(|k| accelerator(k));
        }
        Item::Submenu { title, items, .. } => {
            if depth > MAX_DEPTH {
                return Err(format!("Menus go at most {MAX_DEPTH} deep."));
            }
            check_title(title)?;
            for i in items {
                check(i, depth + 1, count)?;
            }
        }
        Item::Separator {} | Item::Native { .. } => {}
    }
    Ok(())
}

fn check_title(title: &str) -> Result<(), String> {
    let n = title.chars().count();
    if n == 0 || n > MAX_TITLE || title.chars().any(char::is_control) {
        return Err("A menu title must be 1 to 200 characters, with no control characters.".into());
    }
    Ok(())
}

/// Whether a key is one this menu takes, as muda reads it: ⌘ always, ⇧ and ⌥ as wanted, never
/// Control (the terminal's), and a letter, a digit or one of the punctuation keys by name.
fn accelerator(key: &str) -> bool {
    const NAMED: [&str; 11] = ["Comma", "Period", "Slash", "Semicolon", "Quote", "Backquote", "Backslash", "BracketLeft", "BracketRight", "Equal", "Minus"];
    let mut parts: Vec<&str> = key.split('+').collect();
    let Some(main) = parts.pop() else { return false };
    let mut mods = parts.clone();
    mods.sort_unstable();
    mods.dedup();
    let mods_ok = mods.len() == parts.len() && mods.contains(&"Cmd") && mods.iter().all(|m| ["Cmd", "Shift", "Alt"].contains(m));
    let one = |prefix: &str, ok: fn(char) -> bool| {
        let rest = main.strip_prefix(prefix).unwrap_or("");
        rest.len() == 1 && rest.chars().all(ok)
    };
    let main_ok = NAMED.contains(&main) || one("", |c| c.is_ascii_uppercase() || c.is_ascii_digit()) || one("Key", |c| c.is_ascii_uppercase()) || one("Digit", |c| c.is_ascii_digit());
    mods_ok && main_ok
}

/// The menu before any page has described one, and once the last window has closed: what the
/// app needs from the system, and New Window (Rust opens it when there is none; clicked).
pub fn fallback() -> Vec<Item> {
    let native = |name: &str| json!({ "kind": "native", "name": name });
    let sep = json!({ "kind": "separator" });
    let menu = |title: &str, items: Vec<Value>| json!({ "kind": "submenu", "title": title, "enabled": true, "items": items });
    let mut window = menu("Window", vec![native("minimize"), native("zoom")]);
    window["role"] = json!("window");
    let mut help = menu("Help", vec![]);
    help["role"] = json!("help");
    let spec = json!([
        menu("blimp", vec![native("about"), sep.clone(), native("hide"), native("hide-others"), native("show-all"), sep.clone(), native("quit")]),
        menu("File", vec![json!({ "kind": "command", "id": "new-window", "title": "New Window", "key": "Cmd+Shift+N", "enabled": true })]),
        menu("Edit", vec![native("undo"), native("redo"), sep, native("cut"), native("copy"), native("paste"), native("select-all")]),
        window,
        help,
    ]);
    validate(spec).expect("the built-in menu is valid")
}

/// Replaces the menu bar with this window's description. The menu is app-wide on macOS, so
/// only the focused window describes it; one in the background is ignored, unless it's the
/// only window. Elsewhere there's no menu bar: the description is only checked.
#[tauri::command]
pub fn set_menu(app: AppHandle, window: Window, spec: Value) -> Result<(), String> {
    let menus = validate(spec)?;
    if !window.is_focused().unwrap_or(false) && app.webview_windows().len() > 1 {
        return Ok(());
    }
    show(&app, &menus)
}

#[cfg(target_os = "macos")]
pub fn show(app: &AppHandle, menus: &[Item]) -> Result<(), String> {
    app.set_menu(build(app, menus).map_err(|e| e.to_string())?).map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn show(_app: &AppHandle, _menus: &[Item]) -> Result<(), String> {
    Ok(())
}

/// The menu itself. Built on every platform, so the Linux checks compile it, but only shown on
/// macOS.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn build(app: &AppHandle, menus: &[Item]) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let bar = tauri::menu::Menu::new(app)?;
    for m in menus {
        bar.append(&entry(app, m)?)?;
    }
    Ok(bar)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn entry(app: &AppHandle, item: &Item) -> tauri::Result<tauri::menu::MenuItemKind<tauri::Wry>> {
    use tauri::menu::{CheckMenuItem, MenuItem, MenuItemKind, PredefinedMenuItem as P, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID};
    Ok(match item {
        Item::Separator {} => MenuItemKind::Predefined(P::separator(app)?),
        Item::Native { name } => MenuItemKind::Predefined(match name {
            Native::About => P::about(app, None, None)?,
            Native::Hide => P::hide(app, None)?,
            Native::HideOthers => P::hide_others(app, None)?,
            Native::ShowAll => P::show_all(app, None)?,
            Native::Quit => P::quit(app, None)?,
            Native::Undo => P::undo(app, None)?,
            Native::Redo => P::redo(app, None)?,
            Native::Cut => P::cut(app, None)?,
            Native::Copy => P::copy(app, None)?,
            Native::Paste => P::paste(app, None)?,
            Native::SelectAll => P::select_all(app, None)?,
            Native::Minimize => P::minimize(app, None)?,
            Native::Zoom => P::maximize(app, None)?,
            Native::Fullscreen => P::fullscreen(app, Some("Enter Full Screen"))?,
            Native::BringAllToFront => P::bring_all_to_front(app, None)?,
        }),
        Item::Command { id, title, key, enabled, checked: Some(on) } => MenuItemKind::Check(CheckMenuItem::with_id(app, id, literal(title), *enabled, *on, key.as_deref())?),
        Item::Command { id, title, key, enabled, checked: None } => MenuItemKind::MenuItem(MenuItem::with_id(app, id, literal(title), *enabled, key.as_deref())?),
        Item::Submenu { title, enabled, role, items } => {
            // Tauri hands these two ids to AppKit as its Window and Help menus.
            let menu = match role {
                Some(Role::Window) => Submenu::with_id(app, WINDOW_SUBMENU_ID, literal(title), *enabled)?,
                Some(Role::Help) => Submenu::with_id(app, HELP_SUBMENU_ID, literal(title), *enabled)?,
                None => Submenu::new(app, literal(title), *enabled)?,
            };
            for i in items {
                menu.append(&entry(app, i)?)?;
            }
            MenuItemKind::Submenu(menu)
        }
    })
}

/// A title as muda shows it as typed: muda reads a lone "&" as a mnemonic mark and drops it
/// (a server "R&D" would read "RD"), and "&&" as one "&". Checked as typed (check_title).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn literal(title: &str) -> String {
    title.replace('&', "&&")
}

/// Where a click goes (clicked).
#[derive(Debug, PartialEq)]
enum Route {
    /// Close the focused window.
    Close,
    /// Rust opens a new window itself.
    NewWindow,
    /// To the focused window's page.
    Focused,
    /// To main's page (else any window's), focused or not. raise: unminimise and focus that
    /// window first, for what shows in it (the Settings sheet, the update bar).
    Main { raise: bool },
    /// Nowhere.
    Drop,
}

/// With no focused (key) window, every window may be minimised or gone: New Window is Rust's,
/// the app-wide items go to main, and anything that acts on a window is dropped rather than
/// done in one the person can't see. Help and Report open a web page, so main isn't raised.
fn route(id: &str, focused: bool) -> Route {
    match id {
        "close-window" => Route::Close,
        "new-window" if !focused => Route::NewWindow,
        _ if focused => Route::Focused,
        "settings" | "check-updates" => Route::Main { raise: true },
        "help" | "report" => Route::Main { raise: false },
        _ => Route::Drop,
    }
}

/// A menu item was clicked. Close Window closes the focused window (a normal close: windows.rs
/// forgets it as for the red button); New Window with no focused window opens one, since there's
/// no page to ask. Everything else goes to a window's page as "menu" (route).
pub fn clicked(app: &AppHandle, id: &str) {
    let focused = app.windows().into_values().find(|w| w.is_focused().unwrap_or(false));
    let target = match route(id, focused.is_some()) {
        Route::Close => {
            if let Some(w) = focused {
                let _ = w.close();
            }
            return;
        }
        Route::NewWindow => {
            let _ = crate::windows::create(app, &app.state::<crate::windows::Windows>(), "", None);
            return;
        }
        Route::Focused => focused,
        Route::Main { raise } => {
            // main may have been closed while other windows stay open.
            let w = app.get_window("main").or_else(|| app.windows().into_values().next());
            if let Some(w) = w.as_ref().filter(|_| raise) {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            w
        }
        Route::Drop => None,
    };
    if let Some(w) = target {
        let _ = w.emit_to(w.label(), "menu", id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd(id: &str, title: &str, key: Option<&str>) -> Value {
        let mut c = json!({ "kind": "command", "id": id, "title": title, "enabled": true });
        if let Some(k) = key {
            c["key"] = json!(k);
        }
        c
    }

    fn menu(title: &str, items: Vec<Value>) -> Value {
        json!({ "kind": "submenu", "title": title, "enabled": true, "items": items })
    }

    fn good() -> Value {
        json!([
            menu("blimp", vec![json!({ "kind": "native", "name": "about" }), json!({ "kind": "separator" }), json!({ "kind": "native", "name": "quit" })]),
            menu("File", vec![
                cmd("new-claude", "New Claude Session", Some("Cmd+N")),
                menu("Open Recent", vec![cmd("recent:0", "~/proj", None)]),
                json!({ "kind": "command", "id": "toggle-files", "title": "Files", "key": "Cmd+B", "enabled": false, "checked": true }),
            ]),
            json!({ "kind": "submenu", "title": "Window", "enabled": true, "role": "window", "items": [{ "kind": "native", "name": "bring-all-to-front" }] }),
        ])
    }

    #[test]
    fn a_good_description_passes_as_it_is() {
        let menus = validate(good()).unwrap();
        assert_eq!(menus.len(), 3);
        let Item::Submenu { items, .. } = &menus[1] else { panic!() };
        assert_eq!(items[0], Item::Command { id: "new-claude".into(), title: "New Claude Session".into(), key: Some("Cmd+N".into()), enabled: true, checked: None });
        assert!(matches!(&items[1], Item::Submenu { items, .. } if items.len() == 1));
        assert!(matches!(&items[2], Item::Command { checked: Some(true), enabled: false, .. }));
        assert!(matches!(&menus[2], Item::Submenu { role: Some(Role::Window), .. }));
    }

    #[test]
    fn the_built_in_menu_is_valid() {
        let menus = fallback();
        let titles: Vec<&str> = menus.iter().map(|m| match m { Item::Submenu { title, .. } => title.as_str(), _ => "" }).collect();
        assert_eq!(titles, ["blimp", "File", "Edit", "Window", "Help"]);
        let Item::Submenu { items, .. } = &menus[1] else { panic!() };
        assert!(matches!(&items[0], Item::Command { id, key: Some(k), .. } if id == "new-window" && k == "Cmd+Shift+N"));
        assert!(matches!(&menus[4], Item::Submenu { role: Some(Role::Help), .. }));
    }

    #[test]
    fn refuses_what_isnt_a_menu() {
        let refused = |v: Value| assert!(validate(v.clone()).is_err(), "accepted {v}");
        refused(json!({}));
        refused(json!([cmd("new-claude", "New", None)]));
        refused(json!([json!({ "kind": "separator" })]));
        // Unknown fields and kinds, and native items that don't exist.
        refused(json!([menu("File", vec![json!({ "kind": "separator", "extra": 1 })])]));
        refused(json!([json!({ "kind": "submenu", "title": "File", "enabled": true, "items": [], "icon": "x" })]));
        refused(json!([menu("File", vec![json!({ "kind": "command", "id": "a", "title": "A", "enabled": true, "action": "rm" })])]));
        refused(json!([menu("File", vec![json!({ "kind": "script", "id": "a" })])]));
        refused(json!([menu("File", vec![json!({ "kind": "native", "name": "close-window" })])]));
        refused(json!([json!({ "kind": "submenu", "title": "File", "enabled": true, "role": "services", "items": [] })]));
        // A missing field.
        refused(json!([menu("File", vec![json!({ "kind": "command", "id": "a", "title": "A" })])]));
    }

    #[test]
    fn refuses_bad_ids_and_titles() {
        let refused = |item: Value| assert!(validate(json!([menu("File", vec![item.clone()])])).is_err(), "accepted {item}");
        refused(cmd("", "A", None));
        refused(cmd("New", "A", None));
        refused(cmd("a b", "A", None));
        refused(cmd("__tauri_window_menu__", "A", None));
        refused(cmd(&"a".repeat(65), "A", None));
        refused(cmd("a", "", None));
        refused(cmd("a", "line\nbreak", None));
        refused(cmd("a", "tab\there", None));
        refused(cmd("a", &"x".repeat(201), None));
        refused(menu("bad\u{7}", vec![]));
        assert!(validate(json!([menu("File", vec![cmd(&"a".repeat(64), &"é".repeat(200), None), cmd("server:12", "Lab — offline", None)])])).is_ok());
    }

    #[test]
    fn refuses_too_many_or_too_deep() {
        let many: Vec<Value> = (0..399).map(|_| json!({ "kind": "separator" })).collect();
        assert!(validate(json!([menu("File", many.clone())])).is_ok());
        let mut more = many;
        more.push(json!({ "kind": "separator" }));
        assert!(validate(json!([menu("File", more)])).is_err());
        let three = menu("A", vec![menu("B", vec![menu("C", vec![cmd("a", "A", None)])])]);
        assert!(validate(json!([three])).is_ok());
        let four = menu("A", vec![menu("B", vec![menu("C", vec![menu("D", vec![])])])]);
        assert!(validate(json!([four])).is_err());
    }

    #[test]
    fn an_ampersand_in_a_title_is_kept() {
        assert_eq!(literal("R&D"), "R&&D");
        assert_eq!(literal("~/Q&A && more"), "~/Q&&A &&&& more");
        assert_eq!(literal("Lab"), "Lab");
        // Checked as typed: 200 characters with "&" in them still pass, though muda gets more.
        assert!(validate(json!([menu("File", vec![cmd("server:0", &"&".repeat(200), None)])])).is_ok());
    }

    #[test]
    fn a_click_goes_to_the_focused_window_and_with_none_only_app_items_go_to_main() {
        assert_eq!(route("close-tab", true), Route::Focused);
        assert_eq!(route("new-window", true), Route::Focused);
        assert_eq!(route("settings", true), Route::Focused);
        assert_eq!(route("close-window", true), Route::Close);
        // Every window minimised, or the last one closed.
        assert_eq!(route("new-window", false), Route::NewWindow);
        // Settings and the update bar are brought forward to be seen; Help and Report open a web page.
        assert_eq!(route("settings", false), Route::Main { raise: true });
        assert_eq!(route("check-updates", false), Route::Main { raise: true });
        assert_eq!(route("help", false), Route::Main { raise: false });
        assert_eq!(route("report", false), Route::Main { raise: false });
        assert_eq!(route("help", true), Route::Focused);
        assert_eq!(route("close-window", false), Route::Close);
        for id in ["close-tab", "new-claude", "save", "server:0", "recent:1", "toggle-files", "open-folder"] {
            assert_eq!(route(id, false), Route::Drop, "{id}");
        }
    }

    #[test]
    fn a_key_it_cant_read_only_loses_the_key() {
        let key = |k: &str| {
            let menus = validate(json!([menu("File", vec![cmd("a", "A", Some(k))])])).unwrap();
            let Item::Submenu { items, .. } = &menus[0] else { panic!() };
            let Item::Command { key, .. } = &items[0] else { panic!() };
            key.clone()
        };
        for k in ["Cmd+N", "Cmd+Shift+N", "Cmd+Comma", "Cmd+Alt+KeyB", "Cmd+Shift+BracketLeft", "Cmd+Shift+BracketRight", "Cmd+Equal", "Cmd+Minus", "Cmd+Digit0", "Cmd+0"] {
            assert_eq!(key(k).as_deref(), Some(k));
        }
        for k in ["N", "Ctrl+C", "Cmd+Ctrl+C", "Cmd+Cmd+N", "Cmd+Hyper+N", "Cmd+n", "Cmd+F5", "Cmd+Plus", "Cmd+", "", "Cmd+KeyBB", "Shift+Cmd"] {
            assert_eq!(key(k), None, "{k}");
        }
    }
}
