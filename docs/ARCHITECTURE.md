# Architecture

How cdp-drive is put together, why it is shaped this way, and where to change things.

## The idea in one line

**A browser is already a server; every command is one process that opens a DevTools
socket, evaluates a string of JavaScript in a page, prints the answer and exits.**

No driver library, no session daemon, no `node_modules`. A JSON list of targets, a
WebSocket, and `Runtime.evaluate`.

## Shape

```
  argv + env
      |
      v
  cli.parseArgs  ──►  { opts, frames, cmd, args, logSeconds }
      |
      +─────────────────────────────┬──────────────────────────────+
      |                             |                              |
      v                             v                              v
 DIRECT_COMMANDS               runCommand                      parse error
 launch / doctor / tabs             |                          help / version
      |                    cdp.openPages   (GET /json)              |
      v                            |                               v
 launch.launchBrowser      cdp.pickPage  (--tab / --page / first)  print, exit
 (spawn, poll the port)            |
                           cdp.connectToPage
                      (browser socket + Target.attachToTarget)
                                   |
                        COMMANDS[cmd]({ send, socket, root, args, opts })
                                   |
                  page.evaluate(send, expressions.*(root, ...))
                        or Input.* / Page.* sent straight
                                   |
                                   v
                          { data, line, confirmation }
                                   |
                                   v
                          print()   ──json──►  JSON.stringify(data)
                                    ──text──►  line
```

Everything flows one way. `cli.mjs` touches neither the network nor the process;
`expressions.mjs` only builds strings; `commands.mjs` is the only module that knows
what a command means; `bin/cdp-drive.mjs` is the only module that prints or exits.

## The modules

| Module | Lines | Responsibility | Depends on |
|---|---|---|---|
| `bin/cdp-drive.mjs` | 197 | Entry point: help text, dispatch, the hang guard, printing and exit codes | all of `lib/` |
| `lib/cli.mjs` | 164 | Argument parsing, key mapping, endpoint URLs, timeout arithmetic | `nothing` |
| `lib/cdp.mjs` | 130 | Target discovery, tab selection, the WebSocket and the request/response client | `cli`, `errors` |
| `lib/page.mjs` | 130 | Evaluating in the page, reading the result, polling, console capture | `errors` |
| `lib/expressions.mjs` | 120 | The JavaScript that runs inside the page, as strings | `page` (for `quote`, `elementExpression`) |
| `lib/commands.mjs` | 138 | One handler per command, each returning what to print | `cli`, `errors`, `expressions`, `page` |
| `lib/launch.mjs` | 230 | Finding a browser, freeing its profile, starting it, waiting for the port | `cli`, `errors` |
| `lib/errors.mjs` | 14 | `CdpError` and the exit-code table | nothing |

`lib/cli.mjs` is deliberately the only module the unit tests import besides `launch.mjs`:
everything in it is pure, so the argument grammar, the key table and the timeout
arithmetic are tested without a browser.

## The data model

There are only three shapes in the whole tool.

**The parse result**, produced once in `cli.parseArgs`:

```js
{ opts: { port, host, page, tab, timeout, json, quiet },
  frames: ["iframe#outer", "iframe#inner"],   // outer to inner
  cmd: "fill",
  args: ["#card-number", "4242"],
  logSeconds: 0 }
```

or `{ error }`, or `{ ..., help: true }` / `{ ..., version: true }`. `parseArgs` never
exits and never prints; the caller decides.

**The command context**, handed to every handler in `COMMANDS`:

```js
{ send, socket, opts, args, logSeconds, root }
```

`send(method, params)` is a session-scoped CDP call. `root` is not an object — it is a
**string of JavaScript** that evaluates to a `Document` (see below).

**The command result**:

```js
{ data, line, confirmation }
```

