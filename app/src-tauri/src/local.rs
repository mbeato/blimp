//! This Mac as a server: the app and blimpd are on the same Mac, so there is no ssh. The token
//! is read from disk, and a bridge here does what ssh's -L does for a server: a port on
//! 127.0.0.1 whose connections go to blimpd's socket.

use std::fs;
use std::io;
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::tunnel::{install_result, not_set_up, remote_dir, ssh_path, wait_healthy, with_detail, Conn, Tunnels, HEALTH_TIMEOUT, UPDATE_CMD};

/// This Mac's server id, the key the UI saves it under (LOCAL_KEY in app/src/lib/connection.ts).
/// No ssh server can have it: Target refuses a host with whitespace.
pub const ID: &str = "this mac";
/// This Mac in error texts ("blimpd isn't set up on this Mac").
pub const NAME: &str = "this Mac";

/// Set Up's question. It says what the install script does to this Mac, since that is the Mac
/// the person is sitting at.
const INSTALL_QUESTION: &str = "Set up blimp on this Mac? This downloads blimpd from the latest blimp release and keeps it running in the background while you are logged in. It also adds blimp's status hooks to Claude Code's settings.";

/// A listener on 127.0.0.1 whose every connection is joined to blimpd's unix socket. Like the
/// ssh tunnel, any program on this Mac can connect to it, so blimpd's token is what guards it.
pub struct Bridge {
    port: u16,
    stop: Arc<AtomicBool>,
}

impl Bridge {
    pub fn start(socket: PathBuf) -> io::Result<Bridge> {
        // Bound here and kept, so nothing can take the port between picking it and using it.
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        thread::spawn(move || {
            for client in listener.incoming() {
                if stopped.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(client) = client else {
                    // Out of file descriptors, say: wait instead of spinning.
                    thread::sleep(Duration::from_millis(50));
                    continue;
                };
                let socket = socket.clone();
                thread::spawn(move || pipe(client, &socket));
            }
        });
        Ok(Bridge { port, stop })
    }

    pub fn port(&self) -> u16 {
        self.port
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // accept() only returns for a connection: this one lets the thread see the flag and
        // let go of the port. Connections already open run on until their own ends close.
        let _ = TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], self.port)), Duration::from_secs(1));
    }
}

/// Copies both ways until both sides are done. When one side stops sending, the other's write
/// half is shut, so an HTTP answer that ends with the connection, and a WebSocket's close, get
/// through. A socket that can't be opened (blimpd isn't running) just closes the connection.
fn pipe(client: TcpStream, socket: &Path) {
    // Keystrokes are single small writes; don't hold them back.
    let _ = client.set_nodelay(true);
    let Ok(server) = UnixStream::connect(socket) else { return };
    let (Ok(mut from_client), Ok(mut to_server)) = (client.try_clone(), server.try_clone()) else { return };
    let up = thread::spawn(move || {
        let _ = io::copy(&mut from_client, &mut to_server);
        let _ = to_server.shutdown(Shutdown::Write);
    });
    let (mut to_client, mut from_server) = (client, server);
    let _ = io::copy(&mut from_server, &mut to_client);
    let _ = to_client.shutdown(Shutdown::Write);
    let _ = up.join();
}

/// This Mac's bridge and the token last read, once connect_local has run. One at most.
#[derive(Default)]
pub struct Local {
    inner: Mutex<Option<(Bridge, String)>>,
}

impl Local {
    /// Reads the token, starts the bridge if there is none, and waits for blimpd to answer.
    /// Nothing is reused but the bridge: the token is read and /health asked on every call, so
    /// a blimpd that was reinstalled or restarted is found by the UI's own retry.
    pub fn connect(&self, dir: &Path, home: &str) -> Result<Conn, String> {
        let token = fs::read_to_string(dir.join("token"))
            .map(|t| t.trim().to_string())
            .map_err(|e| with_detail(not_set_up(NAME), &e.to_string()))?;
        if token.is_empty() {
            return Err(not_set_up(NAME));
        }
        let port = {
            let mut inner = self.inner.lock().unwrap();
            match inner.as_mut() {
                Some((bridge, old)) => {
                    *old = token.clone();
                    bridge.port()
                }
                None => {
                    let bridge = Bridge::start(dir.join("blimpd.sock")).map_err(|e| format!("Couldn't open a local port: {e}"))?;
                    let port = bridge.port();
                    *inner = Some((bridge, token.clone()));
                    port
                }
            }
        };
        wait_healthy(|| true, port, &token, NAME)?;
        Ok(Conn::new(ID.into(), port, token, home.into()))
    }

