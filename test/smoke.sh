#!/usr/bin/env bash
# End-to-end smoke test: launches a headless browser on a spare port, drives the
# fixture page through every command, then shuts the browser down.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
PORT="${CDP_TEST_PORT:-9444}"
PROFILE="/tmp/cdp-drive-test-profile"
FIXTURE="file://$HERE/fixture.html"
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

cleanup() {
  pkill -f "user-data-dir=$PROFILE" 2>/dev/null || true
  sleep 1
  rm -rf "$PROFILE" /tmp/cdp-drive-test-shot.png
}
trap cleanup EXIT

echo "launching browser on port $PORT"
CDP_PORT="$PORT" CDP_PROFILE="$PROFILE" CDP_FRESH=1 CDP_HEADLESS=1 \
  "$ROOT/bin/cdp-launch.sh" "$FIXTURE" >/dev/null

echo "running commands"
check "tabs lists the fixture" "fixture" "$("${DRIVE[@]}" tabs)"
check "snapshot finds the button" "greet" "$("${DRIVE[@]}" snapshot)"
check "text reads the heading" "Hello from the fixture" "$("${DRIVE[@]}" text "#heading")"
check "dom returns markup" "<h1" "$("${DRIVE[@]}" dom "#heading")"
check "attr reads an attribute" "Your name" "$("${DRIVE[@]}" attr "#name" placeholder)"
check "fill sets a value" "filled" "$("${DRIVE[@]}" fill "#name" "Prakash")"
check "click runs the handler" "clicked" "$("${DRIVE[@]}" click "#greet")"
check "click had an effect" "Hello, Prakash!" "$("${DRIVE[@]}" text "#output")"
check "wait finds a late element" "found" "$("${DRIVE[@]}" wait "#late" --timeout 3000)"
check "frames lists the iframe" "iframe#inner" "$("${DRIVE[@]}" frames)"
check "frame targeting reads inside" "Inside the iframe" \
  "$("${DRIVE[@]}" --frame "iframe#inner" text "#inner-heading")"
check "eval returns a value" "2" "$("${DRIVE[@]}" eval "1 + 1")"
check "json output is structured" '"selector"' "$("${DRIVE[@]}" --json text "#heading")"
check "shot writes a png" "cdp-drive-test-shot.png" "$("${DRIVE[@]}" shot /tmp/cdp-drive-test-shot.png)"
check "missing selector fails clearly" "no match" "$("${DRIVE[@]}" text "#nope" 2>&1 || true)"
check "wait times out with code 2" "timed out" "$("${DRIVE[@]}" wait "#never" --timeout 500 2>&1 || true)"
check "unreachable port is reported" "no browser reachable" \
  "$("$ROOT/bin/cdp-drive.mjs" --port 9999 tabs 2>&1 || true)"

echo
echo "passed: $pass   failed: $fail"
[[ "$fail" -eq 0 ]]
