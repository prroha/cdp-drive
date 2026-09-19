// Starting a browser with debugging on, from any platform, without a shell script.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpError, EXIT } from "./errors.mjs";
import { endpoints } from "./cli.mjs";

const READY_POLL_MS = 200;
const READY_TIMEOUT_MS = 20000;
const PROFILE_RELEASE_MS = 1500;

const BROWSER_PATHS = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/brave-browser",
    "/usr/bin/microsoft-edge",
  ],
};

export function findBrowser(env = process.env, platform = process.platform) {
  if (env.CDP_BROWSER) {
    return env.CDP_BROWSER;
  }
  const found = (BROWSER_PATHS[platform] ?? BROWSER_PATHS.linux).find((path) => existsSync(path));
  if (!found) {
    throw new CdpError(
      "no Chromium browser found. Set CDP_BROWSER to the browser's executable path.",
      EXIT.unreachable,
    );
  }
  return found;
}

export function defaultProfile(env = process.env) {
  return env.CDP_PROFILE ?? join(tmpdir(), "cdp-drive-profile");
}

async function portAnswers(opts, env) {
  for (const base of endpoints(opts, env)) {
    try {
      const response = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

// Chromium runs one process per profile directory. A second launch against a
// held profile opens a tab in the old process and silently drops these flags,
// debugging port included, so the holder has to go first.
function releaseProfile(profile, platform) {
  if (platform === "win32") {
    return;
  }
  spawn("pkill", ["-f", `--user-data-dir=${profile}`], { stdio: "ignore" }).unref();
  for (const lock of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    rmSync(join(profile, lock), { force: true });
  }
}

export function browserFlags({ port, profile, headless, extra }) {
  const flags = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (headless) {
    flags.push("--headless=new", "--disable-gpu");
  }
  if (extra) {
    flags.push(...extra.split(" ").filter(Boolean));
  }
  return flags;
}

export async function launchBrowser({ url, opts, env = process.env, platform = process.platform }) {
  const profile = defaultProfile(env);
  const browser = findBrowser(env, platform);

  releaseProfile(profile, platform);
  if (env.CDP_FRESH) {
    rmSync(profile, { recursive: true, force: true });
  }
  mkdirSync(profile, { recursive: true });
  await new Promise((resolve) => setTimeout(resolve, PROFILE_RELEASE_MS));

  // Something else on the port would keep serving while the new browser fails
  // to bind, so commands would land in a browser nobody is looking at.
  if (await portAnswers(opts, env)) {
    throw new CdpError(
      `port ${opts.port} is already serving a DevTools endpoint. ` +
        `Attach to it, quit that browser, or pick another port with --port.`,
    );
  }

  const child = spawn(
    browser,
    [
      ...browserFlags({
        port: opts.port,
        profile,
        headless: Boolean(env.CDP_HEADLESS),
        extra: env.CDP_EXTRA_FLAGS,
      }),
      url,
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await portAnswers(opts, env)) {
      return { browser, profile, port: opts.port };
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  throw new CdpError(
    `${browser} started but the debugging port never answered. ` +
      `On Linux CI or in a container, set CDP_EXTRA_FLAGS="--no-sandbox --disable-dev-shm-usage".`,
    EXIT.unreachable,
  );
}
