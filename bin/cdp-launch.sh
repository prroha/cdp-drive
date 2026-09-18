#!/usr/bin/env bash
# cdp-launch — start a Chromium browser with remote debugging on, in a throwaway
# profile, so cdp-drive can attach to it.
#
# Usage:
#   cdp-launch.sh [url]
#   CDP_PORT=9333 cdp-launch.sh http://localhost:3000
#   CDP_BROWSER="/path/to/browser" cdp-launch.sh
#   CDP_PROFILE=~/.cache/my-profile cdp-launch.sh     # keep logins between runs
#   CDP_FRESH=1 cdp-launch.sh                          # wipe the profile first
#   CDP_HEADLESS=1 cdp-launch.sh                       # no window
#
# To drive a browser with your real logins instead, close it fully and start it
# yourself with --remote-debugging-port=9222, then point cdp-drive at that port.
set -euo pipefail

PORT="${CDP_PORT:-9222}"
PROFILE="${CDP_PROFILE:-/tmp/cdp-drive-profile}"
URL="${1:-about:blank}"

find_browser() {
  if [[ -n "${CDP_BROWSER:-}" ]]; then
    echo "$CDP_BROWSER"
    return
  fi
  local candidates=(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  )
  for path in "${candidates[@]}"; do
    [[ -x "$path" ]] && { echo "$path"; return; }
  done
  for name in google-chrome chromium chromium-browser brave-browser microsoft-edge; do
    if command -v "$name" >/dev/null 2>&1; then
      command -v "$name"
      return
    fi
  done
  echo "cdp-launch: no Chromium browser found. Set CDP_BROWSER=/path/to/browser." >&2
  exit 3
}

BROWSER="$(find_browser)"

# Chromium runs ONE process per --user-data-dir. If another instance already
# holds this profile, a new launch just opens a window in it and silently drops
# these flags, including the debugging port. Release the profile first.
free_profile() {
  pkill -f "user-data-dir=$PROFILE" 2>/dev/null || true
  rm -f "$PROFILE/SingletonLock" "$PROFILE/SingletonCookie" "$PROFILE/SingletonSocket" 2>/dev/null || true
}

free_profile
if [[ -n "${CDP_FRESH:-}" ]]; then
  rm -rf "$PROFILE"
fi
mkdir -p "$PROFILE"

flags=(
  --remote-debugging-port="$PORT"
  --user-data-dir="$PROFILE"
  --no-first-run
  --no-default-browser-check
)
if [[ -n "${CDP_HEADLESS:-}" ]]; then
  flags+=(--headless=new --disable-gpu)
fi

echo "cdp-launch: $BROWSER"
echo "cdp-launch: debugging on 127.0.0.1:$PORT, profile $PROFILE"
"$BROWSER" "${flags[@]}" "$URL" >/dev/null 2>&1 &

# Wait for the port to answer so the next command can attach straight away.
for _ in $(seq 1 50); do
  if curl -s "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    echo "cdp-launch: ready — try: cdp-drive --port $PORT tabs"
    exit 0
  fi
  sleep 0.2
done

echo "cdp-launch: browser started but the debugging port never answered." >&2
echo "A browser already running with this profile can swallow the flags." >&2
exit 1