`data` is the machine-readable value `--json` prints. `line` is the human line.
`confirmation: true` marks a line that carries no information beyond "it worked", so
`--quiet` can drop it. Handlers never print; `print()` in `bin/cdp-drive.mjs` decides.

## Three ideas that drive most of the code

### 1. Raw CDP over a WebSocket, not a driver library

Puppeteer and Playwright exist to *own* a browser: they download one, launch it clean,
and manage its lifecycle. cdp-drive's whole point is the opposite — attach to the browser
already on the screen, with its profile and its logins — and for that the useful surface
of the protocol is small: `Runtime.evaluate`, `Input.dispatchKeyEvent`, `Page.navigate`,
`Page.reload`, `Page.captureScreenshot`, `Page.bringToFront`, `Log.enable`,
`Target.attachToTarget`. All of it is reachable with `fetch` and the platform `WebSocket`,
both built into Node 22.4+, so the dependency count is zero and there is no install step
beyond Node itself.

`cdp.cdpClient` is the entire protocol layer: an incrementing id, a `Map` of pending
resolvers, and a `message` listener that matches replies by id. A `message.error` becomes
a rejected `CdpError`; anything without an `id` (that is, an event) falls through to
whatever else is listening, which is how `page.collectLogs` works.

The trade is real. There is no retry, no reconnection, no navigation-aware waiting, no
network interception, and no browser other than Chromium. A command that gets no reply
simply never settles — which is why the hang guard below exists.

### 2. Attach through the *browser* endpoint, not the page socket

Each page target advertises its own `webSocketDebuggerUrl`, and connecting to it directly
is the obvious route. `cdp.connectToPage` does not take it. It fetches
`/json/version`, opens the **browser's** socket, and calls
`Target.attachToTarget({ targetId, flatten: true })` to get a `sessionId`; every later
call carries that id.

The comment in the source names the reason: page sockets accept the connection and then
answer nothing in some environments — the CI note in `.github/workflows/test.yml` records
one such environment, where GitHub's macOS runners serve the HTTP endpoint but answer no
call on a page target. A browser session is also the only place browser-level calls could
be made, so nothing is lost by always taking it.

`Runtime.enable` and `Page.enable` follow, both with `.catch(() => {})`. A browser that
refuses to enable a domain should not stop a command that may not need it.

### 3. The frame chain is a string, not a target

`--frame` does not attach to a second CDP target. `page.documentRoot` folds the frame
selectors into an expression:

```js
document.querySelector("iframe#outer")?.contentDocument.querySelector("iframe#inner")?.contentDocument
```

wrapped in an IIFE that throws `frame not reachable: <chain>` when the result is falsy.
Every other expression in `expressions.mjs` takes that string as its `root` and does
`${root}.querySelector(...)`, so one mechanism covers arbitrary nesting and the whole
frame chain costs nothing until an expression is actually evaluated.

The price is stated plainly in the README and is worth repeating: `contentDocument` is
same-origin only. A cross-origin iframe reports `reachable: false` from `frames` and
cannot be driven at all. Reaching into one would mean attaching a separate session per
frame target and tracking execution contexts — a different tool.

## The async/eval boundary

Everything the page does crosses one function, `page.evaluate`:

```js
send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
```

Three decisions are packed into those parameters and the lines after them.

- **`returnByValue: true`** — results come back as JSON-serialisable values rather than
  remote object handles. There is no object graph to release and no second round trip,
  which is what makes one process per command affordable. It also means a value that does
  not survive serialisation (a DOM node, a function) cannot be returned; commands return
  text, markup, attributes or plain records instead, and the handlers that act on an
  element (`click`, `fill`, `press`) `return true` rather than the element.
- **`awaitPromise: true`** — `eval "fetch('/api').then(r => r.json())"` resolves before the
  command prints, so the CLI's synchronous-looking shape survives asynchronous pages.
