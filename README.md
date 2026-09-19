# cdp-drive

[![test](https://github.com/prroha/cdp-drive/actions/workflows/test.yml/badge.svg)](https://github.com/prroha/cdp-drive/actions/workflows/test.yml)

Read and drive a **running** Chromium browser from the command line, over the Chrome DevTools Protocol. One file, no dependencies, works with Node 22.4+ or Bun.

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

## Get started

```bash
npm install -g github:prroha/cdp-drive

cdp-drive launch https://example.com   # starts a browser with debugging on
cdp-drive snapshot                     # what is on the page
cdp-drive click "a[href='/about']"     # drive it
```

That is the whole setup: no config, no browser download, no dependencies. cdp-drive finds Chrome, Brave, Chromium or Edge on macOS, Linux or Windows, and needs Node 22.4+ or Bun.

You can also clone the repo and run `bin/cdp-drive.mjs` directly.

**Something not working?**

```bash
cdp-drive doctor
# ok    node: v24.4.0
# ok    browser: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
# FAIL  debugging port: no browser reachable (http://127.0.0.1:9222: ECONNREFUSED)
# Start a browser with: cdp-drive launch <url>
```

## Attaching to your own browser, with your logins

`launch` starts a separate browser with a throwaway profile, so your everyday browser is untouched. To drive the browser you actually use, with its sessions:

1. Quit it completely.
2. Start it with a debugging port:
   ```bash
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222
   ```
3. Run cdp-drive as usual.

Keep `launch`'s profile between runs, logins included, with `CDP_PROFILE=~/.cache/my-profile`.

Anything that can reach the debugging port controls that browser, so keep it on `127.0.0.1` and close it when you're done.

## Commands

| Command | What it does |
|---|---|
| `launch [url]` | Start a browser with debugging on, in a throwaway profile |
| `doctor` | Check Node, the browser and the debugging port, and say what is missing |
| `tabs` | List open pages with an index, title and URL |
| `snapshot` | URL, title and up to 150 visible interactive elements as JSON |
| `frames` | List iframes, each with a ready-made selector for `--frame` |
| `text <selector>` | innerText of the first match |
| `dom <selector>` | outerHTML of the first match |
| `attr <selector> <name>` | One attribute of the first match |
| `click <selector>` | Click the first match |
| `fill <selector> <value>` | Set a value through the native setter, then fire `input` and `change` |
| `wait <selector>` | Poll until the selector matches, or fail (`--timeout`, default 10000ms) |
| `press <selector> <key>` | Focus the match and send a key: `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, arrows, `Home`, `End`, `PageUp`, `PageDown`, `Space`, or any single character |
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
| `--json` | Machine-readable JSON for results and errors (`{"error": "...", "code": 1}`) |
| `--quiet` | Suppress confirmation lines such as "clicked #foo"; data and errors still print |
| `-v`, `--version` | Print the version |

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

## Environment variables

| Variable | Meaning |
|---|---|
| `CDP_PORT`, `CDP_HOST`, `CDP_PAGE` | Defaults for the matching options |
| `CDP_BROWSER` | Path to the browser executable, when it isn't found automatically |
| `CDP_PROFILE` | Profile directory `launch` uses (keep it to keep logins) |
| `CDP_FRESH` | Wipe that profile before launching |
| `CDP_HEADLESS` | Launch without a window |
| `CDP_EXTRA_FLAGS` | Extra browser flags; Linux CI and containers usually need `--no-sandbox --disable-dev-shm-usage` |
| `CDP_TIMEOUT_MS` | Guard against a frozen page (default 25000) |

## Gotchas worth knowing

- **One Chromium process per profile.** If a browser is already running with the same profile, a new launch just opens a tab in the old process and **silently drops your flags**, including the debugging port. The launcher kills any holder and clears the singleton lock first.
- **Loopback resolution.** Chromium binds the port to whichever loopback family it resolved at launch, so `localhost` may fail while `127.0.0.1` works. cdp-drive tries IPv4 and IPv6.
- **`fill` uses the native value setter**, so React and Vue notice the change. A plain `el.value = …` is ignored by React's controlled inputs.
- **Some buttons need a real click.** `click` calls `el.click()`, which some libraries ignore. Fall back to `eval` with a dispatched `PointerEvent` if that happens.
- **`snapshot` reports what is visibly rendered**, measured by box size and computed style, so fixed-position bars and floating buttons are included.
- **Screenshots raise the tab first**, because Chromium renders no frames for a background tab.
- **A frozen renderer** aborts the command after 25 seconds with exit code 2 (change with `$CDP_TIMEOUT_MS`).

## Security

Anything that can reach the debugging port controls that browser: it can read pages, cookies and logged-in sessions. Keep the port on `127.0.0.1`, don't expose it to a network, and close the browser when you're done. cdp-drive warns when `--host` is not a loopback address.

## Debugging a stuck connection

`test/ws-probe.mjs` connects to a page target and times each DevTools call, which separates "cannot connect" from "connects but nothing answers":

```bash
node test/ws-probe.mjs http://127.0.0.1:9222
```

## Tests

```bash
npm test          # unit tests, then the browser smoke test
npm run test:unit # pure helpers, milliseconds, no browser
npm run test:smoke
```

CI runs the unit tests on Linux and macOS (Node 22.4 and 24) and the browser suite on Linux. GitHub's macOS runners serve the DevTools HTTP endpoint but answer no DevTools call on a page, so the browser suite is run there by hand instead.

The unit tests cover argument parsing, key mapping, endpoint selection and timeout arithmetic. The smoke test launches a headless browser on a spare port and runs **36 checks** covering every command, iframe targeting (including frames under different parents), React-style fills, select elements, key codes, navigation, the documented exit codes, option validation and the launcher's refusal to start on a busy port.

## License

MIT
