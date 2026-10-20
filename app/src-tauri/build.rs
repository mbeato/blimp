fn main() {
    // Listing the app's own commands puts them under capabilities like plugin commands, so
    // capabilities/default.json grants exactly these and nothing else can be invoked.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&[
                "connect",
                "disconnect",
                "drop_tunnel",
                "forward_port",
                "unforward_port",
                "update_server",
                "open_window",
                "focus_project",
                "drop_session",
                "drag_hover",
                "set_shown",
                "focus_session",
                "take_session",
                "save_window_layout",
                "restore_windows",
                "download",
                "upload",
                "pick_upload",
                "cancel_transfer",
                "set_window_projects",
                "set_viewing",
                "claim_notice",
                "relaunch",
            ])),
    )
    .expect("failed to run tauri-build")
}
