#!/usr/bin/env node
// cdp-drive — read and drive a running Chromium browser over the Chrome
// DevTools Protocol. No dependencies. Runs on Node 22+ and Bun.
//
// The browser is one you launched yourself, with its real profile and its real
// logins, so a command lands in the page you are already looking at.
//
// Start a browser with debugging on (see cdp-launch.sh), then:
//   cdp-drive tabs
//   cdp-drive snapshot
//   cdp-drive text "h1"
//   cdp-drive click "button[type=submit]"
//
// Full docs: README.md

import { writeFileSync } from "node:fs";

const DEFAULT_PORT = process.env.CDP_PORT ?? "9222";
const HANG_MS = Number(process.env.CDP_TIMEOUT_MS ?? 25000);
const DEFAULT_WAIT_MS = 10000;
const SNAPSHOT_LIMIT = 150;
const INTERACTIVE_SELECTOR =
  "a,button,input,select,textarea,[role=button],[role=link],[role=tab],[data-testid]";

const HELP = `cdp-drive — drive a running Chromium browser over the DevTools Protocol

Usage: cdp-drive [options] <command> [args]

Commands:
  tabs                     list open pages (url, title, index)
  snapshot                 url, title and the interactive elements on the page
  frames                   list iframes, with a selector for --frame
  text <selector>          innerText of the first match
  dom <selector>           outerHTML of the first match
  attr <selector> <name>   one attribute of the first match
  click <selector>         click the first match
  fill <selector> <value>  set a value and fire input/change (React-friendly)
  press <selector> <key>   focus the match and send a key (e.g. Enter)
  wait <selector>          wait until the selector matches (--timeout ms)
  goto <url>               navigate the target page
  reload                   reload the target page
  eval "<js>"              evaluate an expression in the page, print JSON
  logs [seconds]           collect console messages and errors (default 5)
  shot [path]              save a PNG screenshot (default ./cdp-shot.png)

Options:
  --port <n>          debugging port (default 9222, or $CDP_PORT)
  --host <host>       debugging host (default 127.0.0.1, or $CDP_HOST)
  --page <substring>  pick the tab whose URL or title contains this (or $CDP_PAGE)
  --tab <index>       pick a tab by index from 'tabs'
  --frame <selector>  run inside this iframe; repeat to nest, outer to inner
  --timeout <ms>      timeout for 'wait' (default 10000)
  --json              print machine-readable JSON for every command
  -h, --help          show this help

Exit codes: 0 ok · 1 error (no match, bad selector, eval threw) · 2 timeout
            3 no browser reachable on the debugging port`;

const argv = process.argv.slice(2);
const frames = [];
const positional = [];
const opts = {
  port: DEFAULT_PORT,
  host: process.env.CDP_HOST ?? "127.0.0.1",
  page: process.env.CDP_PAGE ?? null,
  tab: null,
  timeout: DEFAULT_WAIT_MS,
  json: false,
};

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--frame") {
    frames.push(argv[++i]);
  } else if (arg === "--port") {
    opts.port = argv[++i];
  } else if (arg === "--host") {
    opts.host = argv[++i];
  } else if (arg === "--page") {
    opts.page = argv[++i];
  } else if (arg === "--tab") {
    opts.tab = Number(argv[++i]);
  } else if (arg === "--timeout") {
    opts.timeout = Number(argv[++i]);
  } else if (arg === "--json") {
    opts.json = true;
  } else if (arg === "-h" || arg === "--help") {
    console.log(HELP);
    process.exit(0);
  } else {
    positional.push(arg);
  }
}

const cmd = positional.shift();
const args = positional;

if (cmd == null) {
  console.log(HELP);
  process.exit(0);
}

function fail(message, code = 1) {
  console.error(`cdp-drive: ${message}`);
  process.exit(code);
}

