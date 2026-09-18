# cdp-drive

Read and drive a **running** Chromium browser from the command line, over the Chrome DevTools Protocol. One file, no dependencies, works with Node 22+ or Bun.

```bash
cdp-drive snapshot                        # what's on the page right now
cdp-drive text "h1"                       # read an element
cdp-drive fill "#email" "you@example.com" # type into it (React-friendly)
cdp-drive click "button[type=submit]"     # click it
cdp-drive wait "#result" --timeout 5000   # wait for what comes back
cdp-drive logs 5                          # console output and errors
```

## Why not Playwright or Puppeteer?

Those launch their own clean browser. That's exactly what you want for tests, and exactly what you don't want when:

- **You're already logged in.** cdp-drive attaches to the browser you opened, with your real session, so there's no login flow to script.
- **You want to look at the same page the tool does.** The window stays visible; you and the tool share it.
- **You want an AI agent to read the DOM, not a screenshot.** `snapshot` returns the interactive elements as JSON, which is far cheaper and more accurate than an image.
- **You want zero install.** One `.mjs` file, no `node_modules`, no browser download.

Use Playwright for test suites, parallel runs and network interception. Use cdp-drive to poke at a live browser.

## Install

```bash
git clone https://github.com/prroha/cdp-drive.git
chmod +x cdp-drive/bin/*
alias cdp-drive="$PWD/cdp-drive/bin/cdp-drive.mjs"
```

Or copy `bin/cdp-drive.mjs` anywhere on your `PATH`. It has no dependencies, so nothing else is needed.

## Start a browser with debugging on

A browser only accepts DevTools connections if it was started with a debugging port.

**Option A: the included launcher** (throwaway profile, no effect on your everyday browser):

```bash
./bin/cdp-launch.sh http://localhost:3000
# CDP_PORT=9333 CDP_HEADLESS=1 CDP_PROFILE=~/.cache/dev-profile ./bin/cdp-launch.sh
```

It finds Chrome, Brave, Chromium or Edge, or you can set `CDP_BROWSER=/path/to/browser`.

**Option B: your own browser, with your own logins.** Quit it completely, then start it with:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222
```

Anything that can reach that port can control the browser, so keep it on `127.0.0.1` and turn it off when you're done.

## Commands

| Command | What it does |
|---|---|
| `tabs` | List open pages with an index, title and URL |
| `snapshot` | URL, title and up to 150 visible interactive elements as JSON |
| `frames` | List iframes, each with a ready-made selector for `--frame` |
| `text <selector>` | innerText of the first match |
| `dom <selector>` | outerHTML of the first match |
| `attr <selector> <name>` | One attribute of the first match |
| `click <selector>` | Click the first match |
| `fill <selector> <value>` | Set a value through the native setter, then fire `input` and `change` |
| `press <selector> <key>` | Focus the match and send a key, e.g. `Enter` |
| `wait <selector>` | Poll until the selector matches, or fail (`--timeout`, default 10000ms) |
| `goto <url>` / `reload` | Navigate |
| `eval "<js>"` | Evaluate an expression in the page and print the JSON result |
| `logs [seconds]` | Collect console messages, exceptions and browser logs, repeats folded with counts |
| `shot [path]` | Save a PNG screenshot (default `cdp-shot.png`) |

## Options

| Option | Meaning |
|---|---|
| `--port <n>` | Debugging port (default `9222`, or `$CDP_PORT`) |
| `--host <host>` | Debugging host (default `127.0.0.1`, or `$CDP_HOST`) |
| `--page <substring>` | Pick the tab whose URL or title contains this (or `$CDP_PAGE`) |
| `--tab <index>` | Pick a tab by its index from `tabs` |
| `--frame <selector>` | Run inside an iframe; repeat to nest, outer to inner |
| `--timeout <ms>` | Timeout for `wait` |
| `--json` | Machine-readable JSON for every command |

Exit codes: `0` ok, `1` error (no match, bad selector, eval threw), `2` timeout, `3` no browser reachable.

## Working inside iframes

```bash
cdp-drive frames
# [{ "index": 0, "id": "checkout", "selector": "iframe#checkout", "reachable": true }]

cdp-drive --frame "iframe#checkout" snapshot
cdp-drive --frame "iframe#checkout" fill "#card-number" "4242424242424242"
```

Frames only open up if they're same-origin. A cross-origin frame reports `reachable: false`.

## Use with an AI coding agent

This is what the tool was built for. Give your agent these three commands and it can see what you see:

```bash
cdp-drive snapshot            # what is on screen
cdp-drive logs 5              # what the page is complaining about
cdp-drive shot /tmp/page.png  # a picture, when a picture helps
```

The agent reads structure instead of guessing from screenshots, and drives the page you already signed into.

## Gotchas worth knowing

- **One Chromium process per profile.** If a browser is already running with the same profile, a new launch just opens a tab in the old process and **silently drops your flags**, including the debugging port. The launcher kills any holder and clears the singleton lock first.
- **Loopback resolution.** Chromium binds the port to whichever loopback family it resolved at launch, so `localhost` may fail while `127.0.0.1` works. cdp-drive tries IPv4 and IPv6.
- **`fill` uses the native value setter**, so React and Vue notice the change. A plain `el.value = …` is ignored by React's controlled inputs.
- **Some buttons need a real click.** `click` calls `el.click()`, which some libraries ignore. Fall back to `eval` with a dispatched `PointerEvent` if that happens.
- **A frozen renderer** aborts the command after 25 seconds with exit code 2 (change with `$CDP_TIMEOUT_MS`).

## Tests

```bash
npm test   # or: bash test/smoke.sh
```

Launches a headless browser on a spare port, drives a fixture page through every command, and checks the results, including iframe targeting, timeouts and error cases.

## License

MIT
