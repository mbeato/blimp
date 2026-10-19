//! File transfers between the Mac and a server's blimpd (docs/superpowers/specs/2026-10-19-next-ideas.md, 3).
//! Done here rather than in the page, so big files stream between disk and the tunnel and never
//! sit in the page's memory. The page names the server by its tunnel id; the port and token come
//! from the live tunnel, so the page can't point a transfer anywhere else. An upload reads only
//! what the user dropped on a window or picked in Upload…, and what's inside a dropped folder.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, Window};
use tauri_plugin_dialog::DialogExt;

use crate::tunnel::Tunnels;

#[derive(Default)]
pub struct Transfers {
    /// Local paths the user dropped or picked.
    allowed: Mutex<HashSet<PathBuf>>,
    /// Running transfers, by the page's id: set to cancel.
    cancel: Mutex<HashMap<u64, Arc<AtomicBool>>>,
}

impl Transfers {
    /// Files or folders dropped on a window (Tauri's drag-drop event) may be uploaded. Kept
    /// as real paths (symlinks and `..` resolved), so the check below can't be talked around.
    pub fn allow(&self, paths: &[PathBuf]) {
        let real: Vec<PathBuf> = paths.iter().filter_map(|p| fs::canonicalize(p).ok()).collect();
        self.allowed.lock().unwrap().extend(real);
    }

    /// The real path of `p`, if it is (or is inside) something dropped or picked. `p` itself must
    /// have no `..`: what's inside a dropped folder is sent by walking it, never by such a path.
    fn may_read(&self, p: &Path) -> Option<PathBuf> {
        if p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            return None;
        }
        let real = fs::canonicalize(p).ok()?;
        // Debug builds only: BLIMP_TEST_UPLOADS (a folder) counts as dropped, so app/e2e-native
        // can test uploads without a real drag from Finder. Release builds never read it.
        #[cfg(debug_assertions)]
        if let Some(d) = std::env::var("BLIMP_TEST_UPLOADS").ok().filter(|d| !d.is_empty()).and_then(|d| fs::canonicalize(d).ok()) {
            if real.starts_with(&d) {
                return Some(real);
            }
        }
        let allowed = self.allowed.lock().unwrap();
        allowed.iter().any(|a| real.starts_with(a)).then_some(real)
    }

    fn start(&self, id: u64) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.cancel.lock().unwrap().insert(id, flag.clone());
        flag
    }

    fn end(&self, id: u64) {
        self.cancel.lock().unwrap().remove(&id);
    }
}

#[derive(Clone, Serialize)]
struct Progress {
    id: u64,
    done: u64,
    total: u64,
}

/// Progress events to the window that asked, at most every 100 ms, and the cancel flag.
struct Meter {
    window: Window,
    id: u64,
    done: u64,
    total: u64,
    last: Instant,
    cancel: Arc<AtomicBool>,
}

impl Meter {
    fn add(&mut self, n: u64) -> io::Result<()> {
        if self.cancel.load(Ordering::Relaxed) {
            // Not Interrupted: io::copy (how ureq sends a body) retries that, forever.
            return Err(io::Error::other("Cancelled."));
        }
        self.done += n;
        if self.last.elapsed() >= Duration::from_millis(100) {
            self.last = Instant::now();
            self.emit();
        }
        Ok(())
    }

    fn emit(&self) {
        let _ = self.window.emit_to(self.window.label(), "transfer", Progress { id: self.id, done: self.done, total: self.total });
    }
}

/// A body for an upload that counts what's sent and stops when cancelled.
struct Counted<'a, R: Read> {
    inner: R,
    meter: &'a mut Meter,
}

impl<R: Read> Read for Counted<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.meter.add(n as u64)?;
        Ok(n)
    }
}

fn query(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-._~/".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

/// blimpd's error text ({"error": "..."}), else the status.
fn http_error(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, res) => {
            let text = res.into_string().unwrap_or_default();
            serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
                .unwrap_or_else(|| format!("blimpd answered {code}"))
        }
        ureq::Error::Transport(t) => format!("Lost the connection to blimpd: {t}"),
    }
}

/// A name from the server, made safe as a file name here: no folders, no "." or "..".
fn safe_name(name: &str) -> String {
    let n: String = name.chars().map(|c| if c == '/' || c == '\\' || c.is_control() { '-' } else { c }).collect();
    let n = n.trim().trim_start_matches('.').to_string();
    if n.is_empty() { "download".into() } else { n }
}

/// "name.ext", else "name 2.ext", "name 3.ext"… (".tar.gz" counts as one extension).
fn unique(dir: &Path, name: &str) -> PathBuf {
    let (stem, ext) = match name.strip_suffix(".tar.gz") {
        Some(s) => (s.to_string(), ".tar.gz".to_string()),
        None => match name.rfind('.') {
            Some(i) if i > 0 => (name[..i].to_string(), name[i..].to_string()),
            _ => (name.to_string(), String::new()),
        },
    };
    let mut p = dir.join(name);
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{stem} {n}{ext}"));
        n += 1;
    }
    p
}

