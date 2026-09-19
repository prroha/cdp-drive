# cdp-drive

[![test](https://github.com/prroha/cdp-drive/actions/workflows/test.yml/badge.svg)](https://github.com/prroha/cdp-drive/actions/workflows/test.yml)

**Read and drive a browser you are already running, from the command line.** One command per action, JSON out, no dependencies, no browser download.

```bash
cdp-drive launch http://localhost:3000   # a browser with debugging on
cdp-drive snapshot                       # what's on the page, as JSON
cdp-drive fill "#email" "you@example.com"
cdp-drive click "button[type=submit]"
cdp-drive wait "#dashboard" --timeout 5000
cdp-drive logs 5                         # console output and errors
```

- [What it is](#what-it-is) · [When to use it](#when-to-use-it-and-when-not-to) · [Install](#install)
- [Quick start](#quick-start) · [Your own browser and logins](#driving-your-own-browser-with-your-logins)
- [**For AI coding agents**](#for-ai-coding-agents) · [Commands](#commands) · [Options](#options)
- [Recipes](#recipes) · [Troubleshooting](#troubleshooting) · [Security](#security)

## What it is

Chromium browsers can expose a debugging port. Anything that reaches that port can read the page and act on it. cdp-drive is a small command-line client for that port: it attaches to the browser **you** launched, with your profile, your logins and the tab you are looking at.

Each command does one thing and prints a result you can pipe into `jq` or hand to an AI agent. Under the hood it is one DevTools connection per command: no framework, no `node_modules`.

## When to use it, and when not to

**Reach for cdp-drive when:**

| Situation | Why it fits |
|---|---|
| You are already signed in and don't want to script a login | It uses your real session |
| You want to watch what the tool does | The window stays visible; you share it |
| An AI agent needs to see your app | `snapshot` is structured JSON, far cheaper and more precise than a screenshot |
| You are debugging a page right now | `logs`, `eval` and `dom` answer in one command |
| You are on a slow connection or a small machine | Nothing to install beyond Node; no browser binary download |
| A third-party widget lives in an iframe | `--frame` reaches inside it |

**Use Playwright or Puppeteer instead when** you need a test suite with parallel runs and reports, network interception or request mocking, browsers other than Chromium, or recorded traces and videos. They launch a clean browser and are built for that; cdp-drive deliberately isn't.

They also coexist: Playwright for the suite, cdp-drive for poking at the browser in front of you.

## Install

Needs **Node 22.4+** (or Bun) and any Chromium browser: Chrome, Brave, Chromium or Edge.

```bash
npm install -g github:prroha/cdp-drive
cdp-drive --version
```

<details>
<summary><b>macOS</b></summary>

```bash
brew install node          # if you don't have Node
npm install -g github:prroha/cdp-drive
cdp-drive doctor
```

Chrome, Brave, Chromium and Edge are found automatically in `/Applications`.
</details>

<details>
<summary><b>Linux</b></summary>

```bash
npm install -g github:prroha/cdp-drive
cdp-drive doctor
```

Package, snap and `/opt` installs are found, as is anything on your `PATH`. In a container or on CI the browser sandbox usually can't start, so launch with:

```bash
CDP_EXTRA_FLAGS="--no-sandbox --disable-dev-shm-usage" cdp-drive launch http://localhost:3000
```
</details>

<details>
<summary><b>Windows</b></summary>

```powershell
npm install -g github:prroha/cdp-drive
cdp-drive doctor
```

Chrome, Brave and Edge are found in `Program Files`. `launch` works; releasing a profile another browser already holds is macOS and Linux only, so quit that browser yourself if `launch` says the port is busy.
</details>

<details>
<summary><b>Without installing</b></summary>

```bash
git clone https://github.com/prroha/cdp-drive.git
node cdp-drive/bin/cdp-drive.mjs --help
```
</details>

## Quick start

```bash
cdp-drive launch https://example.com   # starts a browser with debugging on
cdp-drive tabs                         # what is open
cdp-drive snapshot                     # url, title, interactive elements
cdp-drive text "h1"                    # read one element
cdp-drive click "a"                    # act on it
```

Stuck? `cdp-drive doctor` checks Node, the browser and the debugging port, and says what to fix:

```
ok    node: v24.4.0
ok    browser: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
FAIL  debugging port: no browser reachable (http://127.0.0.1:9222: ECONNREFUSED)
Start a browser with: cdp-drive launch <url>
```

## Driving your own browser, with your logins

`launch` starts a **separate** browser with a throwaway profile, so your everyday browser is untouched. Two ways to use your real sessions instead:

**Keep the launched profile.** Sign in once; the profile persists:

```bash
CDP_PROFILE=~/.cache/cdp-profile cdp-drive launch https://app.example.com
```

**Or attach to your everyday browser.** Quit it fully, then start it with a debugging port:

```bash
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222
# Linux
google-chrome --remote-debugging-port=9222
# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

Then run cdp-drive as usual. Anything that reaches that port controls the browser, so keep it on `127.0.0.1` and close it when you're done.

## For AI coding agents

Most people now write code with an agent (Claude Code, Cursor, Copilot, Codex). Those agents can run shell commands but usually cannot *see* the app they just changed. cdp-drive gives them eyes, in a form that costs few tokens: structured JSON instead of screenshots.

**Drop-in instructions live in [`agents/`](agents/):**

| File | Use |
|---|---|
| [`agents/INSTRUCTIONS.md`](agents/INSTRUCTIONS.md) | Paste into your `CLAUDE.md`, `AGENTS.md`, `.cursorrules` or system prompt |
| [`agents/claude-skill/SKILL.md`](agents/claude-skill/SKILL.md) | Copy to `.claude/skills/browser-check/SKILL.md` for Claude Code |

**The short version to paste anywhere:**

```markdown
## Checking the app in a browser
Use `cdp-drive` to see the running app instead of guessing.
- `cdp-drive doctor` — is a browser attached?
- `cdp-drive launch http://localhost:3000` — start one if not
- `cdp-drive snapshot` — url, title and interactive elements as JSON
- `cdp-drive text "<selector>"` / `cdp-drive dom "<selector>"` — read the page
- `cdp-drive click|fill|press "<selector>" [value]` — drive it
- `cdp-drive wait "<selector>" --timeout 5000` — wait for the result
- `cdp-drive logs 5` — console errors after an action
- `cdp-drive --frame "<iframe selector>" <command>` — work inside an iframe
Add `--json` for machine-readable output, `--quiet` to drop confirmations.
Exit codes: 0 ok, 1 error, 2 timeout, 3 no browser.
```

**A loop an agent can run after changing UI code:**

```bash
cdp-drive doctor || cdp-drive launch http://localhost:3000
cdp-drive reload
cdp-drive wait "#app" --timeout 10000
cdp-drive --json snapshot
cdp-drive --json logs 3          # did the change throw anything?
```

**Why it suits agents:** each command is one process with a meaningful exit code, output is JSON on request, `snapshot` costs a few hundred tokens where a screenshot costs thousands, and errors say what to do next ("Run 'cdp-drive tabs' to see what is open").

## Commands

| Command | What it does |
|---|---|
| `launch [url]` | Start a browser with debugging on, in a throwaway profile |
| `doctor` | Check Node, the browser and the debugging port |
| `tabs` | List open pages with an index, title and URL |
| `snapshot` | URL, title and up to 150 visible interactive elements as JSON |
| `frames` | List iframes, each with a selector ready for `--frame` |
| `text <selector>` | innerText of the first match |
| `dom <selector>` | outerHTML of the first match |
| `attr <selector> <name>` | One attribute of the first match |
| `click <selector>` | Click the first match |
| `fill <selector> <value>` | Set a value through the native setter, then fire `input` and `change` |
| `press <selector> <key>` | Focus the match and send a key: `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, arrows, `Home`, `End`, `PageUp`, `PageDown`, `Space`, or any single character |
| `wait <selector>` | Poll until the selector matches (`--timeout`, default 10000ms) |
| `goto <url>` / `reload` | Navigate |
| `eval "<js>"` | Evaluate an expression in the page, print the JSON result |
| `logs [seconds]` | Console messages, exceptions and browser logs, repeats folded with counts |
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
| `--json` | Machine-readable JSON for results and errors |
| `--quiet` | Drop confirmation lines; data and errors still print |
| `-v`, `--version` · `-h`, `--help` | Version, help |

**Exit codes:** `0` ok · `1` error (no match, bad selector, eval threw) · `2` timeout · `3` no browser reachable.

### Environment variables

| Variable | Meaning |
|---|---|
| `CDP_PORT`, `CDP_HOST`, `CDP_PAGE` | Defaults for the matching options |
| `CDP_BROWSER` | Browser executable, when it isn't found automatically |
| `CDP_PROFILE` | Profile directory `launch` uses (keep it to keep logins) |
| `CDP_FRESH` | Wipe that profile before launching |
| `CDP_HEADLESS` | Launch without a window |
| `CDP_EXTRA_FLAGS` | Extra browser flags (containers and CI need `--no-sandbox --disable-dev-shm-usage`) |
| `CDP_TIMEOUT_MS` | Guard against a frozen page (default 25000) |

## Recipes

**Fill a form and confirm the result**

```bash
cdp-drive fill "#email" "you@example.com"
cdp-drive fill "#password" "hunter2"
cdp-drive press "#password" Enter
cdp-drive wait ".welcome" --timeout 8000
cdp-drive text ".welcome"
```

**Work inside a payment or vendor iframe**

```bash
cdp-drive frames
# [{ "index": 0, "id": "checkout", "selector": "iframe#checkout", "reachable": true }]
cdp-drive --frame "iframe#checkout" snapshot
cdp-drive --frame "iframe#checkout" fill "#card-number" "4242424242424242"
```

Frames open up only when they are same-origin; a cross-origin frame reports `reachable: false`.

**See what a page is complaining about**

```bash
cdp-drive logs 5 &
cdp-drive click "#save"
wait
```

**Pull a value out with jq**

```bash
cdp-drive --json snapshot | jq '.interactive[] | select(.tag == "button") | .name'
```

**Target one tab among many**

```bash
cdp-drive tabs
cdp-drive --page checkout snapshot     # by URL or title
cdp-drive --tab 2 snapshot             # by index
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `no browser reachable` | Nothing is listening on the port. `cdp-drive launch <url>`, or pass `--port`. |
| Flags seem ignored, port never opens | A browser already holds that profile, so Chromium opens a tab in the old process. `launch` handles this on macOS and Linux; on Windows quit that browser first. |
| `port … is already serving` | Another browser owns the port. Attach to it, quit it, or use `--port`. |
| Works on `127.0.0.1`, not `localhost` | Chromium binds one loopback family. cdp-drive tries both; force one with `--host`. |
| `frame not reachable` | Wrong selector, or a cross-origin iframe. Check `cdp-drive frames`. |
| `fill` doesn't register in a React app | It should: values are set through the native setter. If a custom editor still ignores it, use `press` or `eval`. |
| A click does nothing | `click` calls `el.click()`; some libraries only listen for real pointer events. Fall back to `eval` with a dispatched `PointerEvent`. |
| Everything times out (exit 2) | The page or renderer is stuck. `node test/ws-probe.mjs <endpoint>` times each DevTools call and shows which step hangs. |
| Browser starts, port never answers, in CI or a container | Set `CDP_EXTRA_FLAGS="--no-sandbox --disable-dev-shm-usage"`. |

## Security

Anything that can reach the debugging port controls that browser: it can read any page, its cookies and its logged-in sessions. So:

- Keep the port on `127.0.0.1`. cdp-drive warns when `--host` is not a loopback address.
- Don't expose it to a network or a shared machine.
- Close the browser when you're done.
- Prefer `launch`'s throwaway profile for anything untrusted; use your real profile only when you need its sessions.

## Tests

```bash
npm test            # unit tests, then the browser suite
npm run test:unit   # pure helpers: milliseconds, no browser
npm run test:smoke  # launches a headless browser and drives a fixture page
```

CI runs the unit tests on Linux and macOS (Node 22.4 and 24) and the browser suite on Linux. GitHub's macOS runners serve the DevTools HTTP endpoint but answer no call on a page, whatever the sandbox flags or attach method, so that suite is run on macOS by hand instead.

## How it works

1. `GET /json` on the debugging port lists the open targets.
2. cdp-drive picks one: the first tab, or `--page` / `--tab`.
3. It opens the browser's own WebSocket and attaches a session to that tab, the way Puppeteer does, because page sockets accept a connection but answer nothing in some environments.
4. Commands become `Runtime.evaluate`, `Input.dispatchKeyEvent` and `Page.*` calls; results print as text or JSON.

Layout: `bin/` the entry point · `lib/cli.mjs` arguments · `lib/cdp.mjs` connection · `lib/page.mjs` evaluation · `lib/expressions.mjs` the JavaScript that runs in the page · `lib/commands.mjs` one handler per command · `lib/launch.mjs` starting a browser.

## License

MIT
