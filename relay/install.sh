#!/bin/bash
# Installs blimp-relay (docs/superpowers/specs/2026-10-26-messages-design.md) for the Mac user you're signed in as:
# the one whose Messages uses the assistant's Apple ID. Run it from the folder it was copied to with the binary
# and relay.json (/Users/Shared/blimp-relay): bash /Users/Shared/blimp-relay/install.sh
set -euo pipefail
src="$(cd "$(dirname "$0")" && pwd)"
app="$HOME/Library/Application Support/blimp-relay"
plist="$HOME/Library/LaunchAgents/dev.blimp.relay.plist"
mkdir -p "$app" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
chmod 700 "$app"
launchctl bootout "gui/$(id -u)/dev.blimp.relay" 2>/dev/null || true
cp "$src/blimp-relay" "$app/blimp-relay"
chmod 755 "$app/blimp-relay"
codesign --force --sign - "$app/blimp-relay"
# relay.json holds blimpd's key: it moves into this user's folder and the shared copy goes. Its owner leaves it
# mode 600 with an ACL that lets this user read and delete it, so no other user can read it.
if [ -f "$src/relay.json" ]; then
  if [ ! -r "$src/relay.json" ]; then
    echo "Can't read $src/relay.json. As the user who copied it there, run this, then run install.sh again:"
    echo "  chmod 600 '$src/relay.json' && chmod +a '$(id -un) allow read,delete' '$src/relay.json'"
    exit 1
  fi
  cp "$src/relay.json" "$app/relay.json"
  rm -f "$src/relay.json" || echo "Couldn't delete $src/relay.json. Delete it by hand: it holds blimpd's key."
fi
[ -f "$app/relay.json" ] || { echo "No relay.json: put one in $src and run this again."; exit 1; }
chmod 600 "$app/relay.json"
cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.blimp.relay</string>
  <key>ProgramArguments</key><array><string>$app/blimp-relay</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/blimp-relay.log</string>
</dict>
</plist>
EOF
echo
echo "Next, let blimp-relay read Messages: in the Full Disk Access list that opens, click +, pick the blimp-relay"
echo "file Finder shows, and make sure its switch is on."
open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
open -R "$app/blimp-relay"
read -r -p "Press Enter once blimp-relay is in the list and switched on. "
launchctl bootstrap "gui/$(id -u)" "$plist"
echo
echo "The relay is running. The Mac now asks whether blimp-relay may control Messages: click OK. Then text this"
echo "account from your phone. Its log: ~/Library/Logs/blimp-relay.log"