function output(value, humanLine) {
  if (opts.json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(humanLine ?? (typeof value === "string" ? value : JSON.stringify(value, null, 2)));
}

// Serialize a value into a JS string literal safely.
const quote = (value) => JSON.stringify(String(value ?? ""));

// Chromium binds the debugging port to whichever loopback family it resolved at
// launch, so try both families before giving up.
function endpoints() {
  if (process.env.CDP_URL) {
    return [process.env.CDP_URL];
  }
  const hosts = opts.host === "127.0.0.1" ? ["127.0.0.1", "[::1]"] : [opts.host];
  return hosts.map((host) => `http://${host}:${opts.port}`);
}

async function fetchTargets() {
  const errors = [];
  for (const base of endpoints()) {
    try {
      const response = await fetch(`${base}/json`);
      return await response.json();
    } catch (error) {
      errors.push(`${base}: ${error.cause?.code ?? error.message}`);
    }
  }
  fail(
    `no browser reachable (${errors.join(", ")}).\n` +
      `Start one with a debugging port, e.g. cdp-launch.sh, or pass --port.`,
    3,
  );
}

async function openPages() {
  const targets = await fetchTargets();
  return targets.filter(
    (target) =>
      target.type === "page" &&
      target.webSocketDebuggerUrl &&
      !(target.url ?? "").startsWith("devtools://"),
  );
}

function pickPage(pages) {
  if (pages.length === 0) {
    fail("no open page targets in this browser", 3);
  }
  if (opts.tab != null) {
    const byIndex = pages[opts.tab];
    if (!byIndex) {
      fail(`no tab at index ${opts.tab} (there are ${pages.length})`);
    }
    return byIndex;
  }
  if (opts.page) {
    const needle = opts.page.toLowerCase();
    const hit = pages.find(
      (page) =>
        (page.url ?? "").toLowerCase().includes(needle) ||
        (page.title ?? "").toLowerCase().includes(needle),
    );
    if (!hit) {
      fail(`no open tab matching ${opts.page}`);
    }
    return hit;
  }
  return pages[0];
}

function cdpClient(socket) {
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (message) =>
        message.error ? reject(new Error(message.error.message)) : resolve(message.result),
      );
      socket.send(JSON.stringify({ id, method, params }));
    });
}

// The document commands run against: walks into each --frame iframe in turn.
const ROOT = frames.reduce(
  (expression, selector) => `${expression}.querySelector(${quote(selector)})?.contentDocument`,
  "document",
);

const GUARDED_ROOT = `(() => { const root = ${ROOT};
  if (!root) throw new Error('frame not reachable: ' + ${quote(frames.join(" > "))});
  return root; })()`;

async function evaluate(send, expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "eval failed",
    );
  }
  return result.result.value;
}

function requireArg(value, name) {
  if (value == null || value === "") {
    fail(`missing <${name}>. Run cdp-drive --help.`);
  }
  return value;
}

