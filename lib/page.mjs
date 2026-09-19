// Evaluating JavaScript in the page and reading what comes back. The JavaScript
// itself lives in expressions.mjs.
import { CdpError } from "./errors.mjs";

const POLL_INTERVAL_MS = 150;
const CONSOLE_TEXT_LIMIT = 300;
const EXCEPTION_TEXT_LIMIT = 400;

// A failure that will never resolve itself must not be mistaken for "not ready".
const PERMANENT_ERROR = /frame not reachable|not a valid selector|SyntaxError/i;

// Serialize a value into a JS string literal safely.
export const quote = (value) => JSON.stringify(String(value ?? ""));

// The document an expression runs against, walking into each --frame iframe.
export function documentRoot(frames) {
  const path = frames.reduce(
    (expression, selector) => `${expression}.querySelector(${quote(selector)})?.contentDocument`,
    "document",
  );
  return `(() => { const root = ${path};
    if (!root) throw new Error('frame not reachable: ' + ${quote(frames.join(" > "))});
    return root; })()`;
}

export async function evaluate(send, expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new CdpError(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "eval failed",
    );
  }
  return result.result.value;
}

export function elementExpression(root, selector, body) {
  return `(() => {
    const el = ${root}.querySelector(${quote(selector)});
    if (!el) throw new Error('no match: ' + ${quote(selector)});
    ${body}
  })()`;
}

export async function queryProperty(send, root, selector, property) {
  const expression = `${root}.querySelector(${quote(selector)})?.${property} ?? null`;
  const value = await evaluate(send, expression);
  if (value == null) {
    throw new CdpError(`no match: ${selector}`);
  }
  return value;
}

export async function waitForSelector(send, root, selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const found = await evaluate(send, `!!${root}.querySelector(${quote(selector)})`);
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

function describeLogEvent(message) {
  if (message.method === "Runtime.consoleAPICalled") {
    return {
      kind: `console.${message.params.type}`,
      text: (message.params.args ?? [])
        .map((arg) => arg.value ?? arg.description ?? arg.unserializableValue ?? "")
        .join(" ")
        .slice(0, CONSOLE_TEXT_LIMIT),
    };
  }
  if (message.method === "Runtime.exceptionThrown") {
    const details = message.params.exceptionDetails;
    return {
      kind: "exception",
      text: (details.exception?.description ?? details.text ?? "").slice(0, EXCEPTION_TEXT_LIMIT),
    };
  }
  if (message.method === "Log.entryAdded") {
    return {
      kind: `log.${message.params.entry.level}`,
      text: (message.params.entry.text ?? "").slice(0, CONSOLE_TEXT_LIMIT),
    };
  }
  return null;
}

// Fold repeats so a runaway loop reads as one line with a count.
export function foldEvents(events) {
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

export async function collectLogs(socket, send, seconds) {
  const events = [];
  socket.addEventListener("message", (event) => {
    const described = describeLogEvent(JSON.parse(event.data));
    if (described) {
      events.push(described);
    }
  });
  await send("Log.enable").catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  return foldEvents(events);
}
