#!/usr/bin/env bash
# End-to-end smoke test: launches a headless browser on a spare port, drives the
# fixture page through every command, then shuts the browser down.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
PORT="${CDP_TEST_PORT:-9444}"
PROFILE="/tmp/cdp-drive-test-profile"
FIXTURE="file://$HERE/fixture.html"
SHOT="/tmp/cdp-drive-test-shot.png"
DRIVE=("$ROOT/bin/cdp-drive.mjs" --port "$PORT")

pass=0
fail=0

check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == *"$expected"* ]]; then
    echo "  ok    $name"
    pass=$((pass + 1))
  else
    echo "  FAIL  $name"
    echo "        expected to contain: $expected"
    echo "        got: $actual"
    fail=$((fail + 1))
  fi
}

check_code() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "  ok    $name"
    pass=$((pass + 1))
  else
    echo "  FAIL  $name (expected exit $expected, got $actual)"
    fail=$((fail + 1))
  fi
}

cleanup() {
  pkill -f "user-data-dir=$PROFILE" 2>/dev/null || true
  sleep 1
  rm -rf "$PROFILE" "$SHOT"
}
trap cleanup EXIT

echo "launching browser on port $PORT"
CDP_PROFILE="$PROFILE" CDP_FRESH=1 CDP_HEADLESS=1 "${DRIVE[@]}" launch "$FIXTURE" >/dev/null

echo "reading the page"
check "tabs lists the fixture" "fixture" "$("${DRIVE[@]}" tabs)"
check "tabs ignores a non-matching --page" "fixture" "$("${DRIVE[@]}" --page nothing-matches tabs)"
check "snapshot finds the button" "greet" "$("${DRIVE[@]}" snapshot)"
check "snapshot includes fixed-position elements" "sticky" "$("${DRIVE[@]}" snapshot)"
check "text reads the heading" "Hello from the fixture" "$("${DRIVE[@]}" text "#heading")"
check "dom returns markup" "<h1" "$("${DRIVE[@]}" dom "#heading")"
check "attr reads an attribute" "Your name" "$("${DRIVE[@]}" attr "#name" placeholder)"
check "eval returns a value" "2" "$("${DRIVE[@]}" eval "1 + 1")"
check "json output is structured" '"selector"' "$("${DRIVE[@]}" --json text "#heading")"

echo "driving the page"
check "fill sets a value" "filled" "$("${DRIVE[@]}" fill "#name" "Prakash")"
check "click runs the handler" "clicked" "$("${DRIVE[@]}" click "#greet")"
check "click had an effect" "Hello, Prakash!" "$("${DRIVE[@]}" text "#output")"
check "fill works on a select" "filled" "$("${DRIVE[@]}" fill "#choice" "two")"
check "select holds the new value" '"two"' "$("${DRIVE[@]}" eval "document.querySelector('#choice').value")"
check "press sends a named key correctly" "ArrowDown|ArrowDown|40" \
  "$("${DRIVE[@]}" press "#name" ArrowDown >/dev/null && "${DRIVE[@]}" text "#keyinfo")"
check "press sends Enter" "Enter|Enter|13" \
  "$("${DRIVE[@]}" press "#name" Enter >/dev/null && "${DRIVE[@]}" text "#keyinfo")"
check "wait finds a late element" "found" "$("${DRIVE[@]}" wait "#late" --timeout 3000)"
check "logs capture console output" "greeted" \
  "$("${DRIVE[@]}" logs 2 & sleep 0.4; "${DRIVE[@]}" click "#greet" >/dev/null; wait)"
check "shot writes a png" "$SHOT" "$("${DRIVE[@]}" shot "$SHOT")"

echo "navigating"
check "goto navigates" "navigating" "$("${DRIVE[@]}" goto "about:blank")"
sleep 0.5
check "goto took effect" "about:blank" "$("${DRIVE[@]}" tabs)"
"${DRIVE[@]}" goto "$FIXTURE" >/dev/null
sleep 0.5
check "reload works" "reloaded" "$("${DRIVE[@]}" reload)"
sleep 0.5

echo "iframes"
check "frames lists both iframes" "iframe#inner" "$("${DRIVE[@]}" frames)"
check "frame targeting reads inside" "Inside the iframe" \
  "$("${DRIVE[@]}" --frame "iframe#inner" text "#inner-heading")"
second_selector="$("${DRIVE[@]}" --json frames | python3 -c \
  'import json,sys; print([f["selector"] for f in json.load(sys.stdin) if not f.get("id")][0])')"
check "second iframe selector resolves" "Second frame" \
  "$("${DRIVE[@]}" --frame "$second_selector" text "#second-heading")"

echo "errors and exit codes"
check "missing selector fails clearly" "no match" "$("${DRIVE[@]}" text "#nope" 2>&1)"
"${DRIVE[@]}" text "#nope" >/dev/null 2>&1
check_code "missing selector exits 1" 1 "$?"
check "wait times out" "timed out" "$("${DRIVE[@]}" wait "#never" --timeout 500 2>&1)"
"${DRIVE[@]}" wait "#never" --timeout 500 >/dev/null 2>&1
check_code "timeout exits 2" 2 "$?"
check "bad frame fails fast, not as a timeout" "frame not reachable" \
  "$("${DRIVE[@]}" --frame "iframe#typo" wait "#x" --timeout 20000 2>&1)"
"$ROOT/bin/cdp-drive.mjs" --port 9999 tabs >/dev/null 2>&1
check_code "unreachable browser exits 3" 3 "$?"
check "unreachable port is reported" "no browser reachable" \
  "$("$ROOT/bin/cdp-drive.mjs" --port 9999 tabs 2>&1)"
check "bad option value is rejected" "expects a number" "$("${DRIVE[@]}" --timeout abc wait "#x" 2>&1)"
check "missing option value is rejected" "needs a value" "$("${DRIVE[@]}" tabs --port 2>&1)"
check "unknown key is rejected" "unknown key" "$("${DRIVE[@]}" press "#name" Banana 2>&1)"
check "launch refuses a busy port" "already serving" \
  "$(CDP_PROFILE=/tmp/cdp-drive-other-profile "${DRIVE[@]}" launch 2>&1)"
check "doctor reports a working setup" "Ready" "$("${DRIVE[@]}" doctor)"

echo
echo "passed: $pass   failed: $fail"
[[ "$fail" -eq 0 ]]
