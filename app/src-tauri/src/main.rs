// The native half of the blimp app: it opens SSH tunnels to blimpd and hosts the UI.
// Sessions, terminals and files all live in the UI, which talks to blimpd through the tunnel.

mod tunnel;
mod windows;

use tauri::{Manager, RunEvent, WindowEvent};

fn main() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(menu);
    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(tunnel::Tunnels::default())
        .manage(windows::Windows::default())
        .invoke_handler(tauri::generate_handler![
            tunnel::connect,
            tunnel::disconnect,
            windows::open_window,
            windows::set_window_project,
            windows::set_viewing,
            windows::claim_notice
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                window.state::<windows::Windows>().forget(window.label());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while starting blimp")
        .run(|app, event| match event {
            // ssh children would otherwise outlive the app and keep their tunnels open.
            RunEvent::Exit => app.state::<tunnel::Tunnels>().close_all(),
            // Clicking the Dock icon with every window closed opens a new one, as Mac apps do.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { has_visible_windows: false, .. } => {
                let _ = windows::create(app, &app.state::<windows::Windows>(), "");
            }
            _ => {}
        });
}

/// The macOS menu bar. Tauri's default one binds ⌘W to Close Window, and a menu shortcut
/// wins over the page, so the UI would never see ⌘W (close tab). This one keeps only what
/// the app needs from the system and leaves ⌘W, ⌘N, ⌘P and ⌘K to the UI.
#[cfg(target_os = "macos")]
fn menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{MenuBuilder, SubmenuBuilder};

    let app_menu = SubmenuBuilder::new(app, "blimp")
        .about(None)
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
