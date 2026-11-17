#!/bin/sh
# Builds this checkout's blimpd and puts it in place of the one this server runs (~/.local/bin/blimpd),
# then restarts it: server code on your own server in seconds, without a release. Running sessions keep
# running (the service's KillMode is process); the server browser restarts with its tabs.
# The one it replaced stays as ~/.local/bin/blimpd.prev. To go back to it:
#   mv ~/.local/bin/blimpd.prev ~/.local/bin/blimpd && systemctl --user restart blimpd
# On a Mac the service is the launchd agent install.sh set up, and the restart is:
#   launchctl kickstart -k gui/$(id -u)/dev.blimp.blimpd
set -eu
cd "$(dirname "$0")/.."
case "$(uname -s)" in
  Darwin) os=darwin ;;
  *) os=linux ;;
esac
case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "no blimpd build for $(uname -m)" >&2; exit 1 ;;
esac
bun=$(command -v bun || echo "$HOME/.bun/bin/bun")
"$bun" build src/main.ts --compile --target="bun-$os-$arch" --outfile "dist/blimpd-$os-$arch"
bin="$HOME/.local/bin/blimpd"
mkdir -p "$(dirname "$bin")"
[ ! -e "$bin" ] || cp "$bin" "$bin.prev"
# A rename, not a copy over it: the running blimpd's file can't be written.
cp "dist/blimpd-$os-$arch" "$bin.new"
chmod 755 "$bin.new"
mv "$bin.new" "$bin"
if [ "$os" = darwin ]; then
  job="gui/$(id -u)/dev.blimp.blimpd"
  launchctl kickstart -k "$job"
  for _ in $(seq 40); do launchctl print "$job" | grep -q 'state = running' && break; sleep 0.25; done
  echo "blimpd $("$bin" --version): $(launchctl print "$job" | sed -n 's/^[[:space:]]*state = //p' | head -1)"
  exit 0
fi
systemctl --user restart blimpd
for _ in $(seq 40); do systemctl --user is-active --quiet blimpd && break; sleep 0.25; done
echo "blimpd $("$bin" --version): $(systemctl --user is-active blimpd)"