/// The file name in `Content-Disposition: attachment; filename*=UTF-8''<percent-encoded>`.
fn disposition_name(h: Option<&str>) -> Option<String> {
    let enc = h?.split("filename*=UTF-8''").nth(1)?;
    let bytes = enc.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            out.push(u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Downloads a file (or a folder, as .tar.gz) from the server to ~/Downloads, under a name that
/// isn't taken there. Resolves to where it was saved. Progress: "transfer" events with `id`.
#[tauri::command]
pub async fn download(window: Window, server: String, path: String, id: u64) -> Result<String, String> {
    let app = window.app_handle().clone();
    let (port, token) = app.state::<Tunnels>().endpoint(&server).ok_or("Not connected.")?;
    // A Mac always has one; a Linux desktop may not say where it is.
    let dir = app.path().download_dir().or_else(|_| app.path().home_dir().map(|h| h.join("Downloads"))).map_err(|e| e.to_string())?;
    let cancel = app.state::<Transfers>().start(id);
    let res = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let url = format!("http://127.0.0.1:{port}/fs/download?path={}", query(&path));
        let res = ureq::get(&url).set("Authorization", &format!("Bearer {token}")).call().map_err(http_error)?;
        let name = safe_name(&disposition_name(res.header("content-disposition")).unwrap_or_else(|| "download".into()));
        let total = res.header("content-length").and_then(|n| n.parse().ok()).unwrap_or(0);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let dest = unique(&dir, &name);
        // Written beside it under a hidden name, so a half download never looks finished.
        let part = dir.join(format!(".{}.blimp-download", dest.file_name().unwrap().to_string_lossy()));
        let mut meter = Meter { window, id, done: 0, total, last: Instant::now(), cancel };
        let copy = (|| -> io::Result<()> {
            let mut out = File::create(&part)?;
            let mut body = res.into_reader();
            let mut buf = vec![0u8; 256 * 1024];
            loop {
                let n = body.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                out.write_all(&buf[..n])?;
                meter.add(n as u64)?;
            }
            out.sync_all()
        })();
        if let Err(e) = copy {
            let _ = fs::remove_file(&part);
            return Err(e.to_string());
        }
        // A hard link never replaces a file; if another download took the name meanwhile, the
        // next free one.
        let mut dest = dest;
        loop {
            match fs::hard_link(&part, &dest) {
                Ok(()) => break,
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => dest = unique(&dir, &name),
                Err(e) => {
                    let _ = fs::remove_file(&part);
                    return Err(e.to_string());
                }
            }
        }
        let _ = fs::remove_file(&part);
        meter.total = meter.done;
        meter.emit();
        Ok(dest.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?;
    app.state::<Transfers>().end(id);
    res
}

fn size_of(p: &Path) -> u64 {
    match fs::symlink_metadata(p) {
        Ok(m) if m.is_dir() => fs::read_dir(p).map(|d| d.flatten().map(|e| size_of(&e.path())).sum()).unwrap_or(0),
        Ok(m) if m.is_file() => m.len(),
        _ => 0,
    }
}

/// One file or a whole folder (its files and folders; symlinks and anything else are skipped).
fn send(local: &Path, remote: &str, mode: &str, port: u16, token: &str, meter: &mut Meter, count: &mut u32) -> Result<(), String> {
    let meta = fs::symlink_metadata(local).map_err(|e| e.to_string())?;
    let auth = format!("Bearer {token}");
    if meta.is_dir() {
        let r = ureq::post(&format!("http://127.0.0.1:{port}/fs/mkdir"))
            .set("Authorization", &auth)
            .set("Content-Type", "application/json")
            .send_string(&serde_json::json!({ "path": remote }).to_string());
        match r {
            Ok(_) => {}
            // A folder that's already there is merged into (Replace was picked for it).
            Err(ureq::Error::Status(409, _)) if mode == "replace" => {}
            Err(e) => return Err(http_error(e)),
        }
        let mut entries: Vec<_> = fs::read_dir(local).map_err(|e| e.to_string())?.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name().into_string().map_err(|n| format!("{} isn't a name blimp can send (not UTF-8).", n.to_string_lossy()))?;
            send(&e.path(), &format!("{remote}/{name}"), mode, port, token, meter, count)?;
        }
        return Ok(());
    }
    if !meta.is_file() {
        return Ok(());
    }
    let file = File::open(local).map_err(|e| e.to_string())?;
    let url = format!("http://127.0.0.1:{port}/fs/upload?path={}&mode={mode}", query(remote));
    let body = Counted { inner: file, meter };
    ureq::put(&url)
        .set("Authorization", &auth)
        .set("Content-Length", &meta.len().to_string())
        .send(body)
        .map_err(|e| match e {
            ureq::Error::Transport(t) if t.to_string().contains("Cancelled") => "Cancelled.".into(),
            // blimpd answers a refused upload (name taken, too big, disk full) before reading it
            // all, so a big one sees the connection close instead of the answer.
            ureq::Error::Transport(_) => format!("The server stopped taking {} (the name may be taken, the disk full, or it's over 2 GB).", remote.rsplit('/').next().unwrap_or(remote)),
            e => http_error(e),
        })?;
    *count += 1;
    Ok(())
}

/// Uploads a dropped or picked file or folder into `remote_dir` on the server, as `name`.
/// mode "new": nothing there may have that name; "replace": a file of that name is replaced,
/// a folder of that name is merged into. Resolves to the number of files sent.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn upload(window: Window, server: String, local: String, remote_dir: String, name: String, mode: String, id: u64) -> Result<u32, String> {
    let app = window.app_handle().clone();
    let Some(local) = app.state::<Transfers>().may_read(Path::new(&local)) else {
        return Err("Drop it on the window, or pick it with Upload…, to send it.".into());
    };
    if name.is_empty() || name == "." || name == ".." || name.contains('/') {
        return Err("That name can't be used on the server.".into());
    }
    if mode != "new" && mode != "replace" {
        return Err("mode must be new or replace".into());
    }
    let (port, token) = app.state::<Tunnels>().endpoint(&server).ok_or("Not connected.")?;
    let cancel = app.state::<Transfers>().start(id);
    let res = tauri::async_runtime::spawn_blocking(move || -> Result<u32, String> {
        let total = size_of(&local);
        let mut meter = Meter { window, id, done: 0, total, last: Instant::now(), cancel };
        let mut count = 0;
        send(&local, &format!("{}/{name}", remote_dir.trim_end_matches('/')), &mode, port, &token, &mut meter, &mut count)?;
        meter.emit();
        Ok(count)
    })
    .await
    .map_err(|e| e.to_string())?;
    app.state::<Transfers>().end(id);
    res
}

/// Upload…: the Mac's file picker. What's picked may then be uploaded.
#[tauri::command]
pub async fn pick_upload(app: AppHandle) -> Vec<String> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let files = app.dialog().file().blocking_pick_files().unwrap_or_default();
        let paths: Vec<PathBuf> = files.into_iter().filter_map(|f| f.into_path().ok()).collect();
        app.state::<Transfers>().allow(&paths);
        paths
    })
    .await
    .unwrap_or_default();
    picked.into_iter().map(|p| p.to_string_lossy().into_owned()).collect()
}

