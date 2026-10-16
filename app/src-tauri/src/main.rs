// The native half of the blimp app: it opens SSH tunnels to blimpd and hosts the UI.
// Sessions, terminals and files all live in the UI, which talks to blimpd through the tunnel.

mod tunnel;

use tauri::{Manager, RunEvent};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(tunnel::Tunnels::default())
        .invoke_handler(tauri::generate_handler![
            tunnel::connect,
            tunnel::disconnect
        ])
        .build(tauri::generate_context!())
        .expect("error while starting blimp")
        .run(|app, event| {
            // ssh children would otherwise outlive the app and keep their tunnels open.
            if let RunEvent::Exit = event {
                app.state::<tunnel::Tunnels>().close_all();
            }
        });
}
