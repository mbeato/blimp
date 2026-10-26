#!/usr/bin/env bash
# What reached the stand-in sessions (ios/e2e/setup.ts), after the UI test: the app-e2e job runs it with the
# tests its shard ran, and each check runs only when its test did.
#   ios/e2e/check.sh test1PairChatAndAnswer test3Stop ...
tests=" $* "
ran() { [[ "$tests" == *" $1 "* ]]; }
said=()

if ran test1PairChatAndAnswer; then
  grep -F "Thanks, ship it" "$E2E_DIR/chat.in" || { echo "demo-chat got:"; cat -v "$E2E_DIR/chat.in"; exit 1; }
  [ "$(cat "$E2E_DIR/prompt.in")" = 1 ] || { echo "demo-ask got:"; cat -v "$E2E_DIR/prompt.in"; exit 1; }
  said+=("demo-chat got the message; demo-ask got 1 (Yes)")
fi
if ran testNeedsYouAllowFromTheInbox; then
  # Allow from its project's inbox (POST /answer): 1, maybe after the empty paste a new zmx client sends
  [ "$(tr '\033' '~' < "$E2E_DIR/perm.in" | sed 's/~\[20[01]~//g')" = 1 ] || { echo "demo-perm got:"; od -c "$E2E_DIR/perm.in"; exit 1; }
  said+=("demo-perm got 1 (Allow from the inbox)")
fi
if ran test3Stop; then
  # Esc, after the empty paste blimpd sends first on a new zmx client (zmx 0.5 drops a first Esc)
  [ "$(tr '\033' '~' < "$E2E_DIR/stop.in")" = "~[200~~[201~~" ] || {
    echo "demo-busy got:"; od -c "$E2E_DIR/stop.in"
    ps -axo pid,stat,command | grep -F stop.in | grep -v grep
    echo "Stop sent from here:"; bun ios/e2e/interrupt.ts demo-busy; sleep 2; od -c "$E2E_DIR/stop.in"
    zmx history demo-busy | tail -5 | cat -v
    exit 1; }
  said+=("demo-busy got Esc")
fi
if ran test6Reconnect; then
  grep -F "After the restart" "$E2E_DIR/chat.in" || { echo "demo-chat got:"; cat -v "$E2E_DIR/chat.in"; exit 1; }
  said+=("demo-chat got the message after the restart")
fi
if ran test7AnswerQuestions; then
  # What real Claude needs for these answers (the probe, docs/DESIGN.md): 2 picks SQLite and moves on;
  # 1 and 3 tick Lint and E2E; down 3 to the text row, the paste, down to Submit, Enter; 1 on the review.
  [ "$(tr '\033\r' '~R' < "$E2E_DIR/quiz.in")" = "213~[B~[B~[B~[200~smoke~[201~~[BR1" ] || {
    echo "demo-quiz got:"; od -c "$E2E_DIR/quiz.in"; zmx history demo-quiz | tail -20; exit 1; }
  grep -F '"Which checks should run first?":"Lint, E2E, smoke"' "$E2E_DIR/quiz.json" || { echo "demo-quiz answers:"; cat "$E2E_DIR/quiz.json"; exit 1; }
  said+=("demo-quiz got both answers")
fi
if ran test8TrustFolder; then
  # Yes to the folder trust question: the empty paste a new zmx client sends before an ESC, then down and Enter
  [ "$(tr '\033\r' '~R' < "$E2E_DIR/trust.in")" = "~[200~~[201~~[BR" ] || { echo "demo-trust got:"; od -c "$E2E_DIR/trust.in"; zmx history demo-trust | tail -20; exit 1; }
  said+=("demo-trust got Yes")
fi

# The stand-in claude's record of each session the app started: "<zmx name> <pid> [<arguments>]". test4 starts
# one and ends it, test5 resumes the past conversation; no other test starts one. A test run a second time (the
# job's retry) can have started one on its first go too: each go's line is there, and the last is the one checked.
touch "$E2E_DIR/claude.args"
echo "claude started:"; cat "$E2E_DIR/claude.args"
new_lines=$(grep -cF -- "-- Write the changelog]" "$E2E_DIR/claude.args")
resume_lines=$(grep -cF -- "--resume" "$E2E_DIR/claude.args")
other=$(( $(wc -l < "$E2E_DIR/claude.args") - new_lines - resume_lines ))
[ "$other" -eq 0 ] || { echo "$other sessions started that no test starts"; exit 1; }
if ran test4StartAndEnd; then [ "$new_lines" -ge 1 ]; else [ "$new_lines" -eq 0 ]; fi || { echo "$new_lines blank-chat sessions started"; exit 1; }
if ran test5Resume; then [ "$resume_lines" -ge 1 ]; else [ "$resume_lines" -eq 0 ]; fi || { echo "$resume_lines resumed sessions started"; exit 1; }
# with blimp's MCP first (the show tool, and the server browser's: the runner has a Chrome)
mcp="--mcp-config $(dirname "$BLIMPD_SOCKET")/mcp.json"
zmx list > "$E2E_DIR/zmx.list"; cat "$E2E_DIR/zmx.list"
if ran test4StartAndEnd; then
  read -r new _ newargs <<< "$(grep -F -- "-- Write the changelog]" "$E2E_DIR/claude.args" | tail -1)"
  [ -n "$new" ] || { echo "the stand-in saw no ZMX_SESSION"; exit 1; }
  [ "$newargs" = "[$mcp -- Write the changelog]" ] || { echo "the blank chat started claude with $newargs"; exit 1; }
  ! grep -qE "name=$new([[:space:]]|$)" "$E2E_DIR/zmx.list" || { echo "$new was ended but zmx still lists it"; exit 1; }
  said+=("$new started with its first message and ended")
fi
if ran test5Resume; then
  read -r resumed _ resumedargs <<< "$(grep -F -- "--resume" "$E2E_DIR/claude.args" | tail -1)"
  [ -n "$resumed" ] || { echo "the stand-in saw no ZMX_SESSION"; exit 1; }
  [ "$resumedargs" = "[$mcp --resume e2e00000-0000-0000-0000-000000000004 -- Pick it up again]" ] || { echo "the past conversation started claude with $resumedargs"; exit 1; }
  grep -qE "name=$resumed([[:space:]]|$)" "$E2E_DIR/zmx.list" || { echo "the resumed $resumed isn't running"; exit 1; }
  said+=("$resumed resumed the past conversation with a message")
fi
[ "${#said[@]}" -eq 0 ] && said=("nothing to check for these tests")
out="${said[0]}"
for s in "${said[@]:1}"; do out="$out; $s"; done
echo "$out"
