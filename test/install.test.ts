// Runs install.sh against a local stand-in for the GitHub release, in a throwaway HOME.
// systemctl is stubbed to say there's no user systemd, so nothing here touches a real service.
// uname is stubbed too: the Linux tests and the Mac tests both run on either system.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";

const tmp = mkdtempSync(join(tmpdir(), "blimp-install-"));
const stubs = join(tmp, "stubs");
const blimpd = "#!/bin/sh\necho \"fake blimpd $*\"\n";
const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
const uid = process.getuid!();
const job = `gui/${uid}/dev.blimp.blimpd`;
// A stand-in command: a sh script in `dir`.
const stub = (dir: string, cmd: string, body: string) => writeFileSync(join(dir, cmd), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
const unameStub = (os: string, machine: string) => `case "$1" in -s) echo ${os};; -m) echo ${machine};; *) echo testhost;; esac`;

// What the fake release folder serves; each test sets it.
let release: Record<string, string> = {};
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  mkdirSync(stubs);
  writeFileSync(join(stubs, "systemctl"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(stubs, "systemctl"), 0o755);
  stub(stubs, "uname", unameStub("Linux", "x86_64"));
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const body = release[new URL(req.url).pathname];
      return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
    },
  });
});

afterAll(() => {
  server?.stop(true);
  rmSync(tmp, { recursive: true, force: true });
});

