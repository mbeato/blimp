#!/bin/sh
# XcodeGen for the iOS workflow's jobs, from its GitHub release, checked against the SHA-256 it had when
# pinned: seconds, where `brew install xcodegen` took up to 3 minutes on a runner busy booting a simulator.
# Puts it on the job's PATH.
set -eu
v=2.46.0
sum=4d9e34b62172d645eed6457cac13fc222569974098ef4ee9c3368bedf0196806
zip="$RUNNER_TEMP/xcodegen.zip"
curl -fsSL -o "$zip" "https://github.com/yonaskolb/XcodeGen/releases/download/$v/xcodegen.zip"
echo "$sum  $zip" | shasum -a 256 -c -
unzip -q -o "$zip" -d "$RUNNER_TEMP"
echo "$RUNNER_TEMP/xcodegen/bin" >> "$GITHUB_PATH"
"$RUNNER_TEMP/xcodegen/bin/xcodegen" --version
