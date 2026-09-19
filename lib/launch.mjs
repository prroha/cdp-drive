// Starting a browser with debugging on, from any platform, without a shell script.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpError, EXIT } from "./errors.mjs";
import { endpoints } from "./cli.mjs";

const READY_POLL_MS = 200;
const READY_TIMEOUT_MS = 20000;
const HOLDER_EXIT_POLL_MS = 100;
const HOLDER_EXIT_TIMEOUT_MS = 3000;
const PORT_PROBE_MS = 1000;
const SINGLETON_FILES = ["SingletonLock", "SingletonCookie", "SingletonSocket"];

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
    "/usr/bin/google-chrome-stable",
    "/opt/google/chrome/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/usr/bin/brave-browser",
    "/usr/bin/microsoft-edge",
  ],
};

const BROWSER_COMMANDS = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "brave-browser",
  "microsoft-edge",
];

// Installs outside the standard directories (snap, Nix, Homebrew) are still on PATH.
function browserOnPath(platform) {
  if (platform === "win32") {
    return null;
  }
  for (const command of BROWSER_COMMANDS) {
    try {
      const path = execFileSync("command", ["-v", command], { shell: true, encoding: "utf8" });
      const trimmed = path.trim();
      if (trimmed) {
        return trimmed;
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function findBrowser(env = process.env, platform = process.platform) {
  if (env.CDP_BROWSER) {
    if (!existsSync(env.CDP_BROWSER)) {
      throw new CdpError(`CDP_BROWSER is set to ${env.CDP_BROWSER}, which does not exist.`);
    }
    return env.CDP_BROWSER;
  }
  const known = (BROWSER_PATHS[platform] ?? BROWSER_PATHS.linux).find((path) => existsSync(path));
  const found = known ?? browserOnPath(platform);
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
      const response = await fetch(`${base}/json/version`, {
        signal: AbortSignal.timeout(PORT_PROBE_MS),
      });
      if (response.ok) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

// Compare the flag as a whole token: a substring match would kill a browser on
// /tmp/p2 when this profile is /tmp/p.
export function profileHolders(processLines, profile) {
  const flag = `--user-data-dir=${profile}`;
  return processLines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pid, ...rest] = line.split(/\s+/);
      return { pid: Number(pid), tokens: rest };
    })
    .filter((entry) => Number.isFinite(entry.pid) && entry.tokens.includes(flag))
    .map((entry) => entry.pid);
}

function listProcesses() {
  try {
    return execFileSync("pgrep", ["-af", "--", "--user-data-dir="], { encoding: "utf8" }).split("\n");
  } catch {
    return [];
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Chromium runs one process per profile directory. A second launch against a
// held profile opens a tab in the old process and silently drops these flags,
// debugging port included, so the holder has to go first.
async function releaseProfile(profile, platform) {
  if (platform === "win32") {
    return;
  }
  const holders = profileHolders(listProcesses(), profile);
  for (const pid of holders) {
    try {
      process.kill(pid);
    } catch {
      continue;
    }
  }
  const deadline = Date.now() + HOLDER_EXIT_TIMEOUT_MS;
  while (holders.some(isRunning) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, HOLDER_EXIT_POLL_MS));
  }
  // Only now are these files stale; removing them under a live browser would
  // leave two processes sharing one profile.
  if (!holders.some(isRunning)) {
    for (const file of SINGLETON_FILES) {
      rmSync(join(profile, file), { force: true });
    }
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

  await releaseProfile(profile, platform);
  if (env.CDP_FRESH) {
    rmSync(profile, { recursive: true, force: true });
  }
  mkdirSync(profile, { recursive: true });

  // Something else on the port would keep serving while the new browser fails
  // to bind, so commands would land in a browser nobody is looking at.
  if (await portAnswers(opts, env)) {
    throw new CdpError(
      `port ${opts.port} is already serving a DevTools endpoint. ` +
        `Attach to it, quit that browser, or pick another port with --port.`,
    );
  }

  const flags = browserFlags({
    port: opts.port,
    profile,
    headless: Boolean(env.CDP_HEADLESS),
    extra: env.CDP_EXTRA_FLAGS,
  });
  const child = spawn(browser, [...flags, url], { detached: true, stdio: "ignore" });
  let spawnError = null;
  child.on("error", (error) => {
    spawnError = error;
  });
  child.unref();

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawnError) {
      throw new CdpError(`could not start ${browser}: ${spawnError.message}`, EXIT.unreachable);
    }
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
