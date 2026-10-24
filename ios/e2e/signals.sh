#!/bin/sh
# Runs in the background during the UI test and does what the test can't from inside the simulator.
# The test writes $E2E_DIR/sig/<name>; this does it, removes the file and writes <name>.done.
#   restart       stop blimpd, wait a few seconds, start it again
#   faceid-enrol  enrol Face ID in the simulator (the job also does it before the test)
#   faceid-match  a matching face
#   push-<name>   push ios/e2e/push-<name>.json to the simulator's blimp, as Apple would deliver it
sig="$E2E_DIR/sig"
mkdir -p "$sig"
here="$(dirname "$0")"
while :; do
  for f in "$sig"/*; do
    name=$(basename "$f")
    case "$name" in *.done|"*") continue ;; esac
    rm -f "$f"
    echo "$(date -u +%T) signal: $name"
    case "$name" in
      restart) "$here/blimpd.sh" restart ;;
      faceid-enrol)
        xcrun simctl spawn "$SIM" notifyutil -s com.apple.BiometricKit.enrollmentChanged 1
        xcrun simctl spawn "$SIM" notifyutil -p com.apple.BiometricKit.enrollmentChanged ;;
      faceid-match) xcrun simctl spawn "$SIM" notifyutil -p com.apple.BiometricKit_Sim.pearl.match ;;
      push-*) xcrun simctl push "$SIM" dev.blimp.phone "$here/$name.json" ;;
      *) echo "unknown signal $name" ;;
    esac
    echo "$(date -u +%T) done: $name"
    touch "$sig/$name.done"
  done
  sleep 0.3
done
