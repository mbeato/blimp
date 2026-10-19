// SSH tunnels from the app to blimpd (see "Connection" in docs/DESIGN.md).
//
// Each server gets one `ssh -T -L 127.0.0.1:<port>:<home>/.blimp/blimpd.sock` child. The UI
// talks HTTP and WebSocket to that local port with the token; this file only starts, reuses
// and stops the tunnels, and tells the UI when one dies so it can reconnect.

use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::process::{Child, ChildStderr, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

// Apps opened from Finder get a bare PATH, so use the system ssh by its full path on macOS.
#[cfg(target_os = "macos")]
const SSH: &str = "/usr/bin/ssh";
#[cfg(not(target_os = "macos"))]
const SSH: &str = "ssh";

// Prints the home folder (for the socket path), then the token.
const INFO_CMD: &str = r#"printf "%s\n" "$HOME"; cat "$HOME/.blimp/token""#;

// Updates blimpd on the server to the latest release (the release's own install.sh; it
// restarts blimpd, and sessions keep running: zmx holds them).
const UPDATE_CMD: &str = "curl -fsSL https://github.com/mbeato/blimp/releases/latest/download/install.sh | sh";

// The tunnel's command on the server, in place of -N: it runs until the app's end of ssh's stdin
// closes. The app holds that pipe, so however the app ends (quit, kill, crash) the kernel closes
// it, cat sees EOF and exits, and ssh ends with its session. With -N, ssh outlived the app.
const TUNNEL_CMD: &str = "cat >/dev/null";

/// Debug builds only: BLIMP_REMOTE_DIR (an absolute path on the server, plain characters
/// only) replaces ~/.blimp there, so app/e2e-native can reach a test blimpd on its own socket
/// without touching the real one. Release builds never read the variable.
fn remote_dir() -> Option<String> {
    #[cfg(debug_assertions)]
    if let Ok(d) = std::env::var("BLIMP_REMOTE_DIR") {
        if d.starts_with('/')
            && d.chars()
                .all(|c| c.is_ascii_alphanumeric() || "._/-".contains(c))
        {
            return Some(d);
        }
    }
    None
}

const HEALTH_TIMEOUT: Duration = Duration::from_secs(10);
const STDERR_WAIT: Duration = Duration::from_secs(1);

/// A server as the user entered it in "Add server".
#[derive(Debug, Clone)]
struct Target {
    host: String,
    user: Option<String>,
    port: Option<u16>,
}

impl Target {
    fn new(host: String, user: Option<String>, port: Option<u16>) -> Result<Target, String> {
        let host = host.trim().to_string();
        // A blank user field means "whatever ssh picks" (~/.ssh/config, else the local name).
        let user = user.map(|u| u.trim().to_string()).filter(|u| !u.is_empty());
        if host.is_empty() {
            return Err("Enter a host to connect to.".into());
        }
        // ssh would read a leading "-" as an option (say -oProxyCommand=...), so refuse it,
        // even though `--` comes before the destination too. Whitespace and control
        // characters are never part of a real name and could split or hide text in a command.
        for s in std::iter::once(&host).chain(user.as_ref()) {
            if s.starts_with('-') || s.chars().any(|c| c.is_whitespace() || c.is_control()) {
                return Err(format!("\"{s}\" isn't a valid host or user name."));
            }
        }
        Ok(Target { host, user, port })
    }

    /// `user@host:port`, leaving out what the user left out (ssh fills those in from
    /// ~/.ssh/config, which the app can't see), so one server entry always has one id.
    fn id(&self) -> String {
        let mut id = self.destination();
        if let Some(p) = self.port {
            id.push_str(&format!(":{p}"));
        }
        id
    }

    fn destination(&self) -> String {
        match &self.user {
            Some(u) => format!("{u}@{}", self.host),
            None => self.host.clone(),
        }
    }

    /// `[-p PORT] -- [USER@]HOST`, the end of both ssh command lines. `--` makes ssh read
    /// the destination as a name, never as an option.
    fn dest_args(&self) -> Vec<String> {
        let mut args = Vec::new();
        if let Some(p) = self.port {
            args.extend(["-p".into(), p.to_string()]);
        }
        args.push("--".into());
        args.push(self.destination());
        args
    }

    fn info_args(&self) -> Vec<String> {
        let mut args = strings(&["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]);
        args.extend(self.dest_args());
        args.push(match remote_dir() {
            Some(d) => format!(r#"printf "%s\n" "$HOME"; cat "{d}/token""#),
            None => INFO_CMD.into(),
        });
        args
    }

    fn tunnel_args(&self, port: u16, home: &str) -> Vec<String> {
        let mut args = strings(&[
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "ExitOnForwardFailure=yes",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=3",
            // With ControlMaster/ControlPersist in ~/.ssh/config, ssh would hand the forward
            // to a shared master and exit at once, leaving a tunnel the app can't stop.
            "-o",
            "ControlMaster=no",
            "-o",
            "ControlPath=none",
            "-L",
        ]);
        let dir = remote_dir().unwrap_or_else(|| format!("{home}/.blimp"));
        args.push(format!("127.0.0.1:{port}:{dir}/blimpd.sock"));
        args.extend(self.dest_args());
        args.push(TUNNEL_CMD.into());
        args
    }
}

impl Target {
    fn update_args(&self) -> Vec<String> {
        let mut args = strings(&["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]);
        args.extend(self.dest_args());
        args.push(UPDATE_CMD.into());
        args
    }

    /// A browser tab's forward: local `port` to `host:remote` on the server (host is
    /// 127.0.0.1 or ::1). Tied to the app's lifetime the same way as the tunnel (TUNNEL_CMD).
    fn forward_args(&self, port: u16, host: &str, remote: u16) -> Vec<String> {
        let mut args = strings(&[
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "ExitOnForwardFailure=yes",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=3",
            "-o",
            "ControlMaster=no",
            "-o",
            "ControlPath=none",
            "-L",
        ]);
        let host = if host == "::1" { "[::1]" } else { "127.0.0.1" };
        args.push(format!("127.0.0.1:{port}:{host}:{remote}"));
        args.extend(self.dest_args());
        args.push(TUNNEL_CMD.into());
        args
    }
}

fn strings(s: &[&str]) -> Vec<String> {
    s.iter().map(|s| s.to_string()).collect()
}

fn ssh() -> Command {
    let mut cmd = Command::new(SSH);
    cmd.env("PATH", ssh_path(&std::env::var("PATH").unwrap_or_default()));
    cmd
}

/// ssh runs ProxyCommand and `Match exec` helpers with our PATH, which is launchd's bare
/// one when the app is opened from Finder. Add Homebrew's folders so helpers such as
/// cloudflared are found the way they are in Terminal.
fn ssh_path(inherited: &str) -> String {
    let mut dirs: Vec<&str> = inherited.split(':').filter(|d| !d.is_empty()).collect();
    for d in ["/opt/homebrew/bin", "/usr/local/bin"] {
        if !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    dirs.join(":")
}

/// Reads the info call's output. Shell startup files on the server can print text of
/// their own first, so the answer is the last two lines.
fn parse_info(out: &str) -> Option<(String, String)> {
    let mut lines = out.lines().map(str::trim).filter(|l| !l.is_empty()).rev();
    let token = lines.next()?;
    let home = lines.next()?;
    if !home.starts_with('/') || !token.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some((home.to_string(), token.to_string()))
}

/// ssh's last stderr line says what went wrong; earlier ones are banners and warnings.
fn last_line(stderr: &str) -> &str {
    stderr
        .lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .unwrap_or("")
}

fn with_detail(msg: String, detail: &str) -> String {
    if detail.is_empty() {
        format!("{msg}.")
    } else {
        format!("{msg}: {detail}")
    }
}

/// What `connect` returns to the UI.
#[derive(Clone, Serialize)]
pub struct Conn {
    id: String,
    port: u16,
    token: String,
    home: String,
}

#[derive(Clone, Serialize)]
struct Closed {
    id: String,
}

struct Forward {
    local: u16,
    child: Child,
    users: u32,
}

struct Tunnel {
    serial: u64,
    child: Child,
    conn: Conn,
    /// For more ssh children to the same server (browser tabs' port forwards).
    target: Target,
}

#[derive(Default)]
pub struct Tunnels {
    inner: Mutex<Inner>,
    // Tells a stale watcher apart from the current tunnel after a reconnect.
    next_serial: AtomicU64,
}

#[derive(Default)]
struct Inner {
    /// The live tunnels, by id.
    map: HashMap<String, Tunnel>,
    /// ssh children still waiting for /health, by serial, with their id. Kept here so
    /// disconnect and close_all can stop them too.
    starting: HashMap<u64, (String, Child)>,
    /// Set once the app is exiting; no tunnel may start after that.
    closing: bool,
    /// Browser tabs' port forwards: (server id, host, port on the server) -> the forward. Two
    /// tabs on one port share it; it closes when the last one does.
    forwards: HashMap<(String, String, u16), Forward>,
}

impl Tunnels {
    /// The local port and token of a live tunnel, for transfers done here (transfer.rs).
    pub fn endpoint(&self, id: &str) -> Option<(u16, String)> {
        let inner = self.inner.lock().unwrap();
        inner.map.get(id).map(|t| (t.conn.port, t.conn.token.clone()))
    }

    /// Stops every ssh, starting ones included. Their watchers then find nothing to report.
    pub fn close_all(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.closing = true;
        for (_, t) in inner.map.drain() {
            stop(t.child);
        }
        for (_, (_, child)) in inner.starting.drain() {
            stop(child);
        }
        for (_, f) in inner.forwards.drain() {
            stop(f.child);
        }
    }

    /// Takes a just-spawned ssh in as starting. Gives it back if the app is exiting.
    fn start(&self, serial: u64, id: &str, child: Child) -> Result<(), Child> {
        let mut inner = self.inner.lock().unwrap();
        if inner.closing {
            return Err(child);
        }
        inner.starting.insert(serial, (id.to_string(), child));
        Ok(())
    }

    /// Whether a starting ssh still runs (and nobody stopped it).
    fn starting_alive(&self, serial: u64) -> bool {
        let mut inner = self.inner.lock().unwrap();
        inner
            .starting
            .get_mut(&serial)
            .is_some_and(|(_, c)| matches!(c.try_wait(), Ok(None)))
    }

    /// Stops the tunnel for `id` and any connect still starting one.
    fn remove(&self, id: &str) {
        let mut inner = self.inner.lock().unwrap();
        // Removed first, so its watcher stays quiet and the UI doesn't reconnect.
        let mut children: Vec<Child> = inner.map.remove(id).map(|t| t.child).into_iter().collect();
        let serials: Vec<u64> = inner
            .starting
            .iter()
            .filter(|(_, (i, _))| i == id)
            .map(|(s, _)| *s)
            .collect();
        for s in serials {
            children.extend(inner.starting.remove(&s).map(|(_, c)| c));
        }
        let fwd: Vec<_> = inner.forwards.keys().filter(|(i, _, _)| i == id).cloned().collect();
        for k in fwd {
            children.extend(inner.forwards.remove(&k).map(|f| f.child));
        }
        drop(inner);
        children.into_iter().for_each(stop);
    }
}

fn stop(mut child: Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn live(map: &mut HashMap<String, Tunnel>, id: &str) -> Option<Conn> {
    let t = map.get_mut(id)?;
    matches!(t.child.try_wait(), Ok(None)).then(|| t.conn.clone())
}

#[tauri::command]
pub async fn connect(
    app: AppHandle,
    host: String,
    user: Option<String>,
    port: Option<u16>,
) -> Result<Conn, String> {
    let target = Target::new(host, user, port)?;
    // ssh and the health wait take seconds; keep them off the UI thread.
    tauri::async_runtime::spawn_blocking(move || open(&app, &target))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn disconnect(tunnels: State<'_, Tunnels>, id: String) {
    tunnels.remove(&id);
}

/// A browser tab on a server's port: forwards a free local port to `host:port` on the server
/// (host is 127.0.0.1 or ::1, nothing else) with one more ssh, or reuses the forward already
/// open. Resolves to the local port once it accepts connections.
#[tauri::command]
pub async fn forward_port(app: AppHandle, server: String, host: String, port: u16) -> Result<u16, String> {
    if host != "127.0.0.1" && host != "::1" {
        return Err("Only the server's own ports (127.0.0.1 or ::1) can be opened.".into());
    }
    if port == 0 {
        return Err("No port.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let tunnels = app.state::<Tunnels>();
        let key = (server.clone(), host.clone(), port);
        let target = {
            let mut inner = tunnels.inner.lock().unwrap();
            if let Some(f) = inner.forwards.get_mut(&key) {
                if matches!(f.child.try_wait(), Ok(None)) {
                    f.users += 1;
                    return Ok(f.local);
                }
            }
            if let Some(f) = inner.forwards.remove(&key) {
                stop(f.child);
            }
            inner.map.get(&server).map(|t| t.target.clone()).ok_or("Not connected.")?
        };
        let local = free_port().map_err(|e| format!("Couldn't find a free local port: {e}"))?;
        let mut child = ssh()
            .args(target.forward_args(local, &host, port))
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Couldn't run ssh: {e}"))?;
        let deadline = Instant::now() + HEALTH_TIMEOUT;
        let addr = SocketAddr::from(([127, 0, 0, 1], local));
        loop {
            if !matches!(child.try_wait(), Ok(None)) {
                return Err(format!("Couldn't open port {port} on {}.", target.host));
            }
            if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok() {
                break;
            }
            if Instant::now() > deadline {
                stop(child);
                return Err(format!("Opening port {port} on {} took too long.", target.host));
            }
            thread::sleep(Duration::from_millis(100));
        }
        let mut inner = tunnels.inner.lock().unwrap();
        if inner.closing {
            drop(inner);
            stop(child);
            return Err("blimp is quitting.".into());
        }
        // Another tab opened the same port meanwhile: use that forward, drop this one.
        if let Some(f) = inner.forwards.get_mut(&key) {
            f.users += 1;
            let theirs = f.local;
            drop(inner);
            stop(child);
            return Ok(theirs);
        }
        inner.forwards.insert(key, Forward { local, child, users: 1 });
        Ok(local)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Update server: runs the latest release's install.sh on the server over ssh. Resolves to the
/// last lines it printed. The app's events socket then sees blimpd restart and reconnects.
#[tauri::command]
pub async fn update_server(app: AppHandle, server: String) -> Result<String, String> {
    // A debug build pointed at a test blimpd (BLIMP_REMOTE_DIR) must not reinstall the real one.
    if remote_dir().is_some() {
        return Err("Not in a test build.".into());
    }
    let target = app.state::<Tunnels>().inner.lock().unwrap().map.get(&server).map(|t| t.target.clone()).ok_or("Not connected.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let out = ssh()
            .args(target.update_args())
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("Couldn't run ssh: {e}"))?;
        let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        let tail: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
        let tail = tail[tail.len().saturating_sub(4)..].join("\n");
        if out.status.success() {
            Ok(tail)
        } else {
            Err(with_detail(format!("Updating blimpd on {} failed", target.host), &tail))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A browser tab on that port closed: the forward goes with the last one.
#[tauri::command]
pub fn unforward_port(tunnels: State<'_, Tunnels>, server: String, host: String, port: u16) {
    let mut inner = tunnels.inner.lock().unwrap();
    let key = (server, host, port);
    let last = inner.forwards.get_mut(&key).is_some_and(|f| {
        f.users = f.users.saturating_sub(1);
        f.users == 0
    });
    if last {
        let f = inner.forwards.remove(&key).unwrap();
        drop(inner);
        stop(f.child);
    }
}

fn open(app: &AppHandle, t: &Target) -> Result<Conn, String> {
    let tunnels = app.state::<Tunnels>();
    let id = t.id();
    if let Some(conn) = live(&mut tunnels.inner.lock().unwrap().map, &id) {
        return Ok(conn);
    }

    let out = ssh()
        .args(t.info_args())
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Couldn't run ssh: {e}"))?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    match out.status.code() {
        Some(0) => {}
        // 255 is ssh's own failure; any other code came from the command on the server.
        Some(255) | None => {
            return Err(with_detail(
                format!("SSH to {} failed", t.host),
                last_line(&stderr),
            ))
        }
        _ => {
            return Err(with_detail(
                format!("blimpd isn't set up on {}", t.host),
                last_line(&stderr),
            ))
        }
    }
    let (home, token) = parse_info(&String::from_utf8_lossy(&out.stdout)).ok_or_else(|| {
        format!(
            "{} didn't send back its home folder and blimp token.",
            t.host
        )
    })?;

    let port = free_port().map_err(|e| format!("Couldn't find a free local port: {e}"))?;
    // ssh's stdin stays in `child` (never written) until the tunnel is stopped: see TUNNEL_CMD.
    let mut child = ssh()
        .args(t.tunnel_args(port, &home))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't run ssh: {e}"))?;
    let stderr = child.stderr.take().unwrap();
    let serial = tunnels.next_serial.fetch_add(1, Ordering::Relaxed);
    if let Err(child) = tunnels.start(serial, &id, child) {
        stop(child);
        return Err("blimp is quitting.".into());
    }
    let ended = Arc::new(AtomicBool::new(false));
    let last = Arc::new(Mutex::new(String::new()));
    let watcher = watch(
        app.clone(),
        id.clone(),
        serial,
        stderr,
        ended.clone(),
        last.clone(),
    );

    let healthy = wait_healthy(|| tunnels.starting_alive(serial), port, &token, &t.host);

    let mut inner = tunnels.inner.lock().unwrap();
    // disconnect or close_all already stopped it: nobody wants this tunnel any more.
    let Some((_, child)) = inner.starting.remove(&serial) else {
        return Err(format!("Connecting to {} was cancelled.", t.host));
    };
    if let Err(msg) = healthy {
        drop(inner);
        stop(child);
        return Err(with_detail(msg, &stderr_after_stop(&watcher, &last)));
    }
    // The watcher sets `ended` under this lock, so it either saw nothing to report yet
    // (and we notice here) or will find this tunnel in the map and report it.
    if ended.load(Ordering::SeqCst) {
        drop(inner);
        stop(child);
        return Err(with_detail(
            format!("SSH tunnel to {} closed right away", t.host),
            &stderr_after_stop(&watcher, &last),
        ));
    }
    // Two connects for the same server can race; keep the one that finished first.
    if let Some(theirs) = live(&mut inner.map, &id) {
        drop(inner);
        stop(child);
        return Ok(theirs);
    }
    let conn = Conn {
        id: id.clone(),
        port,
        token,
        home,
    };
    inner.map.insert(
        id,
        Tunnel {
            serial,
            child,
            conn: conn.clone(),
            target: t.clone(),
        },
    );
    Ok(conn)
}

/// Drains ssh's stderr (so a full pipe never stalls it) and, when ssh exits, tells the UI
/// with `tunnel-closed`, unless the tunnel was already removed on purpose. Keeps the last
/// stderr line in `last`, for error messages.
fn watch(
    app: AppHandle,
    id: String,
    serial: u64,
    stderr: ChildStderr,
    ended: Arc<AtomicBool>,
    last: Arc<Mutex<String>>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        drain(stderr, &last);
        let tunnels = app.state::<Tunnels>();
        let mut inner = tunnels.inner.lock().unwrap();
        ended.store(true, Ordering::SeqCst);
        if inner.map.get(&id).is_some_and(|t| t.serial == serial) {
            let t = inner.map.remove(&id).unwrap();
            drop(inner);
            stop(t.child);
            let _ = app.emit("tunnel-closed", Closed { id });
        }
    })
}

/// Reads stderr to its end, keeping the last non-empty line.
fn drain(stderr: impl Read, last: &Mutex<String>) {
    for line in BufReader::new(stderr).split(b'\n').map_while(Result::ok) {
        let line = String::from_utf8_lossy(&line).trim().to_string();
        if !line.is_empty() {
            *last.lock().unwrap() = line;
        }
    }
}

/// ssh's last stderr line, once ssh has been stopped. Its stderr normally closes right
/// then, but a ProxyCommand helper that inherited it and outlives ssh keeps it open, so
/// wait at most a second for the reader and then take what it has.
fn stderr_after_stop<T>(reader: &JoinHandle<T>, last: &Mutex<String>) -> String {
    let deadline = Instant::now() + STDERR_WAIT;
    while !reader.is_finished() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    last.lock().unwrap().clone()
}

/// Asks the OS for a free port. If something takes it before ssh binds it,
/// ExitOnForwardFailure makes ssh fail instead of running without the tunnel.
fn free_port() -> io::Result<u16> {
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

/// Polls GET /health through the tunnel until blimpd answers, ssh exits, or 10 s pass.
fn wait_healthy(
    mut ssh_alive: impl FnMut() -> bool,
    port: u16,
    token: &str,
    host: &str,
) -> Result<(), String> {
    let deadline = Instant::now() + HEALTH_TIMEOUT;
    loop {
        if !ssh_alive() {
            return Err(format!("SSH tunnel to {host} failed"));
        }
        match health(port, token) {
            Ok(200) => return Ok(()),
            Ok(401) => return Err(format!("blimpd on {host} didn't accept the token")),
            Ok(code) => {
                return Err(format!(
                    "blimpd on {host} answered /health with HTTP {code}"
                ))
            }
            // Not listening yet, or ssh couldn't reach the socket (blimpd not running).
            Err(_) if Instant::now() < deadline => thread::sleep(Duration::from_millis(200)),
            Err(_) => return Err(format!("blimpd on {host} didn't answer within 10 seconds")),
        }
    }
}

/// One plain HTTP request; returns the status code.
fn health(port: u16, token: &str) -> io::Result<u16> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(1))?;
    s.set_read_timeout(Some(Duration::from_secs(1)))?;
    write!(s, "GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n")?;
    let mut head = Vec::new();
    s.take(64).read_to_end(&mut head)?;
    String::from_utf8_lossy(&head)
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| io::Error::other("no HTTP status line"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(host: &str, user: Option<&str>, port: Option<u16>) -> Target {
        Target::new(host.into(), user.map(String::from), port).unwrap()
    }

    #[test]
    fn id_leaves_out_what_was_not_given() {
        assert_eq!(target("claude1", None, None).id(), "claude1");
        assert_eq!(target("claude1", Some("max"), None).id(), "max@claude1");
        assert_eq!(target("claude1", None, Some(2222)).id(), "claude1:2222");
        assert_eq!(
            target("claude1", Some("max"), Some(2222)).id(),
            "max@claude1:2222"
        );
        // A blank user field is the same server as no user.
        assert_eq!(target(" claude1 ", Some("  "), None).id(), "claude1");
    }

    #[test]
    fn refuses_hosts_ssh_would_read_as_options() {
        assert!(Target::new("-oProxyCommand=touch /tmp/x".into(), None, None).is_err());
        assert!(Target::new("claude1".into(), Some("-lroot".into()), None).is_err());
        assert!(Target::new("clau de1".into(), None, None).is_err());
        assert!(Target::new("claude1".into(), Some("m ax".into()), None).is_err());
        assert!(Target::new("claude1\tx".into(), None, None).is_err());
        assert!(Target::new("claude1".into(), Some("max\u{7}".into()), None).is_err());
        assert!(Target::new("claude1\u{1b}[2J".into(), None, None).is_err());
        assert!(Target::new("".into(), None, None).is_err());
        assert!(Target::new("  ".into(), None, None).is_err());
        // Ordinary names, addresses and ~/.ssh/config aliases still work.
        assert!(Target::new("claude1.example.com".into(), Some("max-b".into()), None).is_ok());
        assert!(Target::new("::1".into(), None, Some(22)).is_ok());
        assert!(Target::new("100.64.0.1".into(), None, None).is_ok());
    }

    #[test]
    fn update_args() {
        let a = target("claude1", None, Some(2222)).update_args();
        assert_eq!(a[a.len() - 5..], ["-p", "2222", "--", "claude1", UPDATE_CMD]);
        assert_eq!(a[..4], ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]);
    }

    #[test]
    fn forward_args() {
        let a = target("claude1", Some("max"), Some(2222)).forward_args(5000, "::1", 3000);
        assert!(a.windows(2).any(|w| w == ["-L", "127.0.0.1:5000:[::1]:3000"]));
        assert_eq!(a[a.len() - 5..], ["-p", "2222", "--", "max@claude1", TUNNEL_CMD]);
        // Anything but ::1 is 127.0.0.1: never another host on the server's network.
        let b = target("claude1", None, None).forward_args(5000, "10.0.0.5", 3000);
        assert!(b.contains(&"127.0.0.1:5000:127.0.0.1:3000".to_string()));
    }

    #[test]
    fn info_args() {
        assert_eq!(
            target("claude1", None, None).info_args(),
            [
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                "--",
                "claude1",
                INFO_CMD
            ]
        );
        assert_eq!(
            target("claude1", Some("max"), Some(2222)).info_args(),
            [
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                "-p",
                "2222",
                "--",
                "max@claude1",
                INFO_CMD
            ]
        );
        assert_eq!(
            INFO_CMD,
            r#"printf "%s\n" "$HOME"; cat "$HOME/.blimp/token""#
        );
    }

    #[test]
    fn tunnel_args() {
        let opts = [
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "ExitOnForwardFailure=yes",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=3",
            "-o",
            "ControlMaster=no",
            "-o",
            "ControlPath=none",
            "-L",
            "127.0.0.1:50123:/home/max/.blimp/blimpd.sock",
        ];
        let mut want = opts.to_vec();
        want.extend(["--", "claude1", "cat >/dev/null"]);
        assert_eq!(
            target("claude1", None, None).tunnel_args(50123, "/home/max"),
            want
        );

        let mut want = opts.to_vec();
        want.extend(["--", "max@claude1", "cat >/dev/null"]);
        assert_eq!(
            target("claude1", Some("max"), None).tunnel_args(50123, "/home/max"),
            want
        );

        let mut want = opts.to_vec();
        want.extend(["-p", "2222", "--", "claude1", "cat >/dev/null"]);
        assert_eq!(
            target("claude1", None, Some(2222)).tunnel_args(50123, "/home/max"),
            want
        );
    }

    #[test]
    fn ssh_path_adds_homebrew() {
        assert_eq!(
            ssh_path("/usr/bin:/bin:/usr/sbin:/sbin"),
            "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"
        );
        // A Terminal PATH keeps its order; nothing is added twice.
        assert_eq!(
            ssh_path("/opt/homebrew/bin:/usr/bin:/usr/local/bin"),
            "/opt/homebrew/bin:/usr/bin:/usr/local/bin"
        );
        // An empty entry would mean the current folder.
        assert_eq!(ssh_path(""), "/opt/homebrew/bin:/usr/local/bin");
    }

    // Stand-ins for ssh children: long sleeps we can check on and kill.
    fn sleeper() -> (Child, u32) {
        let child = Command::new("sleep").arg("30").spawn().unwrap();
        let pid = child.id();
        (child, pid)
    }

    fn running(pid: u32) -> bool {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success()
    }

    #[test]
    fn close_all_stops_starting_tunnels_and_refuses_new_ones() {
        let tunnels = Tunnels::default();
        let (child, pid) = sleeper();
        assert!(tunnels.start(1, "claude1", child).is_ok());
        assert!(tunnels.starting_alive(1));

        tunnels.close_all();
        assert!(!running(pid));
        assert!(!tunnels.starting_alive(1));

        // A connect that spawns its ssh after exit began gets it back to stop.
        let (child, pid) = sleeper();
        let child = tunnels.start(2, "claude2", child).unwrap_err();
        stop(child);
        assert!(!running(pid));
    }

    #[test]
    fn disconnect_stops_a_starting_tunnel() {
        let tunnels = Tunnels::default();
        let (mine, mine_pid) = sleeper();
        let (other, other_pid) = sleeper();
        tunnels.start(1, "claude1", mine).unwrap();
        tunnels.start(2, "claude2", other).unwrap();

        tunnels.remove("claude1");
        assert!(!running(mine_pid));
        assert!(!tunnels.starting_alive(1));
        assert!(running(other_pid));

        tunnels.close_all();
        assert!(!running(other_pid));
    }

    #[test]
    fn error_detail_does_not_wait_for_a_helper_holding_stderr() {
        // Stands in for ssh whose ProxyCommand helper inherited its stderr: the helper
        // (a background sleep) keeps the pipe open after the shell, our "ssh", is stopped.
        let mut child = Command::new("sh")
            .args([
                "-c",
                "sleep 30 & echo $!; echo 'ssh: connect to host x: Connection refused' >&2; wait",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut helper = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut helper)
            .unwrap();
        let stderr = child.stderr.take().unwrap();
        let last = Arc::new(Mutex::new(String::new()));
        let reader = {
            let last = last.clone();
            thread::spawn(move || drain(stderr, &last))
        };
        // Let the reader see the line before ssh goes away, as it would in the app.
        let seen = Instant::now() + Duration::from_secs(5);
        while last.lock().unwrap().is_empty() && Instant::now() < seen {
            thread::sleep(Duration::from_millis(10));
        }

        stop(child);
        let started = Instant::now();
        let detail = stderr_after_stop(&reader, &last);
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_eq!(detail, "ssh: connect to host x: Connection refused");
        assert!(!reader.is_finished()); // the helper still holds stderr

        let helper: u32 = helper.trim().parse().unwrap();
        assert!(running(helper));
        Command::new("kill")
            .arg(helper.to_string())
            .status()
            .unwrap();
        reader.join().unwrap();
    }

    #[test]
    fn error_detail_after_ssh_closes_stderr() {
        let mut child = Command::new("sh")
            .args([
                "-c",
                "echo 'Banner' >&2; echo 'Permission denied (publickey).' >&2",
            ])
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stderr = child.stderr.take().unwrap();
        let last = Arc::new(Mutex::new(String::new()));
        let reader = {
            let last = last.clone();
            thread::spawn(move || drain(stderr, &last))
        };
        child.wait().unwrap();
        assert_eq!(
            stderr_after_stop(&reader, &last),
            "Permission denied (publickey)."
        );
    }

    #[test]
    fn parses_home_and_token() {
        let token = "0123456789abcdef".repeat(4);
        let want = Some(("/home/max".to_string(), token.clone()));
        assert_eq!(parse_info(&format!("/home/max\n{token}\n")), want);
        // cat prints no final newline if the file has none.
        assert_eq!(parse_info(&format!("/home/max\n{token}")), want);
        assert_eq!(parse_info(&format!("/home/max\r\n{token}\r\n")), want);
        // Text from shell startup files comes first.
        assert_eq!(
            parse_info(&format!("Welcome to claude1\n\n/home/max\n{token}\n")),
            want
        );
    }

    #[test]
    fn rejects_bad_info() {
        assert_eq!(parse_info(""), None);
        assert_eq!(parse_info("/home/max\n"), None); // token file empty
        assert_eq!(parse_info("/home/max\nnot-a-token\n"), None);
        assert_eq!(parse_info("home\nabcdef\n"), None);
    }

    #[test]
    fn error_detail_is_the_last_stderr_line() {
        let stderr = "Banner text\n\nmax@claude1: Permission denied (publickey).\n";
        assert_eq!(
            with_detail("SSH to claude1 failed".into(), last_line(stderr)),
            "SSH to claude1 failed: max@claude1: Permission denied (publickey)."
        );
        assert_eq!(
            with_detail("SSH to claude1 failed".into(), last_line("")),
            "SSH to claude1 failed."
        );
    }
}