- **`exceptionDetails`** — a page exception is *not* a protocol error, so it arrives in a
  successful reply. `evaluate` checks for it explicitly and rethrows the exception's
  `description` (falling back to `text`) as a `CdpError`. That is why a thrown
  `no match: #nope` from `elementExpression` reaches the user as `cdp-drive: no match: #nope`
  with exit 1: the message is invented inside the page and carried back out through this
  one branch.

Two helpers build the expressions that rely on this. `quote` is `JSON.stringify(String(v))`,
used for every selector and value that is interpolated into page JavaScript, so a quote or
a backslash in a selector cannot break out of the literal. `elementExpression` wraps a body
in a lookup that throws `no match: <selector>` when the selector finds nothing — every
element command shares that one error string.

`waitForSelector` is the one place polling happens: `!!root.querySelector(...)` every 150ms
until the deadline. Because the frame chain is part of the expression, a typo in `--frame`
would otherwise fail identically on every poll and only surface as a timeout. The
`PERMANENT_ERROR` regex — `frame not reachable|not a valid selector|SyntaxError` — rethrows
those immediately, so a bad selector or a bad frame fails in milliseconds with exit 1
rather than after the full `--timeout` with exit 2. The smoke test asserts exactly that.

## How `--frame "iframe#checkout" fill "#card" "4242"` runs end to end

```
argv
  └─ cli.parseArgs
       ├─ --frame iframe#checkout      frames = ["iframe#checkout"]
       └─ positional                   cmd = "fill", args = ["#card", "4242"]
  └─ isLoopbackHost(opts.host)         warn on stderr if not loopback
  └─ setTimeout(hangMsFor(...))        25000ms here; unref'd
  └─ runCommand
       ├─ cdp.openPages                GET /json, keep type === "page" with a socket url
       ├─ cdp.pickPage                 no --tab, no --page → pages[0]
       ├─ cdp.connectToPage
       │    ├─ GET /json/version       the browser's own socket url
       │    ├─ new WebSocket(...)      resolve on "open", reject on "error"
       │    ├─ Target.attachToTarget   { targetId, flatten: true } → sessionId
       │    └─ Runtime.enable, Page.enable   both best-effort
       ├─ page.documentRoot(frames)    a string: document.querySelector("iframe#checkout")?.contentDocument
       └─ COMMANDS.fill
            ├─ expressions.fillExpression(root, "#card", "4242")
            └─ page.evaluate
                 ├─ Runtime.evaluate   returnByValue, awaitPromise
                 └─ exceptionDetails?  → throw CdpError(description)
  └─ socket.close()                    in a finally, so an error still closes it
  └─ print({ data: { filled, value }, line: "filled #card", confirmation: true })
  └─ process.exitCode = 0
```

`fillExpression` itself is the most deliberate piece of JavaScript in the tool. Assigning
`el.value = "..."` in a React or Vue app updates the DOM but does not notify the framework,
because the framework has replaced the `value` property on the element instance with its
own accessor. So the expression walks to the right prototype (`HTMLInputElement`,
`HTMLTextAreaElement` or `HTMLSelectElement`, chosen via the element's *own* `defaultView`
so it works inside an iframe), pulls the native `value` setter off it with
`Object.getOwnPropertyDescriptor`, and calls that setter against the element. Then it fires
`input` and `change` with `bubbles: true`. A `contenteditable` element takes a different
path — `textContent` plus an `input` event — and anything else throws a message naming the
tag rather than silently doing nothing.

## Never hang

A command that reaches a frozen renderer would wait forever: `cdpClient` only settles a
promise when a reply with a matching id arrives, and a stalled page sends none. So
`bin/cdp-drive.mjs` arms one `setTimeout` before doing anything, and `cli.hangMsFor`
decides its length:

| Command | Guard |
|---|---|
| `launch` | `max(base, 45000)` — a cold browser start |
| `wait` | `max(base, --timeout + 5000)` |
| `logs` | `max(base, seconds × 1000 + 5000)` |
| everything else | `base`, default 25000, or `$CDP_TIMEOUT_MS` |

