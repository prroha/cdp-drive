// Diagnostic probe: connect to a page target and time each DevTools call, so a
// hanging environment says which step hangs.
const base = process.argv[2] ?? "http://127.0.0.1:9444";
const wanted = process.argv[3];

const targets = await (await fetch(`${base}/json`)).json();
const page = targets.find(
  (target) => target.type === "page" && (!wanted || (target.url ?? "").includes(wanted)),
);
console.log("target:", page?.url);
console.log("socket url:", page?.webSocketDebuggerUrl);

const socket = new WebSocket(page.webSocketDebuggerUrl);
const opened = await Promise.race([
  new Promise((resolve) => socket.addEventListener("open", () => resolve("open"))),
  new Promise((resolve) => socket.addEventListener("error", () => resolve("error"))),
  new Promise((resolve) => setTimeout(() => resolve("timeout"), 8000)),
]);
console.log("socket:", opened);

let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});

async function timed(method, params = {}) {
  const started = Date.now();
  const id = nextId++;
  const answer = await Promise.race([
    new Promise((resolve) => {
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    }),
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 8000)),
  ]);
  const took = Date.now() - started;
  console.log(
    `${method}: ${answer.timedOut ? "TIMED OUT" : answer.error ? `error ${answer.error.message}` : "ok"} (${took}ms)`,
  );
  return answer;
}

await timed("Runtime.enable");
await timed("Page.enable");
await timed("Runtime.evaluate", { expression: "1 + 1", returnByValue: true });
await timed("Runtime.evaluate", { expression: "document.title", returnByValue: true });
process.exit(0);
