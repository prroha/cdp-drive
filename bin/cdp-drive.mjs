#!/usr/bin/env node
// cdp-drive — read and drive a running Chromium browser over the Chrome
// DevTools Protocol. No dependencies. Runs on Node 22.4+ and Bun.
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

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DEFAULT_LOG_SECONDS,
  DEFAULT_HANG_MS,
  endpoints,
  hangMsFor,
  isLoopbackHost,
  keyEvents,
  parseArgs,
} from "../lib/cli.mjs";

const POLL_INTERVAL_MS = 150;
const SNAPSHOT_LIMIT = 150;
const INTERACTIVE_SELECTOR =
  "a,button,input,select,textarea,[role=button],[role=link],[role=tab],[data-testid]";

const HELP = `cdp-drive — drive a running Chromium browser over the DevTools Protocol

Usage: cdp-drive [options] <command> [args]

Commands:
  tabs                     list open pages (index, title, url)
  snapshot                 url, title and the interactive elements on the page
  frames                   list iframes, with a selector for --frame
  text <selector>          innerText of the first match
  dom <selector>           outerHTML of the first match
  attr <selector> <name>   one attribute of the first match
  click <selector>         click the first match
  fill <selector> <value>  set a value and fire input/change (React-friendly)
  press <selector> <key>   focus the match and send a key (e.g. Enter, ArrowDown)
  wait <selector>          wait until the selector matches (--timeout ms)
  goto <url>               navigate the target page
  reload                   reload the target page
  eval "<js>"              evaluate an expression in the page, print JSON
  logs [seconds]           collect console messages and errors (default ${DEFAULT_LOG_SECONDS})
  shot [path]              save a PNG screenshot (default ./cdp-shot.png)

Options:
  --port <n>          debugging port (default 9222, or $CDP_PORT)
  --host <host>       debugging host (default 127.0.0.1, or $CDP_HOST)
  --page <substring>  pick the tab whose URL or title contains this (or $CDP_PAGE)
  --tab <index>       pick a tab by index from 'tabs'
  --frame <selector>  run inside this iframe; repeat to nest, outer to inner
  --timeout <ms>      timeout for 'wait' (default 10000)
  --json              machine-readable JSON for results and errors
  --quiet             suppress confirmation lines; data and errors still print
  -v, --version       print the version
  -h, --help          show this help

Exit codes: 0 ok · 1 error (no match, bad selector, eval threw) · 2 timeout
            3 no browser reachable on the debugging port`;

const parsed = parseArgs(process.argv.slice(2), process.env);
const opts = parsed.opts ?? { json: process.argv.includes("--json") };

function fail(message, code = 1) {
  if (opts.json) {
    console.log(JSON.stringify({ error: message, code }, null, 2));
  } else {
    console.error(`cdp-drive: ${message}`);
  }
  process.exit(code);
}

if (parsed.error) {
  fail(parsed.error);
}

if (parsed.version) {
  const here = dirname(fileURLToPath(import.meta.url));
  const { version } = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
  console.log(opts.json ? JSON.stringify({ version }) : version);
  process.exit(0);
}

if (parsed.help || parsed.cmd == null) {
  console.log(HELP);
  process.exit(0);
}

const { frames, cmd, args, logSeconds } = parsed;

if (!isLoopbackHost(opts.host)) {
  console.error(
    `cdp-drive: warning — ${opts.host} is not a loopback address. ` +
      `Anything that reaches a debugging port controls the browser, including its logged-in sessions.`,
  );
}

// Human confirmations ("clicked #foo") are noise in a script; data is not.
function output(value, humanLine, { confirmation = false } = {}) {
  if (opts.json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (confirmation && opts.quiet) {
    return;
  }
  console.log(humanLine ?? (typeof value === "string" ? value : JSON.stringify(value, null, 2)));
}

// Serialize a value into a JS string literal safely.
const quote = (value) => JSON.stringify(String(value ?? ""));

async function fetchTargets() {
  const errors = [];
  for (const base of endpoints(opts, process.env)) {
    try {
      const response = await fetch(`${base}/json`);
      if (!response.ok) {
        errors.push(`${base}: HTTP ${response.status}`);
        continue;
      }
      const body = await response.json();
      if (!Array.isArray(body)) {
        errors.push(`${base}: not a DevTools endpoint`);
        continue;
      }
      return body;
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
      fail(`no open tab matching ${opts.page}. Run 'cdp-drive tabs' to see what is open.`);
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
  // sessionId routes a call to one page; without it the call is browser-wide.
  return (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (message) =>
        message.error ? reject(new Error(message.error.message)) : resolve(message.result),
      );
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
}

async function openSocket(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", () =>
      reject(new Error(`could not open a DevTools connection to ${url}`)),
    );
  });
  return socket;
}

