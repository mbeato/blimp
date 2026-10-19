fn main() {
    // Listing the app's own commands puts them under capabilities like plugin commands, so
    // capabilities/default.json grants exactly these and nothing else can be invoked.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&[
                "connect",
                "disconnect",
                "forward_port",
                "unforward_port",
                "update_server",
                "open_window",
                "focus_project",
                "drop_session",
                "set_shown",
                "focus_session",
                "take_session",
                "download",
                "upload",
                "pick_upload",
                "cancel_transfer",
                "set_window_projects",
                "set_viewing",
                "claim_notice",
            ])),
    )
    .expect("failed to run tauri-build")
}