async function collectLogs(socket, send, seconds) {
  const events = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.consoleAPICalled") {
      events.push({
        kind: `console.${message.params.type}`,
        text: (message.params.args ?? [])
          .map((arg) => arg.value ?? arg.description ?? arg.unserializableValue ?? "")
          .join(" ")
          .slice(0, 300),
      });
    } else if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails;
      events.push({
        kind: "exception",
        text: (details.exception?.description ?? details.text ?? "").slice(0, 400),
      });
    } else if (message.method === "Log.entryAdded") {
      events.push({
        kind: `log.${message.params.entry.level}`,
        text: (message.params.entry.text ?? "").slice(0, 300),
      });
    }
  });
  await send("Log.enable").catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  // Fold repeats so a runaway loop reads as one line with a count.
  const counts = new Map();
  for (const event of events) {
    const key = `${event.kind}|${event.text}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({
      count,
      kind: key.slice(0, key.indexOf("|")),
      text: key.slice(key.indexOf("|") + 1),
    }))
    .sort((a, b) => b.count - a.count);
}

const snapshotExpression = `(() => {
  const root = ${GUARDED_ROOT};
  const view = root.defaultView || window;
  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role') || undefined,
    type: el.getAttribute('type') || undefined,
    name: (el.getAttribute('aria-label') || el.name || el.placeholder ||
           (el.innerText || '').trim().slice(0, 80)) || undefined,
    id: el.id || undefined,
    testid: el.getAttribute('data-testid') || undefined,
    href: el.getAttribute('href') || undefined,
  });
  const elements = [...root.querySelectorAll(${quote(INTERACTIVE_SELECTOR)})]
    .filter((el) => el.offsetParent !== null)
    .slice(0, ${SNAPSHOT_LIMIT})
    .map(describe);
  return { url: view.location.href, title: root.title, interactive: elements };
})()`;

const framesExpression = `(() => {
  const root = ${GUARDED_ROOT};
  return [...root.querySelectorAll('iframe')].map((frame, index) => {
    let reachable = false;
    try {
      reachable = !!frame.contentDocument;
    } catch {
      reachable = false;
    }
    return {
      index,
      src: frame.getAttribute('src') || undefined,
      id: frame.id || undefined,
      name: frame.name || undefined,
      selector: frame.id ? 'iframe#' + frame.id : 'iframe:nth-of-type(' + (index + 1) + ')',
      reachable,
    };
  });
})()`;

function elementExpression(selector, body) {
  return `(() => {
    const el = ${GUARDED_ROOT}.querySelector(${quote(selector)});
    if (!el) throw new Error('no match: ' + ${quote(selector)});
    ${body}
  })()`;
}

async function waitForSelector(send, selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await evaluate(
      send,
      `!!${GUARDED_ROOT}.querySelector(${quote(selector)})`,
    ).catch(() => false);
    if (found) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

async function run(socket, send) {
  switch (cmd) {
    case "tabs": {
      const pages = await openPages();
      const rows = pages.map((page, index) => ({ index, title: page.title, url: page.url }));
      output(
        rows,
        rows.map((row) => `${row.index}  ${row.title || "(no title)"}  ${row.url}`).join("\n"),
      );
      return;
    }
    case "snapshot": {
      output(await evaluate(send, snapshotExpression));
      return;
    }
    case "frames": {
      output(await evaluate(send, framesExpression));
      return;
    }
    case "text": {
      const selector = requireArg(args[0], "selector");
      const value = await evaluate(
        send,
        `${GUARDED_ROOT}.querySelector(${quote(selector)})?.innerText ?? null`,
      );
      if (value == null) {
        fail(`no match: ${selector}`);
      }
      output({ selector, text: value }, value);
      return;
    }
    case "dom": {
      const selector = requireArg(args[0], "selector");
      const value = await evaluate(
        send,
        `${GUARDED_ROOT}.querySelector(${quote(selector)})?.outerHTML ?? null`,
      );
      if (value == null) {
        fail(`no match: ${selector}`);
      }
      output({ selector, html: value }, value);
      return;
    }
    case "attr": {
      const selector = requireArg(args[0], "selector");
      const name = requireArg(args[1], "attribute");
      const value = await evaluate(
        send,
        elementExpression(selector, `return el.getAttribute(${quote(name)});`),
      );
      output({ selector, attribute: name, value }, String(value));
      return;
    }
    case "click": {
      const selector = requireArg(args[0], "selector");
      await evaluate(send, elementExpression(selector, "el.click(); return true;"));
      output({ clicked: selector }, `clicked ${selector}`);
      return;
    }
    case "fill": {
      const selector = requireArg(args[0], "selector");
      const value = args[1] ?? "";
      // Set through the native setter so React and Vue see the change.
      await evaluate(
        send,
        elementExpression(
          selector,
          `const proto = el instanceof HTMLTextAreaElement
             ? HTMLTextAreaElement.prototype
             : HTMLInputElement.prototype;
           const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
           el.focus();
           if (setter) { setter.call(el, ${quote(value)}); } else { el.value = ${quote(value)}; }
           el.dispatchEvent(new Event('input', { bubbles: true }));
           el.dispatchEvent(new Event('change', { bubbles: true }));
           return true;`,
        ),
      );
      output({ filled: selector, value }, `filled ${selector}`);
      return;
    }
    case "press": {
      const selector = requireArg(args[0], "selector");
      const key = requireArg(args[1], "key");
      await evaluate(send, elementExpression(selector, "el.focus(); return true;"));
      const keyCodes = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8 };
      for (const type of ["keyDown", "char", "keyUp"]) {
        if (type === "char" && !keyCodes[key] && key.length !== 1) {
          continue;
        }
        await send("Input.dispatchKeyEvent", {
          type,
          key,
          text: key.length === 1 ? key : key === "Enter" ? "\r" : undefined,
          windowsVirtualKeyCode: keyCodes[key] ?? key.toUpperCase().charCodeAt(0),
        });
      }
      output({ pressed: key, selector }, `pressed ${key} on ${selector}`);
      return;
    }
    case "wait": {
      const selector = requireArg(args[0], "selector");
      const found = await waitForSelector(send, selector, opts.timeout);
      if (!found) {
        fail(`timed out after ${opts.timeout}ms waiting for ${selector}`, 2);
      }
      output({ waited: selector }, `found ${selector}`);
      return;
    }
    case "goto": {
      const url = requireArg(args[0], "url");
      await send("Page.navigate", { url });
      output({ navigating: url }, `navigating to ${url}`);
      return;
    }
    case "reload": {
      await send("Page.reload", {});
      output({ reloaded: true }, "reloaded");
      return;
    }
    case "eval": {
      const expression = requireArg(args[0], "expression");
      const value = await evaluate(send, expression);
      console.log(JSON.stringify(value, null, 2));
      return;
    }
    case "logs": {
      const seconds = Number(args[0] ?? 5);
      output(await collectLogs(socket, send, seconds));
      return;
    }
    case "shot": {
      const path = args[0] ?? "cdp-shot.png";
      const result = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(path, Buffer.from(result.data, "base64"));
      output({ screenshot: path }, path);
      return;
    }
    default:
      fail(`unknown command: ${cmd}. Run cdp-drive --help.`);
  }
}

// Never hang: a frozen renderer would otherwise block the command forever.
const hangGuard = setTimeout(() => {
  console.error("cdp-drive: timed out (page likely frozen or renderer stalled)");
  process.exit(2);
}, HANG_MS);
hangGuard.unref?.();

const target = pickPage(await openPages());
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve);
  socket.addEventListener("error", () => reject(new Error("could not open a DevTools connection")));
});
const send = cdpClient(socket);
await send("Runtime.enable").catch(() => {});
await send("Page.enable").catch(() => {});
try {
  await run(socket, send);
} catch (error) {
  fail(error.message);
} finally {
  socket.close();
}
