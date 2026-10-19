fn main() {
    // Listing the app's own commands puts them under capabilities like plugin commands, so
    // capabilities/default.json grants exactly these and nothing else can be invoked.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&[
                "connect",
                "disconnect",
                "open_window",
                "focus_project",
                "drop_session",
                "set_window_projects",
                "set_viewing",
                "claim_notice",
            ])),
    )
    .expect("failed to run tauri-build")
}
