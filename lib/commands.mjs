// One handler per command. Each returns what to print:
//   { data } is the machine-readable result, { line } the human line,
//   { confirmation: true } marks a line --quiet may drop.
import { writeFileSync } from "node:fs";
import { keyEvents } from "./cli.mjs";
import { CdpError, EXIT } from "./errors.mjs";
import { fillExpression, framesExpression, snapshotExpression } from "./expressions.mjs";
import {
  collectLogs,
  elementExpression,
  evaluate,
  queryProperty,
  quote,
  waitForSelector,
} from "./page.mjs";

const DEFAULT_SCREENSHOT_PATH = "cdp-shot.png";

function requireArg(value, name) {
  if (value == null || value === "") {
    throw new CdpError(`missing <${name}>. Run cdp-drive --help.`);
  }
  return value;
}

async function pressKey(send, key, mapped) {
  const { keyCode, code, text } = mapped;
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
  await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
}

export const COMMANDS = {
  snapshot: async ({ send, root }) => ({ data: await evaluate(send, snapshotExpression(root)) }),

  frames: async ({ send, root }) => ({ data: await evaluate(send, framesExpression(root)) }),

  text: async ({ send, root, args }) => {
    const selector = requireArg(args[0], "selector");
    const text = await queryProperty(send, root, selector, "innerText");
    return { data: { selector, text }, line: text };
  },

  dom: async ({ send, root, args }) => {
    const selector = requireArg(args[0], "selector");
    const html = await queryProperty(send, root, selector, "outerHTML");
    return { data: { selector, html }, line: html };
  },

  attr: async ({ send, root, args }) => {
    const selector = requireArg(args[0], "selector");
    const attribute = requireArg(args[1], "attribute");
    const value = await evaluate(
      send,
      elementExpression(root, selector, `return el.getAttribute(${quote(attribute)});`),
    );
    return { data: { selector, attribute, value }, line: String(value) };
  },

  click: async ({ send, root, args }) => {
    const selector = requireArg(args[0], "selector");
    await evaluate(send, elementExpression(root, selector, "el.click(); return true;"));
    return { data: { clicked: selector }, line: `clicked ${selector}`, confirmation: true };
  },

  fill: async ({ send, root, args }) => {
    const selector = requireArg(args[0], "selector");
    const value = args[1] ?? "";
    await evaluate(send, fillExpression(root, selector, value));
    return { data: { filled: selector, value }, line: `filled ${selector}`, confirmation: true };
  },

  press: async ({ send, root, args }) => {
    const selector = requireArg(args[0], "selector");
    const key = requireArg(args[1], "key");
    const mapped = keyEvents(key);
    if (mapped.error) {
      throw new CdpError(mapped.error);
    }
    await evaluate(send, elementExpression(root, selector, "el.focus(); return true;"));
    await pressKey(send, key, mapped);
    return {
      data: { pressed: key, selector },
      line: `pressed ${key} on ${selector}`,
      confirmation: true,
    };
  },

  wait: async ({ send, root, args, opts }) => {
    const selector = requireArg(args[0], "selector");
    const found = await waitForSelector(send, root, selector, opts.timeout);
    if (!found) {
      throw new CdpError(
        `timed out after ${opts.timeout}ms waiting for ${selector}`,
        EXIT.timeout,
      );
    }
    return { data: { waited: selector }, line: `found ${selector}`, confirmation: true };
  },

  goto: async ({ send, args }) => {
    const url = requireArg(args[0], "url");
    await send("Page.navigate", { url });
    return { data: { navigating: url }, line: `navigating to ${url}`, confirmation: true };
  },

  reload: async ({ send }) => {
    await send("Page.reload", {});
    return { data: { reloaded: true }, line: "reloaded", confirmation: true };
  },

  eval: async ({ send, args }) => {
    const expression = requireArg(args[0], "expression");
    const value = await evaluate(send, expression);
    return { data: value, line: JSON.stringify(value, null, 2) };
  },

  logs: async ({ socket, send, logSeconds }) => ({
    data: await collectLogs(socket, send, logSeconds),
  }),

  shot: async ({ send, args }) => {
    const path = args[0] ?? DEFAULT_SCREENSHOT_PATH;
    // Chromium renders no frames for a background tab, so raise it first.
    await send("Page.bringToFront").catch(() => {});
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path, Buffer.from(data, "base64"));
    return { data: { screenshot: path }, line: path };
  },
};
