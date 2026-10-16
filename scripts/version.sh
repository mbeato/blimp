#!/bin/sh
# Shows or sets the one version that blimpd and the Mac app share.
#   scripts/version.sh          prints the version, or lists all four and exits 1 if they differ
#   scripts/version.sh 0.3.0    sets all four, then refreshes app/src-tauri/Cargo.lock
set -eu
cd "$(dirname "$0")/.."

json_re='^  "version": "[^"]*"'   # the top-level "version" key (two-space indent)
toml_re='^version = "[^"]*"'      # the [package] version, the only line that starts this way

get() { # file regex
  grep "$2" "$1" | head -n 1 | sed 's/.*"\([^"]*\)".*/\1/'
}

set_in() { # file regex replacement
  sed "s/$2/$3/" "$1" > "$1.tmp" && mv "$1.tmp" "$1"
}

if [ $# -eq 0 ]; then
  root=$(get package.json "$json_re")
  app=$(get app/package.json "$json_re")
  cargo=$(get app/src-tauri/Cargo.toml "$toml_re")
  tauri=$(get app/src-tauri/tauri.conf.json "$json_re")
  if [ -n "$root" ] && [ "$root" = "$app" ] && [ "$root" = "$cargo" ] && [ "$root" = "$tauri" ]; then
    echo "$root"
    exit 0
  fi
  echo "The versions differ:" >&2
  echo "  package.json                   $root" >&2
  echo "  app/package.json               $app" >&2
  echo "  app/src-tauri/Cargo.toml       $cargo" >&2
  echo "  app/src-tauri/tauri.conf.json  $tauri" >&2
  echo "Run scripts/version.sh X.Y.Z to set all four." >&2
  exit 1
fi

v=$1
echo "$v" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "usage: scripts/version.sh [X.Y.Z]" >&2; exit 2; }

set_in package.json "$json_re" "  \"version\": \"$v\""
set_in app/package.json "$json_re" "  \"version\": \"$v\""
set_in app/src-tauri/tauri.conf.json "$json_re" "  \"version\": \"$v\""
set_in app/src-tauri/Cargo.toml "$toml_re" "version = \"$v\""

# Only the app's own entry in Cargo.lock changes; no dependency is updated.
(cd app/src-tauri && { cargo update -p blimp --offline 2>/dev/null || cargo update -p blimp; })

sh scripts/version.sh
