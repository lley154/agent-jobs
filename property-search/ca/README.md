# Property Search

A small personal watcher that searches [realtor.ca](https://www.realtor.ca/mls)
by postal code and prints **only listings it hasn't seen before**. Runs on
**Linux, macOS, and Windows**.

- **It drives your own real Chrome.** realtor.ca is behind Imperva/Incapsula,
  which hard-blocks freshly launched automation browsers ("Access Denied —
  Error 15") — including Playwright's own headless browser. A *real* Chrome that
  you launch yourself (even headless) keeps `navigator.webdriver` false and gets
  through with a profile that has cleared the bot check once. The `watch`
  launcher automates that across all three OSes.
- Captures realtor.ca's own search **JSON API** (`AsyncPropertySearch_Post`) for
  reliable MLS/price/address/link; falls back to DOM scraping only as a last resort.
- Remembers seen listings in **`seen.json`**, keyed by postal code and by each
  listing's stable numeric **Id** (the `…/real-estate/<id>/…` value), so re-runs
  never report false "new" listings.

> Verified end-to-end on Linux. macOS/Windows use the identical mechanism (real
> headless Chrome + CDP); the launcher locates Chrome per-OS. If your Chrome is
> in a non-standard location, set `CHROME_PATH` (see [Environment](#environment)).

## Requirements

- **Node.js 18+** (uses the built-in `fetch`; developed on Node 24).
- **Google Chrome** installed (Chromium also works).

## Install

```bash
cd property-search
npm install
```

## One-time setup: warm the profile

realtor.ca will show a one-time Incapsula check. Clear it by hand once in a real,
visible Chrome window using a **dedicated profile dir** (Chrome 136+ refuses
remote debugging on your default profile, so we never touch it):

| OS | Command |
| --- | --- |
| **Linux** | `google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.realtor-chrome" https://www.realtor.ca/mls` |
| **macOS** | `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/.realtor-chrome" https://www.realtor.ca/mls` |
| **Windows** (PowerShell) | `& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:USERPROFILE\.realtor-chrome" https://www.realtor.ca/mls` |

In that window:
- Solve any **"Pardon Our Interruption"** check.
- If you get a **"realtor.ca wants to know your location"** popup, click **Block**
  (postal search doesn't use geolocation; Chrome remembers the choice).
- Then close the window. The clearance cookies persist in the profile.

> First, sanity-check your IP: if realtor.ca shows **"Access Denied"** in your
> *normal* Chrome, you're on a **VPN/proxy whose IP is blocked** — turn it off.
> No browser approach gets past a blocked IP.

## Usage

The `watch` launcher starts a headless real Chrome with the warmed profile, runs
the search attached to it over CDP, and shuts that Chrome down. Pick whichever
form suits your OS — they all call the same `watch.mjs`:

```bash
node watch.mjs "M5H 1T1"          # any OS
npm run watch -- "M5H 1T1"        # any OS (via package.json)
./watch.sh "M5H 1T1"              # Linux/macOS convenience wrapper
watch.cmd "M5H 1T1"               # Windows convenience wrapper
```

Output is **Markdown** on stdout (status/debug go to stderr), so you can pipe it
straight into a file or a renderer where the listing links are clickable:

```bash
node watch.mjs "M5H 1T1" > listings.md
```

Each run prints a `##` heading with the new/shown counts and date, then one
bullet per new listing — price, the address as a clickable link to the listing,
and its MLS number:

```markdown
## M5H 1T1 — 2 new of 11 shown · 2026-06-13

- **$625,000** — [1509 - 179 METCALFE STREET, Ottawa, Ontario K2P0W1](https://www.realtor.ca/real-estate/29760379/…) — MLS X13135254
```

Re-running reports `0 new` until genuinely new listings appear. Add `--debug` to
see the API-vs-DOM path counts (on stderr).

If the Incapsula clearance eventually expires and a run reports a challenge/block,
just repeat the [warm-up step](#one-time-setup-warm-the-profile) once.

## Manual attach mode (interactive / debugging)

You can also drive a Chrome you started yourself (headed, to watch it work):

1. Launch Chrome with the warm-up command above (leave the window open).
2. Run the watcher against it:
   ```bash
   node realtor-watch.mjs "M5H 1T1" --attach        # connects to localhost:9222
   node realtor-watch.mjs "M5H 1T1" --cdp=URL        # a specific CDP endpoint
   ```

`realtor-watch.mjs` options:

```
  --attach        connect to your Chrome on http://localhost:9222
  --cdp=URL       connect to a specific CDP endpoint
  --debug         print the search URL and API-vs-DOM listing counts
  --headless      launch-mode only — BLOCKED on realtor.ca; use watch.mjs instead
  --profile=DIR   launch-mode persistent profile dir (default ./.profile)
```

### Testing / verifying a change (debug mode)

To confirm a change works end-to-end, drive your **real, warmed Chrome over CDP**
(attach mode) and pass `--debug`. realtor.ca hard-blocks Playwright-launched
browsers, so a fresh automation browser returns "Access Denied — Error 15" and
can't verify anything — you must use a real Chrome with the warmed profile.

```bash
# 1. Is a debug Chrome already serving? (skip step 2 if so)
curl -s http://127.0.0.1:9222/json/version

# 2. If not, launch the warmed Chrome on the DevTools port (leave it running):
google-chrome --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.realtor-chrome" https://www.realtor.ca/mls

# 3. Run the watcher attached to it, with debug output on stderr:
node realtor-watch.mjs "M5H 1T1" --attach --debug

# 4. When done, stop the Chrome you launched:
pkill -f 'remote-debugging-port=9222'
```

A successful run prints, on **stderr**:

```
Settings: propertyType=residential priceMin=0 priceMax=0 (filters reserved — not yet applied)
[debug] attach mode: using existing page as-is (https://www.realtor.ca/mls)
[debug] API returned 11 listings
```

followed by the Markdown listing block on **stdout** (exit code `0`). The
`Settings:` line confirms the job read `job.settings.json` from its working
directory.

> A real run records the listings in `seen.json`, so an immediate re-run reports
> `0 new` for that postal until genuinely new listings appear. Delete `seen.json`
> to reset for repeat testing.

### How the search works (and the map "nudge")

In attach mode the watcher **does not navigate** — programmatic page loads raise
Incapsula's bot score. It types the postal code into realtor.ca's own search box
(`#nf_search_input` on `/mls`, `#txtMapSearchInput` on `/map`) and presses Enter,
which fires `AsyncPropertySearch_Post`. realtor.ca only re-queries when the map
**location changes**, so if the page is already parked on your target postal, the
watcher briefly searches a far-away location (`NUDGE_QUERY`, default Vancouver)
and re-searches your target. `watch.mjs` sidesteps this entirely by starting each
run fresh on the stable `/mls` landing page.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `CHROME_PATH` | auto-detected | Full path to the Chrome/Chromium binary |
| `REALTOR_CHROME_PROFILE` | `~/.realtor-chrome` | Dedicated profile dir |
| `REALTOR_CHROME_PORT` | `9222` | DevTools remote-debugging port |
| `REALTOR_UA` | derived from Chrome | User-agent string |

## Credentials (usually not needed)

Public postal-code search works anonymously. Credentials are only used if
realtor.ca ever forces a login wall. If that happens, copy `.env.example` to
`.env` (gitignored) and set `REALTOR_USER` / `REALTOR_PASS`.

## If realtor.ca changes (re-discovering selectors / API)

The selectors/API were confirmed live but drift over time. To re-confirm, attach
to a debug Chrome and inspect, or use the `playwright-cli` skill. The values the
script depends on:

- `SEARCH_INPUT_SELECTORS` — `#nf_search_input` (/mls), `#txtMapSearchInput` (/map),
  with placeholder-based fallbacks. First visible match wins.
- `API_PATTERN` — matches `…/Listing.svc/AsyncPropertySearch_Post`.
- `normalizeApiRecord()` — maps each `Results[]` record to
  `{ id, mls, address, price, url }` (id ← `Id`, mls ← `MlsNumber`,
  price ← `Property.Price`, address ← `Property.Address.AddressText`,
  url ← `RelativeDetailsURL`).

## Job manifest (`job.settings.json`)

For an agent to run this job, its working directory must contain a
`job.settings.json` manifest (see the [repo-level README](../README.md) for the
convention). The agent reads `program[os]` to pick the executable and runs it
with `args`, appending the search location:

```jsonc
{
  "program": { "linux": "watch.sh", "macos": "watch.sh", "windows": "watch.cmd" },
  "args": ["--headless"],            // agent appends the postal code, e.g. … "M5H 1T1"
  "settings": {                      // program-defined; read by realtor-watch.mjs
    "propertyType": "residential",
    "priceMin": 0,                   // 0 = unbounded
    "priceMax": 0                    // 0 = unbounded
  }
}
```

`realtor-watch.mjs` reads the `settings` block from this file at startup (run
with `--debug` to see the active values on stderr). The `propertyType` /
`priceMin` / `priceMax` filters are **reserved** — surfaced to the program but
not yet applied to the realtor.ca search.

## Files

| File | Role |
| --- | --- |
| `watch.mjs` | Cross-platform launcher: starts headless Chrome, runs the watcher, cleans up |
| `watch.sh` / `watch.cmd` | Thin per-OS wrappers around `watch.mjs` |
| `realtor-watch.mjs` | The watcher itself (search → capture API → dedup → print) |
| `job.settings.json` | Manifest an agent reads to launch the job (program, args, settings) |
| `seen.json` | Per-postal record of seen listing Ids (delete to reset) |

## Notes

- This is a low-frequency personal tool with human-speed pacing — not a bulk
  scraper. Respect realtor.ca's terms and rate limits.
