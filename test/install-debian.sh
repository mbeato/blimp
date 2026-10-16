#!/bin/sh
# Runs install.sh on a fresh Debian 13 booted with systemd-nspawn, as a normal user.
# Needs sudo, systemd-container and debootstrap. Build first: bun run build
#   sh test/install-debian.sh [root dir]
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
R=${1:-/var/tmp/blimp-test/root}
M=blimptest

if [ ! -d "$R/etc" ]; then
  sudo mkdir -p "$R"
  sudo debootstrap --variant=minbase --include=systemd,systemd-sysv,dbus,libpam-systemd,curl,ca-certificates,zsh \
    trixie "$R" http://deb.debian.org/debian
fi

# A user with zsh (the shell blimpd starts claude through) and linger, so their user manager runs at boot.
# claude is a stub here: the check is the plumbing, not Claude itself.
sudo systemd-nspawn -q -D "$R" sh -c '
  id tester >/dev/null 2>&1 || useradd -m -s /bin/zsh tester
  mkdir -p /var/lib/systemd/linger && touch /var/lib/systemd/linger/tester
  printf "#!/bin/sh\nexec sleep 100000\n" >/usr/local/bin/claude && chmod 755 /usr/local/bin/claude'

sudo systemd-nspawn -q -b -D "$R" -M "$M" --bind-ro="$REPO:/opt/blimp" >/dev/null 2>&1 &
trap 'sudo machinectl poweroff "$M" 2>/dev/null || true' EXIT
for _ in $(seq 60); do
  sudo systemd-run -q -M "$M" --wait -p User=tester true 2>/dev/null && break
  sleep 1
done

as_tester() { sudo machinectl -q shell tester@"$M" /bin/sh -c "$1"; }

as_tester 'BLIMPD_URL=file:///opt/blimp/dist/blimpd-linux-x64 sh /opt/blimp/install.sh'
echo "--- checks"
as_tester '
  set -e
  systemctl --user is-active blimpd
  ~/.local/bin/blimpd sessions
  curl -fsS --unix-socket ~/.blimp/blimpd.sock -X POST -d "{\"dir\":\"$HOME\"}" http://blimpd/sessions; echo
  sleep 2
  ~/.local/bin/blimpd sessions
  systemctl --user restart blimpd; sleep 1
  echo "after blimpd restart:"
  curl -fsS --unix-socket ~/.blimp/blimpd.sock http://blimpd/sessions; echo
  stat -c "%a %n" ~/.blimp ~/.blimp/blimpd.sock'