#[tauri::command]
pub fn cancel_transfer(transfers: State<'_, Transfers>, id: u64) {
    if let Some(f) = transfers.cancel.lock().unwrap().get(&id) {
        f.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(safe_name("../../etc/passwd"), "-..-etc-passwd");
        assert_eq!(safe_name(".."), "download");
        assert_eq!(safe_name(".bashrc"), "bashrc");
        assert_eq!(disposition_name(Some("attachment; filename*=UTF-8''a%20b%C3%A9.tar.gz")).as_deref(), Some("a bé.tar.gz"));
        assert_eq!(query("/h/a b&c=d"), "/h/a%20b%26c%3Dd");
    }

    #[test]
    fn only_what_was_dropped() {
        let d = std::env::temp_dir().join(format!("blimp-allow-{}", std::process::id()));
        fs::create_dir_all(d.join("dropped/inner")).unwrap();
        fs::write(d.join("dropped/inner/a.txt"), "").unwrap();
        fs::write(d.join("secret"), "").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(d.join("secret"), d.join("dropped/link")).unwrap();
        let t = Transfers::default();
        t.allow(&[d.join("dropped")]);
        assert!(t.may_read(&d.join("dropped/inner/a.txt")).is_some());
        // `..` out of a dropped folder, or a link inside it that points out: no.
        assert!(t.may_read(&d.join("dropped/../secret")).is_none());
        assert!(t.may_read(&d.join("dropped/inner/../../secret")).is_none());
        #[cfg(unix)]
        assert!(t.may_read(&d.join("dropped/link")).is_none());
        assert!(t.may_read(&d.join("secret")).is_none());
        fs::remove_dir_all(&d).unwrap();
    }

        #[test]
    fn unique_names() {
        let d = std::env::temp_dir().join(format!("blimp-unique-{}", std::process::id()));
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("a.txt"), "").unwrap();
        fs::write(d.join("p.tar.gz"), "").unwrap();
        assert_eq!(unique(&d, "a.txt"), d.join("a 2.txt"));
        assert_eq!(unique(&d, "p.tar.gz"), d.join("p 2.tar.gz"));
        assert_eq!(unique(&d, "new"), d.join("new"));
        fs::remove_dir_all(&d).unwrap();
    }
}