    /// The bridge's port and the token, for transfers (as Tunnels::endpoint gives a tunnel's).
    pub fn endpoint(&self) -> Option<(u16, String)> {
        self.inner.lock().unwrap().as_ref().map(|(b, t)| (b.port(), t.clone()))
    }

    pub fn stop(&self) {
        *self.inner.lock().unwrap() = None;
    }
}

/// blimpd's folder on this Mac and the home folder. A debug build's BLIMP_REMOTE_DIR replaces
/// the folder here too, so app/e2e-native reaches its test blimpd through the bridge.
fn dir() -> (PathBuf, String) {
    let home = std::env::var("HOME").unwrap_or_default();
    let dir = remote_dir().unwrap_or_else(|| format!("{home}/.blimp"));
    (PathBuf::from(dir), home)
}

/// What `connect` is for a server: the port and token for the blimpd on this Mac, with id
/// local::ID. The health wait takes up to 10 s; keep it off the UI thread.
#[tauri::command]
pub async fn connect_local(app: AppHandle) -> Result<Conn, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (dir, home) = dir();
        app.state::<Tunnels>().local.connect(&dir, &home)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Runs the latest release's install.sh on this Mac, as tunnel::run_install does on a server
/// over ssh; resolves to the last lines it printed, once blimpd's token file is there (see
/// installed).
pub(crate) fn run_install(doing: &str) -> Result<String, String> {
    // The same PATH ssh gets: an app opened from Finder has launchd's bare one.
    let out = Command::new("/bin/sh")
        .args(["-c", UPDATE_CMD])
        .env("PATH", ssh_path(&std::env::var("PATH").unwrap_or_default()))
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Couldn't run the install script: {e}"))?;
    let failed = format!("{doing} blimpd on {NAME} failed");
    let tail = install_result(out, failed.clone())?;
    installed(tail, &dir().0.join("token"), HEALTH_TIMEOUT, failed)
}

/// Waits for the token file blimpd writes when it first starts, so the connect that follows
/// finds it. No file by then is a failed install, with the script's last lines: `curl … | sh`
/// ends well also when the download fails (sh then runs nothing), and curl's error is in them.
fn installed(tail: String, token: &Path, wait: Duration, failed: String) -> Result<String, String> {
    let deadline = Instant::now() + wait;
    while !token.exists() {
        if Instant::now() >= deadline {
            return Err(with_detail(failed, &tail));
        }
        thread::sleep(Duration::from_millis(200));
    }
    Ok(tail)
}

