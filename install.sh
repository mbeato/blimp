#!/bin/sh
# blimp server setup. Installs blimpd (and zmx, if you don't have it) into ~/.local/bin
# and runs blimpd as a user service. No root needed.
#
#   curl -fsSL https://raw.githubusercontent.com/mbeato/blimp/main/install.sh | sh
#
# BLIMPD_URL overrides where the blimpd binary comes from (any URL curl reads, file:// too).
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
curl -fsSL -o "$tmp/blimpd" "${BLIMPD_URL:-$RELEASES/blimpd-linux-$arch}"
install -m 755 "$tmp/blimpd" "$BIN/blimpd"

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
  cat >"$units/blimpd.service" <<EOF
[Unit]
Description=blimp server

[Service]
ExecStart="$BIN/blimpd" serve
Restart=on-failure
KillMode=process

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --quiet blimpd.service
  systemctl --user restart blimpd.service
  say "blimpd: running as a user service"
else
  say "blimpd: no user systemd here, so start it yourself: $BIN/blimpd serve &"
fi

command -v blimpd >/dev/null 2>&1 || say "note: $BIN isn't on your PATH, so run blimpd as $BIN/blimpd"

say ""
say "Done. In the blimp app, add this server:"
say "  host: $(uname -n)"
say "  user: $(id -un)"
