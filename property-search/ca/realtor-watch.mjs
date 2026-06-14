#!/usr/bin/env node
/**
 * realtor-watch.mjs — watch realtor.ca/mls for NEW listings by postal code.
 *
 * WHY IT'S BUILT THIS WAY
 * -----------------------
 * - realtor.ca is heavily bot-protected. We use a PERSISTENT browser profile
 *   (./.profile) so a challenge solved once in head mode carries over, and we
 *   drive a real Chrome channel at human-ish speed.
 * - We prefer the SITE'S OWN JSON API over scraping markup. The postal-code
 *   search drives `POST .../Listing.svc/PropertySearch_Post`, whose response
 *   carries every field we need (MLS, address, price, details URL). Capturing
 *   that response is far more stable than parsing listing-card HTML; a DOM
 *   scrape is wired as a fallback.
 * - Seen MLS numbers are stored in ./seen.json (keyed by postal code) so each
 *   run reports only listings not seen before.
 *
 * USAGE
 *   node realtor-watch.mjs <POSTAL_CODE> [--headless] [--profile=DIR] [--debug]
 *
 *   node realtor-watch.mjs "M5V 2T6"             # headed (default): setup/debug
 *   node realtor-watch.mjs "M5V 2T6" --headless  # unattended repeat runs
 *
 * Run HEADED the first time so you can solve any one-time challenge by hand;
 * the persistent profile remembers it for later --headless runs.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const MLS_URL = "https://www.realtor.ca/mls";
// realtor.ca's internal search API; the response holds the listing records.
// Confirmed live: the map view fires GET .../Listing.svc/AsyncPropertySearch_Post.
const API_PATTERN = /Listing\.svc\/(?:Async)?PropertySearch_Post/i;
const BROWSER_CHANNEL = "chrome"; // installed Google Chrome; set null for bundled Chromium
// A far-away location used only to force a map move when the page is already
// parked on the target (realtor.ca re-queries the listing API only on a change).
const NUDGE_QUERY = "Vancouver, BC";
const SLOW_MO_MS = 200;
const NAV_TIMEOUT = 60_000;
const RESULTS_TIMEOUT = 45_000;

// Candidate selectors for the postal-code / location search box. The first one
// that is found and visible wins. Confirm/extend these from a head-mode session
// (see README "Discovering selectors").
// Confirmed live (placeholder "City, Neighbourhood, Address or MLS® number"):
//   /mls landing page -> #nf_search_input
//   /map view         -> #txtMapSearchInput
const SEARCH_INPUT_SELECTORS = [
  "#nf_search_input",
  "#txtMapSearchInput",
  "input[placeholder*='MLS' i]",
  "input[placeholder*='Address' i]",
  "input[placeholder*='City' i]",
  "input[type='search']",
];

// realtor.ca sits behind Imperva/Incapsula, which injects a hidden
// `_Incapsula_Resource` iframe on EVERY page for its invisible JS check — so the
// mere presence of that iframe is NOT a challenge. Detect the real interactive
// challenge by its on-screen TEXT (across all frames) instead.
const CHALLENGE_HINTS = [
  "additional security check is required",
  "actual human and not a robot",
  "i'm not a robot",
  "verify you are a human",
  "pardon our interruption",
  "access to this page has been denied",
  "px-captcha",
];
// Terminal block (not a solvable challenge) — usually a flagged IP/VPN or an
// automation fingerprint. No point waiting; bail with guidance.
const HARD_BLOCK_HINTS = [
  "Access Denied",
  "Error 15",
  "blocked by our security service",
];

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    headless: false,
    profile: resolve(__dirname, ".profile"),
    debug: false,
    cdp: null,
  };
  const positional = [];
  for (const arg of argv) {
    if (arg === "--headless") opts.headless = true;
    else if (arg === "--debug") opts.debug = true;
    else if (arg === "--attach") opts.cdp = "http://localhost:9222";
    else if (arg.startsWith("--cdp=")) opts.cdp = arg.slice("--cdp=".length);
    else if (arg.startsWith("--profile=")) opts.profile = resolve(arg.slice("--profile=".length));
    else if (arg.startsWith("--")) {
      console.error(`Unknown option: ${arg}`);
      process.exit(2);
    } else positional.push(arg);
  }
  opts.postalCode = positional.join(" ").trim();
  return opts;
}

function usage() {
  console.error(
    "Usage: node realtor-watch.mjs <POSTAL_CODE> [--attach|--cdp=URL] [--headless] [--profile=DIR] [--debug]\n" +
      '  e.g. node realtor-watch.mjs "M5V 2T6"            # launch own browser\n' +
      '       node realtor-watch.mjs "M5V 2T6" --attach   # drive your real Chrome on :9222',
  );
}

// ---------------------------------------------------------------------------
// Seen store (./seen.json, keyed by postal code)
// ---------------------------------------------------------------------------
const SEEN_PATH = resolve(__dirname, "seen.json");

function loadSeen() {
  if (!existsSync(SEEN_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SEEN_PATH, "utf8"));
  } catch {
    console.warn("seen.json was unreadable; starting fresh.");
    return {};
  }
}

function saveSeen(store) {
  writeFileSync(SEEN_PATH, JSON.stringify(store, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Job manifest settings (./job.settings.json)
// ---------------------------------------------------------------------------
// The manifest lives beside this script in the job's working directory. We read
// its `settings` block so a calling agent can pass program-defined options.
// Best-effort: a missing or invalid file just yields the defaults below.
// NOTE: these filters are RESERVED — they are surfaced (and logged with --debug)
// but not yet applied to the realtor.ca search (see job.settings.json `_comment`).
const JOB_SETTINGS_PATH = resolve(__dirname, "job.settings.json");

function loadSettings() {
  const defaults = { propertyType: "residential", priceMin: 0, priceMax: 0 };
  if (!existsSync(JOB_SETTINGS_PATH)) return defaults;
  try {
    const { settings } = JSON.parse(readFileSync(JOB_SETTINGS_PATH, "utf8")) ?? {};
    return { ...defaults, ...(settings ?? {}) };
  } catch {
    console.warn("job.settings.json was unreadable; using default settings.");
    return defaults;
  }
}

// ---------------------------------------------------------------------------
// Listing extraction
// ---------------------------------------------------------------------------
/**
 * Normalize one record from the PropertySearch_Post JSON `Results` array.
 * Field names follow realtor.ca's documented API shape; missing fields degrade
 * gracefully to "?".
 */
