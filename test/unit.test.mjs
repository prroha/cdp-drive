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
import { browserFlags, findBrowser, profileHolders } from "../lib/launch.mjs";

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

test("takes the browser from the environment, and checks it exists", () => {
  assert.equal(findBrowser({ CDP_BROWSER: process.execPath }), process.execPath);
  assert.throws(() => findBrowser({ CDP_BROWSER: "/tmp/nothing-here" }), /does not exist/);
});

test("builds browser flags, headless and extras included", () => {
  const plain = browserFlags({ port: "9222", profile: "/tmp/p" });
  assert.deepEqual(plain, [
    "--remote-debugging-port=9222",
    "--user-data-dir=/tmp/p",
    "--no-first-run",
    "--no-default-browser-check",
  ]);

  const extended = browserFlags({
    port: "9333",
    profile: "/tmp/p",
    headless: true,
    extra: "--no-sandbox --disable-dev-shm-usage",
  });
  assert.ok(extended.includes("--headless=new"));
  assert.ok(extended.includes("--no-sandbox"));
  assert.ok(extended.includes("--disable-dev-shm-usage"));
});

test("matches a profile holder by whole token, not by substring", () => {
  const lines = [
    "111 /usr/bin/chrome --user-data-dir=/tmp/p --headless=new",
    "222 /usr/bin/chrome --user-data-dir=/tmp/p2",
    "333 /usr/bin/chrome --user-data-dir=/tmp/p-other",
    "not a process line",
  ];
  assert.deepEqual(profileHolders(lines, "/tmp/p"), [111]);
  assert.deepEqual(profileHolders(lines, "/tmp/p2"), [222]);
  assert.deepEqual(profileHolders(lines, "/tmp/missing"), []);
});

test("reads the leading-whitespace pid column that ps prints", () => {
  const lines = ["  692 /Applications/Brave.app/Contents/MacOS/Brave --user-data-dir=/tmp/p"];
  assert.deepEqual(profileHolders(lines, "/tmp/p"), [692]);
});

test("matches a profile passed as a separate argument", () => {
  const lines = ["111 /usr/bin/chrome --user-data-dir /tmp/p --headless=new"];
  assert.deepEqual(profileHolders(lines, "/tmp/p"), [111]);
  assert.deepEqual(profileHolders(lines, "/tmp"), []);
});

test("lists every process holding the profile, not just the first", () => {
  const lines = [
    "111 /usr/bin/chrome --user-data-dir=/tmp/p",
    "112 /usr/bin/chrome --type=renderer --user-data-dir=/tmp/p",
  ];
  assert.deepEqual(profileHolders(lines, "/tmp/p"), [111, 112]);
});

test("accepts a value beginning with dashes through the equals form", () => {
  const parsed = parseArgs(["--page=--odd-title", "snapshot"], {});
  assert.equal(parsed.opts.page, "--odd-title");
  assert.equal(parsed.cmd, "snapshot");
});

test("keeps an equals sign that belongs to the value", () => {
  assert.deepEqual(parseArgs(["--frame=iframe[src*=a=b]", "snapshot"], {}).frames, ["iframe[src*=a=b]"]);
});

test("rejects a timeout or port of zero", () => {
  assert.match(parseArgs(["--timeout", "0", "wait", ".x"], {}).error, /at least 1/);
  assert.match(parseArgs(["--port", "0"], {}).error, /at least 1/);
});

test("every rejection still carries options so errors can honour --json", () => {
  for (const argv of [["--port", "abc"], ["--page"], ["logs", "-1"], ["--tab", "x"]]) {
    assert.ok(parseArgs([...argv, "--json"], {}).opts, `${argv} lost opts`);
  }
});

test("gives launch a guard long enough for a cold browser start", () => {
  const opts = parseArgs(["launch"]).opts;
  assert.equal(hangMsFor({ cmd: "launch", opts, logSeconds: 0 }), 45000);
});