/// Set Up: installs blimpd on this Mac (This Mac on first open, or Use This Mac in Add server).
/// It changes the Mac the person is sitting at, so it asks first in a native dialog, which
/// script in the page can't click; "Cancelled." if not.
#[tauri::command]
pub async fn install_local(app: AppHandle) -> Result<String, String> {
    // A debug build pointed at a test blimpd (BLIMP_REMOTE_DIR) must not install the real one.
    if remote_dir().is_some() {
        return Err("Not in a test build.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};
        // Set Up goes first. The plugin hands back the second label for every answer that isn't a
        // click on the first button: Esc, a close box, and also a dialog that couldn't show or was
        // aborted (rfd's Cancel). So only a real click on Set Up, or Return, installs.
        let buttons = MessageDialogButtons::OkCancelCustom("Set Up".into(), "Cancel".into());
        // Blocks this thread until answered; the dialog itself runs on the main thread.
        let answer = app
            .dialog()
            .message(INSTALL_QUESTION)
            .title("Set Up This Mac")
            .buttons(buttons)
            .blocking_show_with_result();
        if answer != MessageDialogResult::Custom("Set Up".into()) {
            return Err("Cancelled.".into());
        }
        run_install("Installing")
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
pub(crate) mod testing {
    use std::io::{Read, Write};
    use std::os::unix::net::UnixListener;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::thread;

    /// A new empty folder under the temp folder, with a short name: a unix socket's path must
    /// stay under about 100 bytes.
    pub fn temp_dir() -> PathBuf {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!("bl{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A stand-in for blimpd on `<dir>/blimpd.sock`: every request gets 200 when it carries
    /// `token`, else 401, and the connection closes after the answer.
    pub fn fake_blimpd(dir: &Path, token: &str) {
        let listener = UnixListener::bind(dir.join("blimpd.sock")).unwrap();
        let auth = format!("Authorization: Bearer {token}");
        thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(mut conn) = conn else { return };
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") && conn.read(&mut byte).unwrap_or(0) == 1 {
                    head.push(byte[0]);
                }
                let status = if String::from_utf8_lossy(&head).contains(&auth) { "200 OK" } else { "401 Unauthorized" };
                let _ = write!(conn, "HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::testing::{fake_blimpd, temp_dir};
    use super::*;
    use std::io::{Read, Write};
    use std::os::unix::net::UnixListener;

    #[test]
    fn the_dialog_names_what_gets_installed() {
        assert_eq!(
            INSTALL_QUESTION,
            "Set up blimp on this Mac? This downloads blimpd from the latest blimp release and keeps it running in the background while you are logged in. It also adds blimp's status hooks to Claude Code's settings."
        );
    }

    #[test]
    fn an_install_that_left_no_token_failed() {
        let dir = temp_dir();
        let token = dir.join("token");
        // What a failed download leaves: the script "ended well", and curl's error is its output.
        let tail = "curl: (6) Could not resolve host: github.com".to_string();
        assert_eq!(
            installed(tail.clone(), &token, Duration::ZERO, "Installing blimpd on this Mac failed".into()),
            Err("Installing blimpd on this Mac failed: curl: (6) Could not resolve host: github.com".into())
        );
        std::fs::write(&token, "tok\n").unwrap();
        assert_eq!(installed(tail.clone(), &token, Duration::ZERO, "x".into()), Ok(tail));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bytes_go_both_ways() {
        let dir = temp_dir();
        let sock = dir.join("blimpd.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        let server = thread::spawn(move || {
            let (mut conn, _) = listener.accept().unwrap();
            let mut buf = [0u8; 5];
            conn.read_exact(&mut buf).unwrap();
            conn.write_all(&buf.to_ascii_uppercase()).unwrap();
        });
        let bridge = Bridge::start(sock).unwrap();
        let mut client = TcpStream::connect(("127.0.0.1", bridge.port())).unwrap();
        client.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        client.write_all(b"hello").unwrap();
        client.shutdown(Shutdown::Write).unwrap();
        let mut got = Vec::new();
        client.read_to_end(&mut got).unwrap();
        assert_eq!(got, b"HELLO");
        server.join().unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_socket_closes_the_connection() {
        let dir = temp_dir();
        let bridge = Bridge::start(dir.join("blimpd.sock")).unwrap();
        let mut client = TcpStream::connect(("127.0.0.1", bridge.port())).unwrap();
        // A hang fails the test instead of passing it.
        client.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut got = Vec::new();
        match client.read_to_end(&mut got) {
            Ok(n) => assert_eq!(n, 0),
            Err(e) => assert!(
                matches!(e.kind(), io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted),
                "{e}"
            ),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dropping_the_bridge_frees_the_port() {
        let dir = temp_dir();
        let bridge = Bridge::start(dir.join("blimpd.sock")).unwrap();
        let port = bridge.port();
        drop(bridge);
        let deadline = Instant::now() + Duration::from_secs(2);
        while TcpListener::bind(("127.0.0.1", port)).is_err() {
            assert!(Instant::now() < deadline, "port {port} still taken");
            thread::sleep(Duration::from_millis(50));
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_token_says_not_set_up() {
        let dir = temp_dir();
        let err = Local::default().connect(&dir, "/home/x").err().unwrap();
        assert!(err.starts_with("blimpd isn't set up on this Mac"), "{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn connect_reaches_a_blimpd_that_answers_health() {
        let dir = temp_dir();
        fs::write(dir.join("token"), "tok\n").unwrap();
        fake_blimpd(&dir, "tok");
        let local = Local::default();
        assert!(local.connect(&dir, "/home/x").is_ok());
        let (port, token) = local.endpoint().unwrap();
        assert_eq!(token, "tok");
        // The bridge is kept: a second connect answers with the same port.
        assert!(local.connect(&dir, "/home/x").is_ok());
        assert_eq!(local.endpoint().unwrap().0, port);
        local.stop();
        assert!(local.endpoint().is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
