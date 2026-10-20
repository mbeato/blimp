#!/bin/sh
# Starts (or, with `restart`, stops and starts again) this branch's blimpd for the iPhone e2e test, with
# the stand-in login shell and claude, and waits for its socket.
set -e
cd "$(dirname "$0")/../.."
if [ "$1" = restart ]; then
  kill "$(cat "$E2E_DIR/blimpd.pid")"
  while kill -0 "$(cat "$E2E_DIR/blimpd.pid")" 2>/dev/null; do sleep 0.1; done
  echo "--- blimpd stopped $(date -u +%T)" >> "$E2E_DIR/blimpd.log"
  # Down long enough for the app to notice and show it
  sleep "${DOWN:-4}"
fi
# No naming calls: they'd go to the stand-in claude, which counts every launch as a session started.
mkdir -p "$(dirname "$BLIMPD_SOCKET")" && printf '{"names": false}\n' > "$(dirname "$BLIMPD_SOCKET")/config.json"
SHELL="$PWD/ios/e2e/fake-shell" PATH="$PWD/ios/e2e/bin:$PATH" nohup bun src/main.ts serve >> "$E2E_DIR/blimpd.log" 2>&1 &
echo $! > "$E2E_DIR/blimpd.pid"
token="$(dirname "$BLIMPD_SOCKET")/token"
for i in $(seq 100); do
  if [ -S "$BLIMPD_SOCKET" ] && [ -s "$token" ] && curl -fsS -o /dev/null --unix-socket "$BLIMPD_SOCKET" -H "Authorization: Bearer $(cat "$token")" http://b/health 2>/dev/null; then exit 0; fi
  sleep 0.1
done
echo "blimpd didn't start"; exit 1
