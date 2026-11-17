// The native half of the blimp app: it opens SSH tunnels to blimpd and hosts the UI.
// Sessions, terminals and files all live in the UI, which talks to blimpd through the tunnel.

mod menu;
mod relaunch;
mod transfer;
mod tunnel;
mod windows;

use tauri::{Manager, RunEvent, WindowEvent};

fn main() {
    let builder = tauri::Builder::default();
    // A small menu until the first window describes the full one (menu.rs).
    #[cfg(target_os = "macos")]
    let builder = builder.menu(|app| menu::build(app, &menu::fallback()));
    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(tunnel::Tunnels::default())
        .manage(transfer::Transfers::default())
        .manage(windows::Windows::default())
        .setup(|app| {
            // The last run's windows, for the first window to reopen (restore_windows).
            app.state::<windows::Windows>().load(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            tunnel::connect,
            tunnel::disconnect,
            tunnel::drop_tunnel,
            tunnel::forward_port,
            tunnel::unforward_port,
            tunnel::update_server,
            tunnel::install_server,
            tunnel::ssh_hosts,
            windows::open_window,
            windows::focus_project,
            windows::drop_session,
            windows::drag_hover,
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
            menu::set_menu,
            relaunch::relaunch
        ])
        .on_window_event(|window, event| match event {
            WindowEvent::Destroyed => {
                window.state::<windows::Windows>().forget(window.app_handle(), window.label());
                // The last window is gone, and with it the page that described the menu and
                // would act on its items.
                if window.app_handle().webview_windows().keys().all(|l| l == window.label()) {
                    let _ = menu::show(window.app_handle(), &menu::fallback());
                }
            }
            WindowEvent::Focused(true) => window.state::<windows::Windows>().focused(window.label()),
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => window.state::<windows::Windows>().moved(window),
            // Files let go on a window from Finder may be uploaded (the page gets the same event).
            // Only on the drop: a file merely dragged across the window isn't one.
            WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => window.state::<transfer::Transfers>().allow(paths),
            _ => {}
        })
        // A click on one of the page's menu items (menu.rs).
        .on_menu_event(|app, event| menu::clicked(app, event.id().as_ref()))
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
