#!/usr/bin/env node
// cdp-drive — read and drive a running Chromium browser over the Chrome
// DevTools Protocol. No dependencies. Runs on Node 22.4+ and Bun.
//
// Start a browser with debugging on (see cdp-launch.sh), then:
//   cdp-drive tabs
//   cdp-drive snapshot
//   cdp-drive click "button[type=submit]"
//
// Full docs: README.md

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULT_HANG_MS, hangMsFor, isLoopbackHost, parseArgs } from "../lib/cli.mjs";
import { connectToPage, openPages, pickPage } from "../lib/cdp.mjs";
import { COMMANDS } from "../lib/commands.mjs";
import { documentRoot } from "../lib/page.mjs";
import { findBrowser, launchBrowser } from "../lib/launch.mjs";
import { CdpError, EXIT } from "../lib/errors.mjs";

const HELP = `cdp-drive — drive a running Chromium browser over the DevTools Protocol

Usage: cdp-drive [options] <command> [args]

Commands:
  launch [url]             start a browser with debugging on, then attach to it
  doctor                   check the setup and say what is missing
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
  logs [seconds]           collect console messages and errors (default 5)
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

function report(error) {
  const code = error.code ?? EXIT.error;
  if (opts.json) {
    console.log(JSON.stringify({ error: error.message, code }, null, 2));
  } else {
    console.error(`cdp-drive: ${error.message}`);
  }
  process.exit(code);
}

function print({ data, line, confirmation }) {
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (confirmation && opts.quiet) {
    return;
  }
  console.log(line ?? JSON.stringify(data, null, 2));
}

function readVersion() {
  const packagePath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return JSON.parse(readFileSync(packagePath, "utf8")).version;
}

async function doctor() {
  const checks = [];
  checks.push({ check: "node", value: process.version, ok: true });
  try {
    checks.push({ check: "browser", value: findBrowser(), ok: true });
  } catch (error) {
    checks.push({ check: "browser", value: error.message, ok: false });
  }
  try {
    const pages = await openPages(opts, process.env);
    checks.push({ check: "debugging port", value: `${pages.length} open page(s)`, ok: true });
  } catch (error) {
    checks.push({ check: "debugging port", value: error.message.split("\n")[0], ok: false });
  }
  const line = checks
    .map((entry) => `${entry.ok ? "ok  " : "FAIL"}  ${entry.check}: ${entry.value}`)
    .join("\n");
  const hint = checks.every((entry) => entry.ok)
    ? "\nReady. Try: cdp-drive snapshot"
    : "\nStart a browser with: cdp-drive launch <url>";
  return { data: checks, line: line + hint };
}

// 'tabs' answers over HTTP alone, so it works even when no page will attach.
async function listTabs() {
  const pages = await openPages(opts, process.env);
  const rows = pages.map((page, index) => ({ index, title: page.title, url: page.url }));
  return {
    data: rows,
    line: rows.map((row) => `${row.index}  ${row.title || "(no title)"}  ${row.url}`).join("\n"),
  };
}

async function runCommand() {
  const handler = COMMANDS[parsed.cmd];
  if (!handler) {
    throw new CdpError(`unknown command: ${parsed.cmd}. Run cdp-drive --help.`);
  }
  const target = pickPage(await openPages(opts, process.env), opts);
  const { socket, send } = await connectToPage(target, opts, process.env);
  try {
    return await handler({
      send,
      socket,
      opts,
      args: parsed.args,
      logSeconds: parsed.logSeconds,
      root: documentRoot(parsed.frames),
    });
  } finally {
    socket.close();
  }
}

if (parsed.error) {
  report(new CdpError(parsed.error));
}

if (parsed.version) {
  console.log(opts.json ? JSON.stringify({ version: readVersion() }) : readVersion());
  process.exit(0);
}

if (parsed.help || parsed.cmd == null) {
  console.log(HELP);
  process.exit(0);
}

if (!isLoopbackHost(opts.host)) {
  console.error(
    `cdp-drive: warning — ${opts.host} is not a loopback address. ` +
      `Anything that reaches a debugging port controls the browser, including its logged-in sessions.`,
  );
}

// Never hang: a frozen renderer would otherwise block the command forever.
const hangGuard = setTimeout(
  () => report(new CdpError("timed out (page likely frozen or renderer stalled)", EXIT.timeout)),
  hangMsFor({
    cmd: parsed.cmd,
    opts,
    logSeconds: parsed.logSeconds,
    baseHangMs: Number(process.env.CDP_TIMEOUT_MS ?? DEFAULT_HANG_MS),
  }),
);
hangGuard.unref?.();

const DIRECT_COMMANDS = {
  tabs: listTabs,
  doctor,
  launch: async () => {
    const url = parsed.args[0] ?? "about:blank";
    const { browser, port } = await launchBrowser({ url, opts });
    return {
      data: { browser, port, url },
      line: `launched ${browser}\ndebugging on 127.0.0.1:${port} — try: cdp-drive tabs`,
    };
  },
};

try {
  const direct = DIRECT_COMMANDS[parsed.cmd];
  print(direct ? await direct() : await runCommand());
} catch (error) {
  report(error);
}
process.exit(0);