function normalizeApiRecordSafe(r) {
  try {
    return normalizeApiRecord(r);
  } catch {
    return null;
  }
}

export function normalizeApiRecord(r) {
  const prop = r.Property || {};
  const addr = prop.Address || {};
  const rel = r.RelativeDetailsURL || prop.RelativeDetailsURL || "";
  // Dedup on the numeric listing Id: it's stable and appears in BOTH the API
  // (r.Id) and the details URL (/real-estate/<id>/…) the DOM fallback reads, so
  // the two extraction paths agree. MlsNumber is kept only for display.
  const id = r.Id || (rel.match(/\/real-estate\/(\d+)\//) || [])[1] || r.MlsNumber || null;
  if (!id) return null;
  const price = prop.Price || prop.LeaseRentPrice || "?";
  const address = addr.AddressText ? addr.AddressText.replace(/\|/g, ", ") : "?";
  const url = rel ? `https://www.realtor.ca${rel.startsWith("/") ? "" : "/"}${rel}` : "";
  return { id: String(id), mls: String(r.MlsNumber || id), address, price, url };
}

/** Pull listing records out of whatever the API returned. */
export function listingsFromApi(json) {
  const results = json?.Results || json?.results || [];
  if (!Array.isArray(results)) return [];
  return results.map(normalizeApiRecordSafe).filter(Boolean);
}

/** Fallback: scrape listing cards from the DOM. Keyed on the numeric listing
 *  Id from the details URL, to match the API path. Address/price are best-effort
 *  (the DOM is far less reliable than the API; the MLS number isn't in markup). */
async function listingsFromDom(page) {
  return page.evaluate(() => {
    const clean = (t) => {
      const s = (t || "").trim();
      return s && s.toLowerCase() !== "false" ? s : "?";
    };
    const out = [];
    const anchors = document.querySelectorAll('a[href*="/real-estate/"]');
    const seen = new Set();
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/\/real-estate\/(\d+)\//);
      if (!m) continue;
      const id = m[1];
      if (seen.has(id)) continue;
      seen.add(id);
      const card = a.closest("[class*='cardCon'], [class*='listingCard'], .card, li, article") || a;
      const priceEl = card.querySelector("[class*='price' i]");
      const addrEl = card.querySelector("[class*='address' i]");
      out.push({
        id,
        mls: id, // MLS number isn't exposed in markup; Id is the stable key
        address: clean(addrEl?.textContent),
        price: clean(priceEl?.textContent),
        url: new URL(href, "https://www.realtor.ca").href,
      });
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------
/** Lowercased title+body text across the top document and every child frame. */
async function frameTextHaystack(page) {
  const texts = await Promise.all(
    page.frames().map((f) =>
      f
        .evaluate(() => `${document.title}\n${document.body?.innerText || ""}`)
        .catch(() => ""),
    ),
  );
  return texts.join("\n").toLowerCase();
}

async function looksLikeChallenge(page) {
  // Text-only: scan title + body of the top doc and every child frame for the
  // interactive-challenge wording. (The invisible Incapsula iframe is ignored.)
  const hay = await frameTextHaystack(page);
  return CHALLENGE_HINTS.some((h) => hay.includes(h));
}

/** A terminal "Access Denied / Error 15" block — not solvable by waiting. */
async function isHardBlocked(page) {
  const hay = await frameTextHaystack(page);
  return HARD_BLOCK_HINTS.some((h) => hay.includes(h.toLowerCase()));
}

async function findSearchBox(page) {
  for (const sel of SEARCH_INPUT_SELECTORS) {
    const loc = page.locator(sel).first();
    try {
      await loc.waitFor({ state: "visible", timeout: 4000 });
      return loc;
    } catch {
      /* try next */
    }
  }
  return null;
}

function waitForApiResponse(page, timeoutMs = RESULTS_TIMEOUT) {
  // Resolves with parsed JSON of the first matching search response, or null on
  // timeout. Cleans up its own listener so it's safe to call once per attempt.
  return new Promise((resolvePromise) => {
    let settled = false;
    let timer;
    const done = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      page.off("response", handler);
      resolvePromise(val);
    };
    const handler = async (res) => {
      if (!API_PATTERN.test(res.url())) return;
      try {
        done(await res.json());
      } catch {
        /* not JSON / aborted; keep waiting for a better one */
      }
    };
    page.on("response", handler);
    timer = setTimeout(() => done(null), timeoutMs);
  });
}

// Type a query into the search box (clearing first) and submit, human-like.
async function submitSearch(page, box, value) {
  await box.click();
  await box.fill("");
  await box.pressSequentially(value, { delay: 60 });
  await page.waitForTimeout(1200); // let the autocomplete register
  await box.press("Enter");
}

// Submit a search and capture the resulting listing-API JSON (or null).
async function searchAndCapture(page, box, value, timeoutMs) {
  const apiPromise = waitForApiResponse(page, timeoutMs);
  await submitSearch(page, box, value);
  return apiPromise;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.postalCode) {
    usage();
    process.exit(2);
  }

  // Program-defined options from the job manifest. Surfaced for the caller and
  // logged in debug; filtering against these is reserved for future work.
  opts.settings = loadSettings();
  if (opts.debug) {
    const { propertyType, priceMin, priceMax } = opts.settings;
    console.error(
      `Settings: propertyType=${propertyType} priceMin=${priceMin} priceMax=${priceMax} ` +
        "(filters reserved — not yet applied)",
    );
  }

  const seen = loadSeen();
  const bucket = (seen[opts.postalCode] ||= {});

  // Two ways to get a page:
  //   --attach / --cdp=URL : drive the user's OWN already-running Chrome over
  //     CDP. This is a real browser (no automation flags, navigator.webdriver
  //     is false), so Imperva/Incapsula is far less likely to block it.
  //   default              : launch our own persistent-profile browser.
  let context, page;
  let browser = null;
  if (opts.cdp) {
    browser = await chromium.connectOverCDP(opts.cdp);
    context = browser.contexts()[0] || (await browser.newContext());
    const pages = context.pages();
    page = pages.find((p) => /realtor\.ca/i.test(p.url())) || pages[0] || (await context.newPage());
  } else {
    context = await chromium.launchPersistentContext(opts.profile, {
      headless: opts.headless,
      channel: BROWSER_CHANNEL || undefined,
      slowMo: SLOW_MO_MS,
      viewport: { width: 1400, height: 900 },
    });
    page = context.pages()[0] || (await context.newPage());
  }
  context.setDefaultTimeout(NAV_TIMEOUT);

  let exitCode = 0;
  try {
    // Navigation policy: programmatic goto/reload raises Imperva/Incapsula's bot
    // score and gets you challenged or blocked. In ATTACH mode we therefore use
    // the page exactly as the user left it (only navigating if it isn't on
    // realtor.ca at all) and rely on human-like typing + Enter to move. In LAUNCH
    // mode we have no choice but to navigate.
    if (!opts.cdp) {
      await page.goto(MLS_URL, { waitUntil: "domcontentloaded" });
    } else if (!/realtor\.ca/i.test(page.url())) {
      await page.goto(MLS_URL, { waitUntil: "domcontentloaded" });
    } else if (opts.debug) {
      console.error(`[debug] attach mode: using existing page as-is (${page.url()})`);
    }

    if (await isHardBlocked(page)) {
      throw new Error(
        "realtor.ca returned a hard block (Access Denied / Error 15).\n" +
          "This is almost always a flagged IP — if you're on a VPN or proxy, turn it\n" +
          "off and retry. If your everyday Chrome also can't load realtor.ca, the IP\n" +
          "is the problem, not the script.",
      );
    }

    if (await looksLikeChallenge(page)) {
      if (opts.headless) {
        console.error(
          "\nBlocked by realtor.ca's bot challenge in headless mode.\n" +
            "Re-run once HEADED to solve it by hand — the ./.profile directory will\n" +
            "remember the clearance for future --headless runs:\n" +
            `  node realtor-watch.mjs "${opts.postalCode}"\n`,
        );
        await context.close();
        process.exit(3);
      }
      console.log(
        "\nAn Imperva/Incapsula challenge is showing. Solve it by hand in the\n" +
          "browser window. Waiting up to 3 minutes for the search page to return…",
      );
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        if (!(await looksLikeChallenge(page))) break;
        await page.waitForTimeout(2000);
      }
      if (await looksLikeChallenge(page)) {
        throw new Error("Challenge was not cleared in time. Solve it in the window and re-run.");
      }
      // Let the app settle after the challenge clears.
      await page.waitForLoadState("domcontentloaded").catch(() => {});
    }

    if (opts.debug) console.error(`[debug] before search, url=${page.url()}`);
    const box = await findSearchBox(page);
    if (!box) {
      throw new Error(
        "Could not locate the search input. Run a head-mode session and update " +
          "SEARCH_INPUT_SELECTORS (see README 'Discovering selectors').",
      );
    }

    // Search the target postal and capture the listing API response.
    // realtor.ca only re-fires the API when the map location CHANGES, so if the
    // page is already parked on this postal the first search returns no fresh
    // data. In that case we nudge the map to a different location and re-search
    // the target, guaranteeing a fresh AsyncPropertySearch_Post each run.
    let json = await searchAndCapture(page, box, opts.postalCode);
    if (!json) {
      if (opts.debug) console.error("[debug] no fresh API response — nudging to force a re-query");
      await searchAndCapture(page, box, NUDGE_QUERY, 15_000).catch(() => null);
      json = await searchAndCapture(page, box, opts.postalCode);
    }

    let listings = [];
    if (json) {
      listings = listingsFromApi(json);
      if (opts.debug) console.error(`[debug] API returned ${listings.length} listings`);
    } else {
      // Last resort: read whatever the current view shows (Id-keyed, so dedup is
      // still correct — at worst this misses brand-new listings, never invents).
      listings = await listingsFromDom(page);
      if (opts.debug) console.error(`[debug] DOM scrape returned ${listings.length} listings`);
    }

    // Dedup against what we've seen for this postal code (keyed on listing Id).
    const now = new Date().toISOString();
    const fresh = listings.filter((l) => !(l.id in bucket));

    // Markdown output on stdout (debug/status go to stderr), so it can be piped
    // straight into a .md file or a renderer where the links are clickable.
    const day = now.slice(0, 10);
    console.log(
      `#### ${opts.postalCode} — ${fresh.length} new of ${listings.length} shown · ${day}`,
    );
    console.log("");
    if (fresh.length === 0) {
      console.log("_No new listings._");
    } else {
      for (const l of fresh) {
        const where = l.url ? `[${l.address}](${l.url})` : l.address;
        console.log(`- **${l.price}** — ${where} — MLS ${l.mls}`);
        bucket[l.id] = now;
      }
      saveSeen(seen);
    }
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    exitCode = 1;
  } finally {
    if (opts.cdp) {
      // Attached to the user's real browser — just drop our CDP connection,
      // leave their Chrome and tabs running.
      await browser.close().catch(() => {});
    } else {
      await context.close();
    }
  }
  process.exit(exitCode);
}

// Only drive the browser when run directly (not when imported for tests).
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