// Attach through the browser endpoint rather than a page socket. Page sockets
// are silently unresponsive in some environments, and a browser session also
// leaves room for browser-level calls later.
async function connectToPage(target) {
  let browserUrl = null;
  for (const base of endpoints(opts, process.env)) {
    try {
      const response = await fetch(`${base}/json/version`);
      browserUrl = (await response.json()).webSocketDebuggerUrl;
      break;
    } catch {
      continue;
    }
  }
  if (browserUrl == null) {
    throw new Error("the browser endpoint did not report a DevTools socket");
  }
  const socket = await openSocket(browserUrl);
  const send = cdpClient(socket);
  const { sessionId } = await send("Target.attachToTarget", {
    targetId: target.id,
    flatten: true,
  });
  return { socket, send: (method, params) => send(method, params, sessionId) };
}

// The document commands run against: walks into each --frame iframe in turn.
const ROOT = frames.reduce(
  (expression, selector) => `${expression}.querySelector(${quote(selector)})?.contentDocument`,
  "document",
);

const GUARDED_ROOT = `(() => { const root = ${ROOT};
  if (!root) throw new Error('frame not reachable: ' + ${quote(frames.join(" > "))});
  return root; })()`;

// A permanent failure must not be mistaken for "not ready yet" while polling.
const PERMANENT_ERROR = /frame not reachable|not a valid selector|SyntaxError/i;

