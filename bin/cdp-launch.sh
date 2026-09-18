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

port_answers() {
  curl -s --max-time 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1
}

# Chromium runs ONE process per --user-data-dir. If another instance already
# holds this profile, a new launch just opens a window in it and silently drops
# these flags, including the debugging port. Release the profile first.
#
# Compare the flag as a whole token: a substring match would kill a browser
# running on /tmp/p2 when this profile is /tmp/p.
free_profile() {
  local pid cmdline token
  while read -r pid cmdline; do
    for token in $cmdline; do
      if [[ "$token" == "--user-data-dir=$PROFILE" ]]; then
        kill "$pid" 2>/dev/null || true
        break
      fi
    done
  done < <(pgrep -af -- "--user-data-dir=" 2>/dev/null || true)
}

BROWSER="$(find_browser)"

free_profile
if [[ -n "${CDP_FRESH:-}" ]]; then
  rm -rf "$PROFILE"
fi
mkdir -p "$PROFILE"

# Give a killed holder a moment to release the port, then refuse to launch if
# something else still owns it: the new browser would fail to bind, drop its
# flags, and cdp-drive would silently attach to the wrong browser.
for _ in 1 2 3 4 5; do
  port_answers || break
  sleep 0.3
done
if port_answers; then
  echo "cdp-launch: port $PORT is already serving a DevTools endpoint." >&2
  echo "Attach to it (cdp-drive --port $PORT tabs), quit that browser, or pick another port." >&2
  exit 1
fi

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

for _ in $(seq 1 50); do
  if port_answers; then
    echo "cdp-launch: ready — try: cdp-drive --port $PORT tabs"
    exit 0
  fi
  sleep 0.2
done

echo "cdp-launch: browser started but the debugging port never answered." >&2
exit 1
