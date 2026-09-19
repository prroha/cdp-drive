// Finding a browser, picking a tab, and talking to it over the DevTools Protocol.
import { endpoints } from "./cli.mjs";
import { CdpError, EXIT } from "./errors.mjs";

export async function fetchTargets(opts, env) {
  const errors = [];
  for (const base of endpoints(opts, env)) {
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
  throw new CdpError(
    `no browser reachable (${errors.join(", ")}).\n` +
      `Start one with a debugging port, e.g. cdp-launch.sh, or pass --port.`,
    EXIT.unreachable,
  );
}

export async function openPages(opts, env) {
  const targets = await fetchTargets(opts, env);
  return targets.filter(
    (target) =>
      target.type === "page" &&
      target.webSocketDebuggerUrl &&
      !(target.url ?? "").startsWith("devtools://"),
  );
}

export function pickPage(pages, opts) {
  if (pages.length === 0) {
    throw new CdpError("no open page targets in this browser", EXIT.unreachable);
  }
  if (opts.tab != null) {
    const byIndex = pages[opts.tab];
    if (!byIndex) {
      throw new CdpError(`no tab at index ${opts.tab} (there are ${pages.length})`);
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
      throw new CdpError(
        `no open tab matching ${opts.page}. Run 'cdp-drive tabs' to see what is open.`,
      );
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
        message.error ? reject(new CdpError(message.error.message)) : resolve(message.result),
      );
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
}

async function openSocket(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", () =>
      reject(new CdpError(`could not open a DevTools connection to ${url}`, EXIT.unreachable)),
    );
  });
  return socket;
}

async function browserSocketUrl(opts, env) {
  for (const base of endpoints(opts, env)) {
    try {
      const response = await fetch(`${base}/json/version`);
      return (await response.json()).webSocketDebuggerUrl;
    } catch {
      continue;
    }
  }
  throw new CdpError("the browser endpoint did not report a DevTools socket", EXIT.unreachable);
}

// Attach through the browser endpoint rather than a page socket: page sockets
// accept a connection but answer nothing in some environments, and a browser
// session also leaves room for browser-level calls.
export async function connectToPage(target, opts, env) {
  const socket = await openSocket(await browserSocketUrl(opts, env));
  const send = cdpClient(socket);
  const { sessionId } = await send("Target.attachToTarget", {
    targetId: target.id,
    flatten: true,
  });
  const sessionSend = (method, params) => send(method, params, sessionId);
  await sessionSend("Runtime.enable").catch(() => {});
  await sessionSend("Page.enable").catch(() => {});
  return { socket, send: sessionSend };
}
