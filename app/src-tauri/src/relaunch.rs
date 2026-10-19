//! After an update: the app quits, and a small helper opens it again once it's gone.
//! Tauri's own restart opens a second copy (`open -n`) while this one is still running, and the
//! Dock gives that copy an icon of its own, apart from the one kept in the Dock. Opened after
//! this one has quit, it's the app again, on that icon.

use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::AppHandle;

/// The .app bundle the running binary is in (…/blimp.app/Contents/MacOS/blimp).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    if macos.file_name()? != "MacOS" || contents.file_name()? != "Contents" {
        return None;
    }
    contents.parent().map(Path::to_path_buf)
}

/// The helper: waits until process `pid` is gone (at most 30 s), then runs `opener bundle`.
/// The pid and the path are arguments, never part of the script.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn helper(pid: u32, bundle: &Path, opener: &str) -> Command {
    let mut c = Command::new("/bin/sh");
    c.arg("-c")
        .arg(r#"i=0; while kill -0 "$1" 2>/dev/null && [ "$i" -lt 300 ]; do sleep 0.1; i=$((i+1)); done; exec "$3" "$2""#)
        .arg("sh")
        .arg(pid.to_string())
        .arg(bundle)
        .arg(opener);
    c
}

/// Quits, then opens the (updated) app again. Outside a Mac app bundle: Tauri's restart.
#[tauri::command]
pub fn relaunch(app: AppHandle) {
    #[cfg(target_os = "macos")]
    if let Some(bundle) = std::env::current_exe().ok().and_then(|e| bundle_of(&e)) {
        use std::os::unix::process::CommandExt;
        use std::process::Stdio;
        // Its own process group, so nothing sent to the app's reaches it.
        let spawned = helper(std::process::id(), &bundle, "/usr/bin/open")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn();
        if spawned.is_ok() {
            // RunEvent::Exit runs as for any quit: windows saved, tunnels closed.
            return app.exit(0);
        }
    }
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn finds_the_bundle_of_a_mac_app() {
        assert_eq!(bundle_of(Path::new("/Applications/blimp.app/Contents/MacOS/blimp")), Some(PathBuf::from("/Applications/blimp.app")));
        assert_eq!(bundle_of(Path::new("/home/u/blimp/target/debug/blimp")), None);
        assert_eq!(bundle_of(Path::new("/blimp")), None);
    }

    #[test]
    fn the_helper_opens_the_app_only_once_it_has_quit() {
        // Stands in for the app: gone after 0.4 s, and reaped, so it doesn't linger as a zombie.
        let mut app = Command::new("sleep").arg("0.4").spawn().unwrap();
        let pid = app.id();
        std::thread::spawn(move || app.wait());
        let bundle = Path::new("/tmp/a b'c \"d\"/blimp.app");
        let start = Instant::now();
        let out = helper(pid, bundle, "/bin/echo").output().unwrap();
        assert!(start.elapsed() >= Duration::from_millis(350), "{:?}", start.elapsed());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim_end(), bundle.to_str().unwrap());
    }
}
