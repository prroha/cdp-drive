// Unit tests for the pure helpers. No browser needed: run with `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_HANG_MS,
  DEFAULT_LOG_SECONDS,
  DEFAULT_WAIT_MS,
  endpoints,
  hangMsFor,
  isLoopbackHost,
  keyEvents,
  parseArgs,
} from "../lib/cli.mjs";

test("parses a bare command", () => {
  const parsed = parseArgs(["snapshot"]);
  assert.equal(parsed.cmd, "snapshot");
  assert.deepEqual(parsed.args, []);
  assert.equal(parsed.opts.port, "9222");
  assert.equal(parsed.opts.timeout, DEFAULT_WAIT_MS);
});

test("parses command arguments and options in any order", () => {
  const parsed = parseArgs(["--port", "9333", "fill", "#a", "value", "--json"]);
  assert.equal(parsed.cmd, "fill");
  assert.deepEqual(parsed.args, ["#a", "value"]);
  assert.equal(parsed.opts.port, "9333");
  assert.equal(parsed.opts.json, true);
});

test("collects a chain of --frame selectors, outer to inner", () => {
  const parsed = parseArgs(["--frame", "iframe#a", "--frame", "iframe#b", "text", "h1"]);
  assert.deepEqual(parsed.frames, ["iframe#a", "iframe#b"]);
  assert.equal(parsed.cmd, "text");
});

test("reads defaults from the environment", () => {
  const parsed = parseArgs(["tabs"], { CDP_PORT: "9500", CDP_PAGE: "checkout" });
  assert.equal(parsed.opts.port, "9500");
  assert.equal(parsed.opts.page, "checkout");
});

test("rejects a flag with no value", () => {
  assert.match(parseArgs(["tabs", "--port"]).error, /--port needs a value/);
  assert.match(parseArgs(["--page", "--json", "tabs"]).error, /--page needs a value/);
});

test("rejects non-numeric numeric options", () => {
  assert.match(parseArgs(["--timeout", "abc", "wait", "#a"]).error, /expects a number/);
  assert.match(parseArgs(["--tab", "-2", "text", "h1"]).error, /expects a number/);
});

test("defaults the logs duration and validates it", () => {
  assert.equal(parseArgs(["logs"]).logSeconds, DEFAULT_LOG_SECONDS);
  assert.equal(parseArgs(["logs", "12"]).logSeconds, 12);
  assert.match(parseArgs(["logs", "soon"]).error, /expects a number/);
});

test("recognises help and version", () => {
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["-v"]).version, true);
});

test("hang guard never cuts a longer wait or a longer log window short", () => {
  const long = parseArgs(["--timeout", "60000", "wait", "#a"]);
  assert.equal(hangMsFor({ cmd: "wait", opts: long.opts, logSeconds: 0 }), 65000);

  const logs = parseArgs(["logs", "30"]);
  assert.equal(hangMsFor({ cmd: "logs", opts: logs.opts, logSeconds: 30 }), 35000);

  const quick = parseArgs(["click", "#a"]);
  assert.equal(hangMsFor({ cmd: "click", opts: quick.opts, logSeconds: 0 }), DEFAULT_HANG_MS);
});

test("tries both loopback families, and only the given host otherwise", () => {
  const local = parseArgs(["tabs"]).opts;
  assert.deepEqual(endpoints(local), ["http://127.0.0.1:9222", "http://[::1]:9222"]);

  const remote = parseArgs(["--host", "10.0.0.5", "tabs"]).opts;
  assert.deepEqual(endpoints(remote), ["http://10.0.0.5:9222"]);

  assert.deepEqual(endpoints(local, { CDP_URL: "http://elsewhere:1234" }), [
    "http://elsewhere:1234",
  ]);
});

test("knows which hosts are loopback", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("[::1]"), true);
  assert.equal(isLoopbackHost("10.0.0.5"), false);
});

test("maps named keys to the codes a page listens for", () => {
  assert.deepEqual(keyEvents("ArrowDown"), {
    keyCode: 40,
    code: "ArrowDown",
    text: undefined,
  });
  assert.deepEqual(keyEvents("Enter"), { keyCode: 13, code: "Enter", text: "\r" });
});

test("maps single characters, and refuses unknown names", () => {
  assert.deepEqual(keyEvents("a"), { keyCode: 65, code: "KeyA", text: "a" });
  assert.deepEqual(keyEvents("7"), { keyCode: 55, code: "Digit7", text: "7" });
  assert.match(keyEvents("Banana").error, /unknown key/);
});
