fn main() {
    // Listing the app's own commands puts them under capabilities like plugin commands, so
    // capabilities/default.json grants exactly these two and nothing else can be invoked.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["connect", "disconnect"])),
    )
    .expect("failed to run tauri-build")
}
