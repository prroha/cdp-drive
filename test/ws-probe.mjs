// Minimal probe: can we open a DevTools WebSocket and get an answer?
const base = process.argv[2] ?? "http://127.0.0.1:9444";
const targets = await (await fetch(`${base}/json`)).json();
const page = targets.find((t) => t.type === "page");
console.log("target:", page?.url, page?.webSocketDebuggerUrl);
const socket = new WebSocket(page.webSocketDebuggerUrl);
const opened = await Promise.race([
  new Promise((r) => socket.addEventListener("open", () => r("open"))),
  new Promise((r) => socket.addEventListener("error", (e) => r("error: " + (e.message ?? "?")))),
  new Promise((r) => setTimeout(() => r("timeout"), 8000)),
]);
console.log("socket:", opened);
process.exit(0);
