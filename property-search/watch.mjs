#!/usr/bin/env node
/**
 * watch.mjs — cross-platform (Linux / macOS / Windows) headless launcher.
 *
 * realtor.ca blocks Playwright-launched headless browsers, but lets through a
 * REAL Chrome that you launch yourself in headless mode (navigator.webdriver
 * stays false) using a profile that has already cleared Incapsula. This launcher:
 *   1. finds the installed Chrome for this OS,
 *   2. starts it headless on the DevTools port with the warmed profile,
 *   3. runs realtor-watch.mjs attached to it over CDP,
 *   4. shuts that Chrome down.
 *
 * Usage:   node watch.mjs "M5H 1T1" [--debug]
 *
 * One-time setup: warm the profile by clearing Incapsula once, headed (see README).
 *
 * Env overrides:
 *   CHROME_PATH               full path to the Chrome/Chromium binary
 *   REALTOR_CHROME_PROFILE    profile dir (default: ~/.realtor-chrome)
 *   REALTOR_CHROME_PORT       DevTools port (default: 9222)
 *   REALTOR_UA                full user-agent string to use
 */

import { spawn, execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- args -----------------------------------------------------------------
const argv = process.argv.slice(2);
const passthrough = argv.filter((a) => a.startsWith("--")); // forwarded to realtor-watch.mjs
const postal = argv.filter((a) => !a.startsWith("--")).join(" ").trim();
if (!postal) {
  console.error('Usage: node watch.mjs "A1A 1A1" [--debug]');
  process.exit(2);
}

const PORT = process.env.REALTOR_CHROME_PORT || "9222";
const PROFILE = process.env.REALTOR_CHROME_PROFILE || join(homedir(), ".realtor-chrome");
const CDP = `http://127.0.0.1:${PORT}`;

// ---- locate Chrome --------------------------------------------------------
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = {
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ],
    win32: [
      join(process.env.PROGRAMFILES || "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
      join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
      join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
    ],
    linux: [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
    ],
  }[platform()] || [];
  return candidates.find((p) => p && existsSync(p)) || null;
}

// ---- build an OS-appropriate, non-headless user-agent ---------------------
function userAgent(bin) {
  if (process.env.REALTOR_UA) return process.env.REALTOR_UA;
  let major = "145";
  try {
    // chrome --version prints reliably on macOS/Linux; on Windows it often
    // doesn't, so we just fall back to the default major below.
    const m = execFileSync(bin, ["--version"], { encoding: "utf8" }).match(/(\d+)\./);
    if (m) major = m[1];
  } catch {
    /* keep default */
  }
  const os =
    platform() === "darwin"
      ? "Macintosh; Intel Mac OS X 10_15_7"
      : platform() === "win32"
        ? "Windows NT 10.0; Win64; x64"
        : "X11; Linux x86_64";
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

async function cdpUp() {
  try {
    const res = await fetch(`${CDP}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

function killChrome(proc) {
  if (!proc || proc.exitCode !== null) return;
  if (platform() === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"]);
    } catch {
      /* ignore */
    }
  } else {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
}

// ---- main -----------------------------------------------------------------
const bin = findChrome();
if (!bin) {
  console.error(
    "Could not find Google Chrome. Install it, or set CHROME_PATH to the binary, e.g.\n" +
      '  macOS:   export CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"\n' +
      '  Windows: set CHROME_PATH=C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  );
  process.exit(2);
}

let chrome = null;
const launchedHere = !(await cdpUp());

if (launchedHere) {
  // Clear stale single-instance locks so the profile can be opened.
  for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try {
      rmSync(join(PROFILE, f), { force: true });
    } catch {
      /* ignore */
    }
  }
  console.log(`Starting headless Chrome on port ${PORT} (profile: ${PROFILE})…`);
  chrome = spawn(
    bin,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      `--user-agent=${userAgent(bin)}`,
      "--window-size=1400,900", // avoid realtor.ca's responsive layout hiding the search box
      "https://www.realtor.ca/mls",
    ],
    { stdio: "ignore" },
  );
  // Make sure Chrome dies with us even on Ctrl-C / crash.
  const cleanup = () => killChrome(chrome);
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  let ready = false;
  for (let i = 0; i < 40; i++) {
    if (await cdpUp()) {
      ready = true;
      break;
    }
    await sleep(500);
  }
  if (!ready) {
    killChrome(chrome);
    console.error("Chrome did not expose its DevTools port in time.");
    process.exit(1);
  }
  await sleep(3000); // let the /mls landing page render the search box
} else {
  console.log(`Reusing Chrome already serving on port ${PORT}.`);
}

// Run the watcher attached over CDP, inheriting stdio so its output shows.
const watcher = spawn(
  process.execPath,
  [join(__dirname, "realtor-watch.mjs"), postal, `--cdp=${CDP}`, ...passthrough],
  { stdio: "inherit" },
);
const status = await new Promise((res) => watcher.on("exit", (code) => res(code ?? 1)));

if (launchedHere) killChrome(chrome);
process.exit(status);
