// The native half of the blimp app: it opens SSH tunnels to blimpd and hosts the UI.
// Sessions, terminals and files all live in the UI, which talks to blimpd through the tunnel.

mod browser;
mod transfer;
mod tunnel;
mod windows;

use tauri::{Emitter, Manager, RunEvent, WindowEvent};

fn main() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(menu);
    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(tunnel::Tunnels::default())
        .manage(transfer::Transfers::default())
        .manage(windows::Windows::default())
        .manage(browser::Browsers::default())
        .setup(|app| {
            // The last run's windows, for the first window to reopen (restore_windows).
            app.state::<windows::Windows>().load(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            tunnel::connect,
            tunnel::disconnect,
            tunnel::forward_port,
            tunnel::unforward_port,
            tunnel::update_server,
            windows::open_window,
            windows::focus_project,
            windows::drop_session,
            windows::set_shown,
            windows::focus_session,
            windows::take_session,
            windows::save_window_layout,
            windows::restore_windows,
            transfer::download,
            transfer::upload,
            transfer::pick_upload,
            transfer::cancel_transfer,
            windows::set_window_projects,
            windows::set_viewing,
            windows::claim_notice,
            browser::browser_open,
            browser::browser_bounds,
            browser::browser_show,
            browser::browser_go,
            browser::browser_nav,
            browser::browser_close,
            browser::browser_read
        ])
        .on_window_event(|window, event| match event {
            WindowEvent::Destroyed => window.state::<windows::Windows>().forget(window.app_handle(), window.label()),
            WindowEvent::Focused(true) => window.state::<windows::Windows>().focused(window.label()),
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => window.state::<windows::Windows>().moved(window),
            // Files let go on a window from Finder may be uploaded (the page gets the same event).
            // Only on the drop: a file merely dragged across the window isn't one.
            WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => window.state::<transfer::Transfers>().allow(paths),
            _ => {}
        })
        // blimp > Check for Updates…: the focused window checks and says what it found.
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == "check-updates" || id == "open-settings" {
                let w = app.windows().into_values().find(|w| w.is_focused().unwrap_or(false));
                if let Some(w) = w.or_else(|| app.get_window("main")) {
                    let _ = w.emit_to(w.label(), id, ());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while starting blimp")
        .run(|app, event| match event {
            // ssh children would otherwise outlive the app and keep their tunnels open.
            RunEvent::Exit => {
                app.state::<windows::Windows>().exiting(app);
                app.state::<tunnel::Tunnels>().close_all()
            }
            // Clicking the Dock icon with every window closed opens a new one, as Mac apps do.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { has_visible_windows: false, .. } => {
                let _ = windows::create(app, &app.state::<windows::Windows>(), "", None);
            }
            _ => {}
        });
}

/// The macOS menu bar. Tauri's default one binds ⌘W to Close Window, and a menu shortcut
/// wins over the page, so the UI would never see ⌘W (close tab). This one keeps only what
/// the app needs from the system and leaves ⌘W, ⌘N, ⌘P and ⌘K to the UI.
#[cfg(target_os = "macos")]
fn menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

    let updates = MenuItemBuilder::with_id("check-updates", "Check for Updates…").build(app)?;
    let settings = MenuItemBuilder::with_id("open-settings", "Settings…").accelerator("CmdOrCtrl+,").build(app)?;
    let app_menu = SubmenuBuilder::new(app, "blimp")
        .about(None)
        .item(&updates)
        .separator()
        .item(&settings)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .build()?;
    MenuBuilder::new(app)
        .items(&[&app_menu, &edit, &window])
        .build()
}