// A fresh HOME with zmx already there (so the script doesn't download it; `zmx` false leaves it out), then
// install.sh. No url is the script's own: the latest release on GitHub.
async function install(url?: string, extraPath?: string, zmx = true, umask?: string) {
  const home = mkdtempSync(join(tmp, "home-"));
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  if (zmx) {
    writeFileSync(join(home, ".local", "bin", "zmx"), "#!/bin/sh\n");
    chmodSync(join(home, ".local", "bin", "zmx"), 0o755);
  }
  const script = join(import.meta.dir, "..", "install.sh");
  const p = Bun.spawn(umask ? ["sh", "-c", `umask ${umask} && exec sh "$1"`, "sh", script] : ["sh", script], {
    env: { HOME: home, PATH: `${extraPath ? extraPath + ":" : ""}${stubs}:/usr/local/bin:/usr/bin:/bin`, ...(url ? { BLIMPD_URL: url } : {}), XDG_CONFIG_HOME: join(home, ".config") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
  const bin = join(home, ".local", "bin", "blimpd");
  return { code, out, err, home, installed: existsSync(bin) ? readFileSync(bin, "utf8") : undefined };
}

// A curl that downloads nothing: it writes down the URL and leaves one line in the file it was asked for.
function stubCurl(name: string) {
  const dir = join(tmp, name);
  mkdirSync(dir);
  stub(dir, "curl", `echo "$4" >>${join(dir, "urls")}\necho "not the file" >"$3"`);
  return { dir, urls: () => readFileSync(join(dir, "urls"), "utf8") };
}

const url = () => `http://127.0.0.1:${server.port}/v1/blimpd-linux-x64`;

describe("install.sh checks the release's SHA256SUMS", () => {
  test("a matching sum installs blimpd", async () => {
    release = {
      "/v1/blimpd-linux-x64": blimpd,
      "/v1/SHA256SUMS": `${sha("other")}  blimpd-linux-arm64\n${sha(blimpd)}  blimpd-linux-x64\n`,
    };
    const r = await install(url());
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.installed).toBe(blimpd);
    expect(r.out).toContain("fake blimpd install-hooks");
    // No user systemd and no XDG_RUNTIME_DIR: zmx would keep its sockets under a guessable /tmp name.
    expect(r.out).toContain("ZMX_DIR");
  });

  test("a wrong sum stops before installing", async () => {
    release = { "/v1/blimpd-linux-x64": blimpd, "/v1/SHA256SUMS": `${sha("tampered")}  blimpd-linux-x64\n` };
    const r = await install(url());
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("blimp: blimpd download doesn't match SHA256SUMS");
    expect(r.installed).toBeUndefined();
  });

  // macOS's sha256sum -c passes a line like this one, so the script compares the sums itself.
  test("a damaged sum stops before installing", async () => {
    for (const sum of ["0000", "<html>"]) {
      release = { "/v1/blimpd-linux-x64": blimpd, "/v1/SHA256SUMS": `${sum}  blimpd-linux-x64\n` };
      const r = await install(url());
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("blimp: blimpd download doesn't match SHA256SUMS");
      expect(r.installed).toBeUndefined();
    }
  });

  test("no SHA256SUMS, or no line for this file, stops too", async () => {
    release = { "/v1/blimpd-linux-x64": blimpd };
    let r = await install(url());
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("blimp: couldn't download SHA256SUMS");
    expect(r.installed).toBeUndefined();

    release = { "/v1/blimpd-linux-x64": blimpd, "/v1/SHA256SUMS": `${sha(blimpd)}  blimpd-linux-arm64\n` };
    r = await install(url());
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("blimp: SHA256SUMS has no line for blimpd-linux-x64");
    expect(r.installed).toBeUndefined();
  });

  test("a file:// BLIMPD_URL (a local build) needs no sums", async () => {
    const file = join(tmp, "blimpd-local");
    writeFileSync(file, blimpd);
    const r = await install(`file://${file}`);
    expect(r.code).toBe(0);
    expect(r.installed).toBe(blimpd);
  });

  test("with no BLIMPD_URL it asks the latest release for this system's binary", async () => {
    const c = stubCurl("curl-linux");
    const r = await install(undefined, c.dir);
    expect(c.urls()).toContain("https://github.com/mbeato/blimp/releases/latest/download/blimpd-linux-x64\n");
    expect(r.err).toContain("blimp: SHA256SUMS has no line for blimpd-linux-x64");
    expect(r.installed).toBeUndefined();
  });
});

describe("install.sh's closing advice", () => {
  test("without user systemd it prints a start command that outlives the terminal", async () => {
    const file = join(tmp, "blimpd-local");
    writeFileSync(file, blimpd);
    const r = await install(`file://${file}`);
    expect(r.code).toBe(0);
    // The same command as the README's "No user systemd" entry. A plain `blimpd serve &` dies on hangup.
    expect(r.out).toContain(`nohup "$HOME/.local/bin/blimpd" serve >"$HOME/blimpd.log" 2>&1 &`);
  });

  test("it says the app wants the name you use with ssh, not only this server's own name", async () => {
    const file = join(tmp, "blimpd-local");
    writeFileSync(file, blimpd);
    const r = await install(`file://${file}`);
    expect(r.out).toContain("the name you use with ssh");
  });
});

// User systemd present (systemctl succeeds), and loginctl says linger is off or on.
describe("install.sh and linger", () => {
  function stubSystemd(name: string, linger: string, enableExit: number) {
    const dir = join(tmp, name);
    mkdirSync(dir);
    const log = join(dir, "calls");
    writeFileSync(join(dir, "systemctl"), "#!/bin/sh\nexit 0\n");
    writeFileSync(
      join(dir, "loginctl"),
      `#!/bin/sh\necho "$*" >>${log}\ncase "$*" in show-user*) echo ${linger};; *enable-linger*) exit ${enableExit};; esac\n`,
    );
    chmodSync(join(dir, "systemctl"), 0o755);
    chmodSync(join(dir, "loginctl"), 0o755);
    return { dir, calls: () => (existsSync(log) ? readFileSync(log, "utf8") : "") };
  }
  const local = () => {
    const file = join(tmp, "blimpd-local");
    writeFileSync(file, blimpd);
    return `file://${file}`;
  };

  test("off: turns it on without ever asking for a password", async () => {
    const s = stubSystemd("linger-ok", "no", 0);
    const r = await install(local(), s.dir);
    expect(r.code).toBe(0);
    expect(s.calls()).toContain("--no-ask-password enable-linger");
    expect(r.out).toContain("linger: turned on");
  });

  test("off and can't turn it on: says what stops, and what to ask an admin", async () => {
    const s = stubSystemd("linger-denied", "no", 1);
    const r = await install(local(), s.dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain("linger is off");
    expect(r.out).toContain("sudo loginctl enable-linger");
  });

  test("already on: leaves it alone", async () => {
    const s = stubSystemd("linger-on", "yes", 1);
    const r = await install(local(), s.dir);
    expect(s.calls()).not.toContain("enable-linger");
    expect(r.out).not.toContain("linger");
  });
});

// uname says macOS on an Apple chip, and launchctl only writes down what it was asked.
describe("install.sh on a Mac", () => {
  // desktop: someone is logged in at the desktop, so the gui/<uid> domain exists.
  // loaded: how many times launchd still lists the old blimpd after bootout.
  // chip: what the hardware says (sysctl hw.optional.arm64); it is 1 on an Apple chip, also under Rosetta.
  function stubMac(name: string, { desktop = true, machine = "arm64", chip = machine === "arm64" ? 1 : 0, loaded = 0, bootstrap = 0 } = {}) {
    const dir = join(tmp, name);
    mkdirSync(dir);
    const log = join(dir, "calls");
    stub(dir, "uname", unameStub("Darwin", machine));
    stub(dir, "sysctl", `echo ${chip}`);
    stub(
      dir,
      "launchctl",
      `echo "launchctl $*" >>${log}
case "$*" in
  "print gui/${uid}") exit ${desktop ? 0 : 113} ;;
  "print ${job}")
    n=$(cat ${dir}/asked 2>/dev/null || echo 0)
    echo $((n + 1)) >${dir}/asked
    [ "$n" -lt ${loaded} ] || exit 113 ;;
  bootstrap*) exit ${bootstrap} ;;
esac`,
    );
    for (const c of ["systemctl", "loginctl"]) stub(dir, c, `echo "${c} $*" >>${log}`);
    return { dir, calls: () => (existsSync(log) ? readFileSync(log, "utf8") : "") };
  }
  const local = () => {
    const file = join(tmp, "blimpd-local");
    writeFileSync(file, blimpd);
    return `file://${file}`;
  };
  const plistOf = (home: string) => join(home, "Library", "LaunchAgents", "dev.blimp.blimpd.plist");

  test("it installs the release's Mac binary, checked against SHA256SUMS", async () => {
    release = { "/v1/blimpd-darwin-arm64": blimpd, "/v1/SHA256SUMS": `${sha(blimpd)}  blimpd-darwin-arm64\n` };
    const r = await install(`http://127.0.0.1:${server.port}/v1/blimpd-darwin-arm64`, stubMac("mac-release").dir);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.installed).toBe(blimpd);

    release = { "/v1/blimpd-darwin-arm64": blimpd, "/v1/SHA256SUMS": `0000  blimpd-darwin-arm64\n` };
    const bad = await install(`http://127.0.0.1:${server.port}/v1/blimpd-darwin-arm64`, stubMac("mac-release-bad").dir);
    expect(bad.err).toContain("blimp: blimpd download doesn't match SHA256SUMS");
    expect(bad.installed).toBeUndefined();
  });

  test("with no BLIMPD_URL it asks the latest release for blimpd-darwin-arm64", async () => {
    const [m, c] = [stubMac("mac-latest"), stubCurl("curl-mac")];
    const r = await install(undefined, `${c.dir}:${m.dir}`);
    expect(c.urls()).toContain("https://github.com/mbeato/blimp/releases/latest/download/blimpd-darwin-arm64\n");
    expect(r.err).toContain("blimp: SHA256SUMS has no line for blimpd-darwin-arm64");
    expect(m.calls()).toBe("");
  });

  // A zmx on the PATH may be Homebrew's, a different major version, so only ~/.local/bin/zmx counts.
  test("it downloads its own pinned zmx even when another zmx is on the PATH, and checks the sum", async () => {
    const [m, c] = [stubMac("mac-zmx"), stubCurl("curl-zmx")];
    stub(c.dir, "zmx", "");
    const r = await install(local(), `${c.dir}:${m.dir}`, false);
    expect(c.urls()).toBe("https://github.com/neurosnap/zmx/releases/download/v0.8.1/zmx-0.8.1-macos-aarch64.tar.gz\n");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("blimp: zmx download failed its checksum");
    expect(existsSync(join(r.home, ".local", "bin", "zmx"))).toBe(false);
    expect(r.installed).toBeUndefined();
  });

  test("it writes the LaunchAgent and loads it into the desktop session", async () => {
    const m = stubMac("mac-agent");
    const r = await install(local(), m.dir);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.installed).toBe(blimpd);
    expect(r.out).toContain("fake blimpd install-hooks");
    const bin = join(r.home, ".local", "bin");
    const plist = readFileSync(plistOf(r.home), "utf8");
    for (const want of [
      "<key>Label</key><string>dev.blimp.blimpd</string>",
      `<key>ProgramArguments</key><array><string>${bin}/blimpd</string><string>serve</string></array>`,
      "<key>RunAtLoad</key><true/>",
      "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
      "<key>AbandonProcessGroup</key><true/>",
      "<key>ProcessType</key><string>Interactive</string>",
      `<key>PATH</key><string>${bin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>`,
      `<key>ZMX_DIR</key><string>${r.home}/.zmx</string>`,
      "<key>LANG</key><string>en_US.UTF-8</string>",
      `<key>StandardOutPath</key><string>${r.home}/Library/Logs/blimpd.log</string>`,
      `<key>StandardErrorPath</key><string>${r.home}/Library/Logs/blimpd.log</string>`,
    ]) expect(plist).toContain(want);
    // On a Mac, macOS itself checks that the file is a property list.
    if (process.platform === "darwin") expect(Bun.spawnSync(["/usr/bin/plutil", "-lint", plistOf(r.home)]).exitCode).toBe(0);
    expect(existsSync(join(r.home, "Library", "Logs"))).toBe(true);
    // The old copy out first, then the new one in. Never systemd, linger or the old `launchctl load`.
    expect(m.calls()).toBe(
      [`print gui/${uid}`, `bootout ${job}`, `print ${job}`, `enable ${job}`, `bootstrap gui/${uid} ${plistOf(r.home)}`].map((c) => `launchctl ${c}\n`).join(""),
    );
    expect(r.out).toContain("blimpd: running as a launchd agent");
    expect(r.out).not.toContain("linger");
    expect(r.out).not.toContain("nohup");
    // The Mac app shows the last lines, so the closing block stays the same as on Linux.
    expect(r.out.endsWith(`\n\nDone. In the blimp app, add this server:\n  host: the name you use with ssh to reach it (this server calls itself testhost)\n  user: ${userInfo().username}\n`)).toBe(true);
  });

  test("it waits for launchd to let go of the old blimpd before loading the new one", async () => {
    const m = stubMac("mac-wait", { loaded: 1 });
    const r = await install(local(), m.dir);
    expect(r.code).toBe(0);
    expect(m.calls()).toContain(`bootout ${job}\nlaunchctl print ${job}\nlaunchctl print ${job}\nlaunchctl enable ${job}\n`);
  });

  test("launchd refusing the agent is an error", async () => {
    const r = await install(local(), stubMac("mac-refused", { bootstrap: 5 }).dir);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("blimp: launchctl couldn't load");
    expect(r.out).not.toContain("Done.");
  });

  test("nobody logged in at the desktop: it writes the agent, says when blimpd starts, and does not fail", async () => {
    const m = stubMac("mac-no-desktop", { desktop: false });
    const r = await install(local(), m.dir);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(existsSync(plistOf(r.home))).toBe(true);
    expect(m.calls()).toBe(`launchctl print gui/${uid}\n`);
    expect(r.out).toContain("starts at the next desktop login");
    expect(r.out).toContain("Done. In the blimp app, add this server:");
  });

  test("an Apple chip under Rosetta, where uname says x86_64, gets the arm64 build", async () => {
    const [m, c] = [stubMac("mac-rosetta", { machine: "x86_64", chip: 1 }), stubCurl("curl-rosetta")];
    await install(undefined, `${c.dir}:${m.dir}`);
    expect(c.urls()).toContain("/releases/latest/download/blimpd-darwin-arm64\n");
  });

  test("the LaunchAgent file is closed to group and others whatever the umask, as launchd wants", async () => {
    const r = await install(local(), stubMac("mac-umask").dir, true, "000");
    expect(r.code).toBe(0);
    expect(statSync(plistOf(r.home)).mode & 0o777).toBe(0o644);
  });

  test("an Intel Mac is told it is not supported, and nothing is installed", async () => {
    const m = stubMac("mac-intel", { machine: "x86_64" });
    const r = await install(local(), m.dir);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("needs a Mac with an Apple chip (this one is x86_64)");
    expect(r.installed).toBeUndefined();
    expect(m.calls()).toBe("");
  });
});

// The script builds in its own checkout, so it runs from a copy with a stand-in bun that writes the file it was
// asked to build.
describe("scripts/install-here.sh", () => {
  async function installHere(os: string, machine: string) {
    const dir = mkdtempSync(join(tmp, "here-"));
    const [repo, bin, home, log] = ["repo", "bin", "home", "calls"].map((x) => join(dir, x));
    for (const x of [join(repo, "scripts"), bin, home]) mkdirSync(x, { recursive: true });
    copyFileSync(join(import.meta.dir, "..", "scripts", "install-here.sh"), join(repo, "scripts", "install-here.sh"));
    stub(bin, "uname", unameStub(os, machine));
    stub(bin, "bun", `echo "bun $*" >>${log}\nfor a; do out=$a; done\nmkdir -p "$(dirname "$out")"\nprintf '#!/bin/sh\\necho 9.9.9\\n' >"$out"`);
    stub(bin, "launchctl", `echo "launchctl $*" >>${log}\ncase "$1" in print) printf '\\tstate = running\\n\\t\\tstate = active\\n\\tjob state = running\\n' ;; esac`);
    stub(bin, "systemctl", `echo "systemctl $*" >>${log}\ncase "$*" in *--quiet*) ;; *is-active*) echo active ;; esac`);
    const p = Bun.spawn(["sh", join(repo, "scripts", "install-here.sh")], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
    return { code, out, err, calls: readFileSync(log, "utf8"), installed: readFileSync(join(home, ".local", "bin", "blimpd"), "utf8") };
  }

  test("on Linux it builds the Linux binary and restarts the systemd service", async () => {
    const r = await installHere("Linux", "x86_64");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.calls).toContain("bun build src/main.ts --compile --target=bun-linux-x64 --outfile dist/blimpd-linux-x64\n");
    expect(r.calls).toContain("systemctl --user restart blimpd\n");
    expect(r.calls).not.toContain("launchctl");
    expect(r.installed).toContain("9.9.9");
    expect(r.out).toBe("blimpd 9.9.9: active\n");
  });

  test("on a Mac it builds the Mac binary and restarts the launchd agent", async () => {
    const r = await installHere("Darwin", "arm64");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.calls).toContain("bun build src/main.ts --compile --target=bun-darwin-arm64 --outfile dist/blimpd-darwin-arm64\n");
    expect(r.calls).toContain(`launchctl kickstart -k ${job}\n`);
    expect(r.calls).not.toContain("systemctl");
    expect(r.installed).toContain("9.9.9");
    expect(r.out).toBe("blimpd 9.9.9: running\n");
  });
});

describe("the builds and the release", () => {
  test("bun run build builds blimpd for both Linux CPUs and for a Mac with an Apple chip", () => {
    const build = (pkg.scripts as Record<string, string>).build;
    for (const t of ["linux-x64", "linux-arm64", "darwin-arm64"]) expect(build).toContain(`bun build src/main.ts --compile --target=bun-${t} --outfile dist/blimpd-${t}`);
  });

  // install.sh on a Mac needs the binary and its SHA256SUMS line in the release, as on Linux.
  test("the release workflow sums, uploads and publishes the Mac binary wherever it does a Linux one", () => {
    const yml = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "release.yml"), "utf8");
    const count = (s: string) => yml.split(s).length - 1;
    expect(count("blimpd-linux-arm64")).toBe(3);
    expect(count("blimpd-darwin-arm64")).toBe(3);
  });
});