The margin exists so a command that is *meant* to take time is never cut short by the
guard; its own timeout must fire first, and report exit 2 with a message about the
selector rather than a generic freeze. The timer is `unref`'d so it does not itself keep
the process alive.

The last line of the entry point sets `process.exitCode = 0` rather than calling
`process.exit(0)`, because a large result still being written to a pipe would be discarded
by an immediate exit. The smoke test pushes three megabytes through a pipe to check it.

## Errors

Every failure becomes a message and an exit code, never a stack trace.

| Exit | Meaning | Raised by |
|---|---|---|
| 0 | ok | — |
| 1 | `EXIT.error` — no match, bad selector, unknown command, bad flag value, eval threw | `page.evaluate`, `commands.requireArg`, `cli` validation, `cdp.pickPage` |
| 2 | `EXIT.timeout` — `wait` expired, or the hang guard fired | `COMMANDS.wait`, the hang guard |
| 3 | `EXIT.unreachable` — nothing answering, no page targets, no browser found | `cdp.fetchTargets`, `cdp.openSocket`, `cdp.pickPage`, `launch.findBrowser`, `launch.launchBrowser` |

`CdpError` carries the code; `report()` in the entry point distinguishes it from a Node
error by checking `typeof error.code === "number"` — Node's own errors carry a string code
like `ECONNREFUSED`, which would otherwise be passed to `process.exit`.

Messages say what to do next rather than what went wrong:
`no open tab matching X. Run 'cdp-drive tabs' to see what is open.` ·
`Start one with: cdp-drive launch <url>` ·
`no Chromium browser found. Set CDP_BROWSER to the browser's executable path.` ·
and, when a launched browser never answers, the `--no-sandbox --disable-dev-shm-usage`
hint that CI and containers need.

With `--json`, errors print as `{"error": "...", "code": n}` on stdout, so an agent parsing
output does not have to read stderr differently from success.

Two lookups use `Object.hasOwn(COMMANDS, cmd)` rather than `COMMANDS[cmd]`. Without it,
`cdp-drive toString` would resolve to `Object.prototype.toString` and be called as a
handler; the smoke test runs exactly that command and asserts `unknown command`.

## Launching a browser

`launch` is the one command that is not about an already-running browser, and it is the
longest module because the failure modes are all in the environment.

- **Finding the binary**: `CDP_BROWSER` first, then the platform's known install paths for
  Chrome, Brave, Chromium and Edge, then `command -v` over the same names — which is what
  catches snap, Nix and Homebrew installs.
- **Freeing the profile**: Chromium runs one process per `--user-data-dir`. Launching a
  second time against a held profile opens a tab in the *existing* process and silently
  discards the new flags, debugging port included — the symptom being a browser that
  appears but never answers the port. `releaseProfile` finds the holders and kills them
  first. `profileHolders` compares `--user-data-dir=<profile>` as a whole token, because a
  substring match would kill the browser on `/tmp/p2` when the profile is `/tmp/p`; there
  is a unit test for that. The `Singleton*` files are removed only after the holders have
  actually exited, since removing them under a live browser would leave two processes
  sharing one profile. The whole step is skipped on Windows.
- **Refusing a busy port**: if `/json/version` already answers, `launch` fails rather than
  starting a browser that will lose the race to bind. Otherwise commands would keep landing
  in a browser nobody is looking at — a silent failure rather than a loud one.
- **Waiting for ready**: spawn detached with `stdio: "ignore"` and `unref`, then poll
  `/json/version` every 200ms for up to 20 seconds, checking for a spawn error each time
  around.

`cli.endpoints` returns both `http://127.0.0.1:<port>` and `http://[::1]:<port>` when the
host is the default, because Chromium binds whichever loopback family it resolved at launch
and there is no way to know which from outside. `$CDP_URL` overrides the pair entirely. An
explicit `--host` is used as given.

