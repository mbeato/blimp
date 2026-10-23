#!/bin/sh
# Stops what one e2e run started: its blimpd, page server, forward and signals loop (their pids in
# $E2E_DIR/*.pid), its zmx sessions ($ZMX_DIR) and its blimpd's Chrome. Only that run's: on a Mac that runs
# three shards at once, and is someone's laptop, nothing else is touched. All at once, with -9: the runner's
# own cleanup ends what's left one process at a time (about 40 of them, 41 s). The app-e2e job runs it
# first, for what a cancelled run left, and last.
# Only while the pid is still one of these (a pid from a run long ago can be anything by now), and the file
# goes either way.
for f in "$E2E_DIR"/*.pid; do
  [ -f "$f" ] || continue
  pid=$(cat "$f")
  rm -f "$f"
  case "$(ps -p "$pid" -o command= 2>/dev/null)" in
    *"src/main.ts serve"* | *http.server* | *forward.py* | *signals.sh*) kill -9 "$pid" 2>/dev/null ;;
  esac
done
if [ -d "$ZMX_DIR" ]; then
  names=$(zmx list 2>/dev/null | sed -n 's/^.*name=\([^[:space:]]*\).*$/\1/p')
  [ -z "$names" ] || zmx kill $names --force >/dev/null 2>&1
fi
pkill -9 -f "user-data-dir=$(dirname "$BLIMPD_SOCKET")/" 2>/dev/null
true
