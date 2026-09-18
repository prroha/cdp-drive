// Pure helpers for cdp-drive: argument parsing, key mapping, endpoint building
// and timeout arithmetic. Nothing here touches the network or the process, so
// it is unit-testable without a browser.

export const DEFAULT_WAIT_MS = 10000;
export const DEFAULT_LOG_SECONDS = 5;
export const DEFAULT_HANG_MS = 25000;
export const HANG_MARGIN_MS = 5000;

// Named keys carry a virtual key code and a `code` value; listeners read both.
export const NAMED_KEYS = {
  Enter: { keyCode: 13, code: "Enter", text: "\r" },
  Tab: { keyCode: 9, code: "Tab" },
  Escape: { keyCode: 27, code: "Escape" },
  Backspace: { keyCode: 8, code: "Backspace" },
  Delete: { keyCode: 46, code: "Delete" },
  ArrowUp: { keyCode: 38, code: "ArrowUp" },
  ArrowDown: { keyCode: 40, code: "ArrowDown" },
  ArrowLeft: { keyCode: 37, code: "ArrowLeft" },
  ArrowRight: { keyCode: 39, code: "ArrowRight" },
  Home: { keyCode: 36, code: "Home" },
  End: { keyCode: 35, code: "End" },
  PageUp: { keyCode: 33, code: "PageUp" },
  PageDown: { keyCode: 34, code: "PageDown" },
  Space: { keyCode: 32, code: "Space", text: " " },
};

const FLAGS_WITH_VALUES = new Set(["--frame", "--port", "--host", "--page", "--tab", "--timeout"]);

function numberOr(flag, raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return { error: `${flag} expects a number, got ${raw}` };
  }
  return { value };
}

// Parse argv into options, frame chain, command and command arguments.
// Returns { error } instead of exiting, so callers decide how to report.
export function parseArgs(argv, env = {}) {
  const frames = [];
  const positional = [];
  const opts = {
    port: env.CDP_PORT ?? "9222",
    host: env.CDP_HOST ?? "127.0.0.1",
    page: env.CDP_PAGE ?? null,
    tab: null,
    timeout: DEFAULT_WAIT_MS,
    json: argv.includes("--json"),
    quiet: argv.includes("--quiet"),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json" || arg === "--quiet") {
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      return { ...baseResult(opts, frames, positional), help: true };
    }
    if (arg === "-v" || arg === "--version") {
      return { ...baseResult(opts, frames, positional), version: true };
    }
    if (FLAGS_WITH_VALUES.has(arg)) {
      const value = argv[++i];
      if (value == null || value.startsWith("--")) {
        return { error: `${arg} needs a value` };
      }
      if (arg === "--frame") {
        frames.push(value);
      } else if (arg === "--host") {
        opts.host = value;
      } else if (arg === "--port") {
        const parsed = numberOr(arg, value);
        if (parsed.error) {
          return { error: parsed.error };
        }
        opts.port = String(parsed.value);
      } else if (arg === "--page") {
        opts.page = value;
      } else if (arg === "--tab") {
        const parsed = numberOr(arg, value);
        if (parsed.error) {
          return { error: parsed.error };
        }
        opts.tab = parsed.value;
      } else if (arg === "--timeout") {
        const parsed = numberOr(arg, value);
        if (parsed.error) {
          return { error: parsed.error };
        }
        opts.timeout = parsed.value;
      }
      continue;
    }
    positional.push(arg);
  }

  const result = baseResult(opts, frames, positional);
  if (result.cmd === "logs") {
    const parsed = numberOr("logs <seconds>", result.args[0] ?? DEFAULT_LOG_SECONDS);
    if (parsed.error) {
      return { error: parsed.error };
    }
    result.logSeconds = parsed.value;
  }
  return result;
}

function baseResult(opts, frames, positional) {
  const [cmd, ...args] = positional;
  return { opts, frames, cmd: cmd ?? null, args, logSeconds: 0 };
}

// A command meant to take time must outlive the hang guard.
export function hangMsFor({ cmd, opts, logSeconds, baseHangMs = DEFAULT_HANG_MS }) {
  const requestedMs = cmd === "wait" ? opts.timeout : logSeconds * 1000;
  return Math.max(baseHangMs, requestedMs + HANG_MARGIN_MS);
}

// Chromium binds the debugging port to whichever loopback family it resolved at
// launch, so both families are worth trying before giving up.
export function endpoints(opts, env = {}) {
  if (env.CDP_URL) {
    return [env.CDP_URL];
  }
  const hosts = opts.host === "127.0.0.1" ? ["127.0.0.1", "[::1]"] : [opts.host];
  return hosts.map((host) => `http://${host}:${opts.port}`);
}

export function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "::1" || host === "[::1]" || host === "localhost";
}

// Key codes and `code` values for Input.dispatchKeyEvent.
export function keyEvents(key) {
  const named = NAMED_KEYS[key];
  if (named) {
    return { keyCode: named.keyCode, code: named.code, text: named.text };
  }
  if (key.length !== 1) {
    return {
      error: `unknown key: ${key}. Use a single character or one of: ${Object.keys(NAMED_KEYS).join(", ")}`,
    };
  }
  const upper = key.toUpperCase();
  const code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(key) ? `Digit${key}` : undefined;
  return { keyCode: upper.charCodeAt(0), code, text: key };
}