async function evaluate(send, expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "eval failed",
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

// Visible means it occupies space and is not hidden by style. offsetParent is
// not the test: it is null for every position:fixed element.
const VISIBLE_HELPER = `const isVisible = (el) => {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return false;
  }
  const style = view.getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
};`;

const snapshotExpression = `(() => {
  const root = ${GUARDED_ROOT};
  const view = root.defaultView || window;
  ${VISIBLE_HELPER}
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
    .filter(isVisible)
    .slice(0, ${SNAPSHOT_LIMIT})
    .map(describe);
  return { url: view.location.href, title: root.title, interactive: elements };
})()`;

// A selector that resolves from the document root, so nested iframes under
// different parents each get a selector that actually matches them.
const CSS_PATH_HELPER = `const cssPath = (el) => {
  const escape = (value) => (view.CSS && view.CSS.escape ? view.CSS.escape(value) : value);
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1) {
    if (node.id) {
      parts.unshift(node.tagName.toLowerCase() + '#' + escape(node.id));
      break;
    }
    const parent = node.parentElement;
    if (!parent) {
      parts.unshift(node.tagName.toLowerCase());
      break;
    }
    const twins = [...parent.children].filter((child) => child.tagName === node.tagName);
    const step = twins.length > 1
      ? node.tagName.toLowerCase() + ':nth-of-type(' + (twins.indexOf(node) + 1) + ')'
      : node.tagName.toLowerCase();
    parts.unshift(step);
    node = parent;
  }
  return parts.join(' > ');
};`;

const framesExpression = `(() => {
  const root = ${GUARDED_ROOT};
  const view = root.defaultView || window;
  ${CSS_PATH_HELPER}
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
      selector: cssPath(frame),
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
    try {
      const found = await evaluate(send, `!!${GUARDED_ROOT}.querySelector(${quote(selector)})`);
      if (found) {
        return true;
      }
    } catch (error) {
      if (PERMANENT_ERROR.test(error.message)) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return false;
}

async function run(socket, send) {
  switch (cmd) {
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
      output({ clicked: selector }, `clicked ${selector}`, { confirmation: true });
      return;
    }
    case "fill": {
      const selector = requireArg(args[0], "selector");
      const value = args[1] ?? "";
      // Set through the element's own native setter so React and Vue see it.
      await evaluate(
        send,
        elementExpression(
          selector,
          `const view = el.ownerDocument.defaultView;
           if (el.isContentEditable) {
             el.focus();
             el.textContent = ${quote(value)};
             el.dispatchEvent(new Event('input', { bubbles: true }));
             return true;
           }
           const proto = el instanceof view.HTMLTextAreaElement ? view.HTMLTextAreaElement.prototype
             : el instanceof view.HTMLSelectElement ? view.HTMLSelectElement.prototype
             : el instanceof view.HTMLInputElement ? view.HTMLInputElement.prototype
             : null;
           if (!proto) {
             throw new Error('cannot fill <' + el.tagName.toLowerCase() +
               '>: not an input, textarea, select or contenteditable element');
           }
           const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
           el.focus();
           if (setter) { setter.call(el, ${quote(value)}); } else { el.value = ${quote(value)}; }
           el.dispatchEvent(new Event('input', { bubbles: true }));
           el.dispatchEvent(new Event('change', { bubbles: true }));
           return true;`,
        ),
      );
      output({ filled: selector, value }, `filled ${selector}`, { confirmation: true });
      return;
    }
    case "press": {
      const selector = requireArg(args[0], "selector");
      const key = requireArg(args[1], "key");
      const mapped = keyEvents(key);
      if (mapped.error) {
        fail(mapped.error);
      }
      const { keyCode, code, text } = mapped;
      await evaluate(send, elementExpression(selector, "el.focus(); return true;"));
      await send("Input.dispatchKeyEvent", {
        type: text ? "keyDown" : "rawKeyDown",
        key,
        code,
        text,
        windowsVirtualKeyCode: keyCode,
      });
      if (text) {
        await send("Input.dispatchKeyEvent", { type: "char", key, code, text });
      }
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key,
        code,
        windowsVirtualKeyCode: keyCode,
      });
      output({ pressed: key, selector }, `pressed ${key} on ${selector}`, { confirmation: true });
      return;
    }
    case "wait": {
      const selector = requireArg(args[0], "selector");
      const found = await waitForSelector(send, selector, opts.timeout);
      if (!found) {
        fail(`timed out after ${opts.timeout}ms waiting for ${selector}`, 2);
      }
      output({ waited: selector }, `found ${selector}`, { confirmation: true });
      return;
    }
    case "goto": {
      const url = requireArg(args[0], "url");
      await send("Page.navigate", { url });
      output({ navigating: url }, `navigating to ${url}`, { confirmation: true });
      return;
    }
    case "reload": {
      await send("Page.reload", {});
      output({ reloaded: true }, "reloaded", { confirmation: true });
      return;
    }
    case "eval": {
      const expression = requireArg(args[0], "expression");
      const value = await evaluate(send, expression);
      console.log(JSON.stringify(value, null, 2));
      return;
    }
    case "logs": {
      output(await collectLogs(socket, send, logSeconds));
      return;
    }
    case "shot": {
      const path = args[0] ?? "cdp-shot.png";
      // Chromium renders no frames for a background tab, so raise it first.
      await send("Page.bringToFront").catch(() => {});
      const result = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(path, Buffer.from(result.data, "base64"));
      output({ screenshot: path }, path);
      return;
    }
    default:
      fail(`unknown command: ${cmd}. Run cdp-drive --help.`);
  }
}

// 'tabs' is how you find out what is open, so it must not depend on a tab
// selection or on any one page's debugger socket being healthy.
if (cmd === "tabs") {
  const pages = await openPages();
  const rows = pages.map((page, index) => ({ index, title: page.title, url: page.url }));
  output(
    rows,
    rows.map((row) => `${row.index}  ${row.title || "(no title)"}  ${row.url}`).join("\n"),
  );
  process.exit(0);
}

// Never hang: a frozen renderer would otherwise block the command forever.
const hangGuard = setTimeout(
  () => {
    fail("timed out (page likely frozen or renderer stalled)", 2);
  },
  hangMsFor({
    cmd,
    opts,
    logSeconds,
    baseHangMs: Number(process.env.CDP_TIMEOUT_MS ?? DEFAULT_HANG_MS),
  }),
);
hangGuard.unref?.();

const target = pickPage(await openPages());
const { socket, send } = await connectToPage(target).catch((error) => fail(error.message, 3));
await send("Runtime.enable").catch(() => {});
await send("Page.enable").catch(() => {});
try {
  await run(socket, send);
} catch (error) {
  fail(error.message);
} finally {
  socket.close();
}