## Testing

| File | Covers |
|---|---|
| `test/unit.test.mjs` | The pure helpers: argument grammar, env defaults, flag validation, hang arithmetic, endpoint pairs, key mapping, browser flags, profile-holder matching |
| `test/smoke.sh` | The real thing: launches a headless browser on port 9444, drives `test/fixture.html` through every command, and checks every exit code |
| `test/ws-probe.mjs` | Not a test — a diagnostic that times each DevTools call so a hanging environment says which step hangs |

```bash
npm test            # unit, then smoke
npm run test:unit   # node --test test/unit.test.mjs
npm run test:smoke  # bash test/smoke.sh
```

There are no mocks and no browser stubs. The unit tests cover only what is genuinely pure;
everything else is checked against a real headless browser and a real fixture page, which
is the only way the parts that matter — the native-setter fill, key codes a page actually
receives, iframe reach, fixed-position visibility — can be verified at all. The fixture
records `event.key|event.code|event.keyCode` into the DOM so `press` can be asserted from
the page's point of view rather than from the protocol's.

CI runs the unit job on Ubuntu and macOS against Node 22.4 and 24, and the smoke job on
Ubuntu only. The workflow's own comment explains why: GitHub's macOS runners serve the
DevTools HTTP endpoint but answer no call on any page target, with or without sandbox
flags and whichever attach method is used. That suite is run on a real Mac by hand.

## Where to change things

| To change | Edit |
|---|---|
| A new command | `lib/commands.mjs` — add a handler to `COMMANDS`; add its line to `HELP` in `bin/cdp-drive.mjs` |
| A command that must not attach to a page | `DIRECT_COMMANDS` in `bin/cdp-drive.mjs` (as `tabs`, `doctor` and `launch` do) |
| What runs inside the page | `lib/expressions.mjs` — and keep using `quote` for anything interpolated |
| What `snapshot` reports | `INTERACTIVE_SELECTOR`, `describe` and `SNAPSHOT_LIMIT` in `lib/expressions.mjs` |
| A new flag | `FLAGS_WITH_VALUES` and `applyValueFlag` in `lib/cli.mjs`, then `defaultOptions` for its env var |
| A new named key | `NAMED_KEYS` in `lib/cli.mjs` |
| Timeout behaviour | `hangMsFor` and the `DEFAULT_*` constants in `lib/cli.mjs` |
| Exit codes | `lib/errors.mjs` — they are part of the CLI contract, so also update `HELP`, `README.md` and `agents/` |
| Which browsers are found | `BROWSER_PATHS` and `BROWSER_COMMANDS` in `lib/launch.mjs` |
| How a tab is chosen | `cdp.pickPage` |
| How the session is attached | `cdp.connectToPage` |

## Deliberate omissions

Not oversights:

- **No dependencies, and none planned.** `fetch` and `WebSocket` are in the runtime. The
  cost is that Node 22.4 is the floor.
- **No persistent session.** Every command connects, acts and closes. That makes commands
  composable in a shell and safe to run in any order, at the cost of a connection
  handshake each time — tens of milliseconds against a local browser.
- **No cross-origin iframes.** `--frame` walks `contentDocument`, which the same-origin
  policy stops at the boundary. `frames` reports `reachable: false` instead of pretending.
- **No network interception, tracing, mocking or video.** That is what Playwright is for,
  and the README says so rather than half-implementing it.
- **No non-Chromium browser.** The tool is a client for one protocol.
- **`click` is `el.click()`, not a synthesised pointer event.** It is the reliable choice
  for ordinary controls; a library that listens only for real pointer events needs `eval`
  with a dispatched `PointerEvent`, which the troubleshooting table says outright.
- **No remote-host convenience.** `--host` exists, but a non-loopback value prints a
  warning first: anything that reaches a debugging port controls the browser, logged-in
  sessions included.
