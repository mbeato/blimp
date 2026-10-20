#!/bin/sh
# blimp server setup. Installs blimpd (and zmx, if you don't have it) into ~/.local/bin
# and runs blimpd as a user service. No root needed.
#
#   curl -fsSL https://raw.githubusercontent.com/mbeato/blimp/main/install.sh | sh
#
# BLIMPD_URL overrides where the blimpd binary comes from (any URL curl reads, file:// too).
# Except for file://, SHA256SUMS next to it must list the binary's sum.
set -eu

BIN="$HOME/.local/bin"
ZMX_VERSION=0.8.1
RELEASES=https://github.com/mbeato/blimp/releases/latest/download

say() { printf '%s\n' "$*"; }
die() { printf 'blimp: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Linux ] || die "blimpd runs on a Linux server (this is $(uname -s))"
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 zarch=x86_64 zsum=dfd75720b942466f28870731cc86dbc07afa72fb8f3bd5eeb4ff707e4eecebe8 ;;
  aarch64 | arm64) arch=arm64 zarch=aarch64 zsum=943eb44c812333fd450da12097521afd3339436e86f8c2ac618b905c4c9ece68 ;;
  *) die "unsupported CPU: $(uname -m)" ;;
esac
command -v curl >/dev/null || die "curl is needed"

mkdir -p "$BIN"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# zmx keeps sessions alive. Keep the one you have; otherwise install a pinned, checksummed release.
if command -v zmx >/dev/null 2>&1 || [ -x "$BIN/zmx" ]; then
  say "zmx: already installed"
else
  say "zmx: installing $ZMX_VERSION"
  f="zmx-$ZMX_VERSION-linux-$zarch.tar.gz"
  curl -fsSL -o "$tmp/$f" "https://github.com/neurosnap/zmx/releases/download/v$ZMX_VERSION/$f"
  echo "$zsum  $tmp/$f" | sha256sum -c - >/dev/null || die "zmx download failed its checksum"
  tar xzf "$tmp/$f" -C "$tmp" zmx
  install -m 755 "$tmp/zmx" "$BIN/zmx"
fi

say "blimpd: installing"
url=${BLIMPD_URL:-$RELEASES/blimpd-linux-$arch}
curl -fsSL -o "$tmp/blimpd" "$url"
# A download is checked against SHA256SUMS from the same release folder; no sums, no install.
# A file:// URL is a local build (the install test), which has none.
case "$url" in
  file://*) ;;
  *)
    f=${url##*/}
    curl -fsSL -o "$tmp/SHA256SUMS" "${url%/*}/SHA256SUMS" ||
      die "couldn't download SHA256SUMS from ${url%/*}, so blimpd can't be checked"
    want=$(awk -v f="$f" '$2 == f || $2 == "*" f { print $1; exit }' "$tmp/SHA256SUMS")
    [ -n "$want" ] || die "SHA256SUMS has no line for $f"
    echo "$want  $tmp/blimpd" | sha256sum -c - >/dev/null 2>&1 || die "blimpd download doesn't match SHA256SUMS"
    ;;
esac
install -m 755 "$tmp/blimpd" "$BIN/blimpd"
# Claude Code hooks that record each session's status for blimp (merged into settings.json, backed up first).
"$BIN/blimpd" install-hooks

if command -v claude >/dev/null 2>&1 || [ -x "$BIN/claude" ]; then
  say "claude: found"
else
  say "claude: not found. Install Claude Code before starting sessions:"
  say "  curl -fsSL https://claude.ai/install.sh | bash"
fi

if systemctl --user show-environment >/dev/null 2>&1; then
  units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$units"
  # KillMode=process: sessions blimpd starts must keep running when blimpd restarts.
  # OOMPolicy=continue: sessions run in blimpd's cgroup, so when the kernel kills one of their
  # processes for memory, systemd would otherwise stop blimpd too and drop every app connection.
  cat >"$units/blimpd.service" <<EOF
[Unit]
Description=blimp server

[Service]
ExecStart="$BIN/blimpd" serve
Restart=on-failure
KillMode=process
OOMPolicy=continue

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --quiet blimpd.service
  systemctl --user restart blimpd.service
  say "blimpd: running as a user service"
  # Without linger, systemd stops blimpd, and every session it started, when your last login ends.
  # --no-ask-password: many systems let you turn it on for yourself; never stop to prompt for it.
  me=$(id -un)
  if [ "$(loginctl show-user "$me" -p Linger --value 2>/dev/null)" != yes ]; then
    if loginctl --no-ask-password enable-linger "$me" >/dev/null 2>&1; then
      say "linger: turned on, so sessions keep running after you log out"
    else
      say "warning: linger is off. When your last login to this server ends, systemd stops blimpd"
      say "  and every session it started. Ask an admin to run: sudo loginctl enable-linger $me"
    fi
  fi
else
  # nohup, so blimpd keeps running when this terminal or SSH login closes.
  say "blimpd: no user systemd here, so start it yourself (again after each reboot):"
  say "  nohup \"\$HOME/.local/bin/blimpd\" serve >\"\$HOME/blimpd.log\" 2>&1 &"
  # Then zmx falls back to /tmp/zmx-<uid>, a name another user could make first. blimpd refuses a
  # folder others own or can write, but a private ZMX_DIR avoids the question.
  [ -n "${XDG_RUNTIME_DIR:-}" ] || {
    say "  zmx will keep its sockets in /tmp. On a shared server, first add this to your shell profile:"
    say "  export ZMX_DIR=\"\$HOME/.zmx\""
  }
fi

command -v blimpd >/dev/null 2>&1 || say "note: $BIN isn't on your PATH, so run blimpd as $BIN/blimpd"

say ""
say "Done. In the blimp app, add this server:"
say "  host: the name you use with ssh to reach it (this server calls itself $(uname -n))"
say "  user: $(id -un)"
