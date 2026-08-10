# tb scraping & resilience improvements — design spec

**Date:** 2026-08-10
**Branch:** `feat/scraping-resilience`
**Status:** approved for implementation

## Context

A real bulk-scraping job (62 AliExpress product pages → structured CSV) exposed concrete
gaps in tb. Every item below is something we *hit*, not speculation:

- **Headless Chrome is silently blocked** by AliExpress's Baxia fingerprint check — the
  product body never hydrates (~1199 chars, `punish` in HTML, empty `runParams`). A
  **visible** window passes. But tb has no `--visible` CLI flag, even though the daemon
  supports `visible:true`. We had to reach it via the raw daemon socket.
- **`goto` hardcodes `status: 200`** (`session.ts:627`) — a captcha/punish page reports
  success, so blocks are invisible to callers. We had to write block detection by hand.
- **Multiple daemons race the socket** — concurrent `tb` calls spawned duplicate
  `daemon.ts --daemon` processes, causing intermittent "Session not found".
- **The fingerprint is self-sabotaged**: `navigator.userAgentData.brands` is `[]` and
  `platform` is `""` (UA override sent without `userAgentMetadata`) — an impossible
  combination for a real browser; UA string says Chrome/148 while the binary is 151;
  several "stealth" patches are dead code that *add* detectable artifacts
  (`Function.prototype.toString` guard never populates its set; `attachShadow` patch is a
  no-op that de-natives the function; only WebGL1 is patched, not WebGL2).
- **No resumable multi-URL scraper**: `batch`/`pipe`/`workflow` can't take an external URL
  list with per-item checkpointing, jitter, and a circuit breaker. We wrote a whole Python
  driver that tb should have made unnecessary.
- **`tb extract` is textContent-only** — can't return `img@src` or `a@href`.
- **No in-repo engineering memory**: no `CLAUDE.md`. Future sessions re-learn all of the above.

## Goal

Make tb genuinely good at "open many pages, survive bot defenses, pull structured data" —
and make the tooling **discoverable** so a future Claude session knows *when, why, and how*
to use each path without rediscovering it.

## Command surface (added)

```
tb open <url> --visible          # headful window — anti-bot escape hatch
tb wait --settled [--timeout ms] # block until page content stops changing (hydrating SPAs)
tb blocked                       # → {blocked, reason}: is this a captcha/punish/x5sec page?
tb extract '{"img":"img@src"}'   # NEW: sel@attr returns the attribute; plain sel still text
tb harvest <urls-file>           # resumable bulk scraper
     --recipe <file.js>          #   per-site extractor (or --schema '{...}' selector map)
     --out <file.jsonl>          #   checkpoint after every page (resumable: skips done)
     [--visible] [--jitter a,b]  #   jittered delay · circuit-breaker on persistent block
     [--settle] [--timeout ms]
```

## Interface contract (this is what makes parallel work safe)

Files are partitioned so **each agent owns a disjoint set**. The only cross-file seams are
these — every agent codes to these exact names/shapes:

**`session.ts` (owner B) exposes:**
- `goto(url)` → `{ status: number, url: string, blocked: boolean }`
  (real `status` from the main-frame `Network.responseReceived`; `blocked` from `isBlocked`).
  The daemon already passes `session.goto`'s return value straight through, so no daemon
  change is needed for the new shape.
- `isBlocked()` → `{ blocked: boolean, reason: string | null }`
  (heuristic: `location.href` matches `/punish|_____tmd_____|x5sec|captcha/i`, or body text
  matches `/slide to verify|unusual traffic|verify to continue/i`).
- `waitForSettled(timeout?)` → `{ settled: boolean, textLen: number }`
  (currently returns void — change to return this; keep polling logic).

**`daemon.ts` (owner A) adds two cases** to the `switch (body.method)` at ~line 266:
```
case "isBlocked":       result = await session.isBlocked(); break;
case "waitForSettled":  result = await session.waitForSettled(params.timeout as number|undefined); break;
```

**`cli.ts` (owner C) sends** `method:"isBlocked"` for `tb blocked` and
`method:"waitForSettled"` for `tb wait --settled`; adds `--visible` to `booleanFlags` and
passes `visible:true` into the `/session/create` body; implements `extract` `@attr`; and
implements `tb harvest`.

**UA/version is NOT a cross-file seam.** B owns the entire UA string + `userAgentMetadata`
using a single `CHROME_VERSION` constant set to match the current stable major (151). No
dynamic version passing — a maintained constant is enough (and is what tb already does,
just stale). D does not touch UA.

## Workstreams (parallel, opus @ xhigh, file-partitioned)

| Agent | Owns | Work |
|---|---|---|
| **A** | `src/daemon.ts` | (1) Single-daemon lock: atomic lockfile/flock in `ensureDaemon` (`daemon.ts:597`) + stale-socket cleanup so concurrent `tb` calls never spawn duplicates. (2) Add the two `switch` cases above. |
| **B** | `src/session.ts` | (1) `goto` returns real status + `blocked`. (2) `isBlocked()`. (3) `waitForSettled` returns `{settled,textLen}`. (4) Fingerprint fixes: pass `userAgentMetadata` (brands+platform+version) in `Network.setUserAgentOverride` (`session.ts:349`); `CHROME_VERSION=151`; remove the dead `Function.prototype.toString` guard and the no-op `attachShadow` patch; patch `WebGL2RenderingContext.prototype.getParameter` too; make `navigator.plugins` present as a `PluginArray`-shaped object. Verify each with a fingerprint probe. |
| **C** | `src/cli.ts` + new `src/harvest.ts` | `--visible` flag → create body; `tb wait --settled`; `tb blocked`; `extract` `sel@attr` parsing (attr when `@` present, else textContent); `tb harvest` (reads URL list, reuses one session, jitter, `isBlocked` circuit-breaker with soft-wait-to-clear, JSONL checkpoint, resume by skipping done URLs, `--recipe`/`--schema`). Ship `recipes/aliexpress.js` as the reference extractor (title=`og:title` stripped of ` - AliExpress`, cost=`price-default--original--` skipping the `$0.99` new-shopper teaser, image=`og:image`, sold/rating/ratings/reviews/delivery via body regex). |
| **D** | `src/engines/chromium.ts` | Launch-arg hardening that does not fight the UA: add `--disable-blink-features=AutomationControlled`, `--lang=en-US`; confirm the resolved binary path/version is reported. Do NOT touch UA (B owns it). Keep `chrome-headless-shell` fallback but prefer full Chrome when present. |
| **E** | `CLAUDE.md`, `README.md`, `.claude/skills/tb/SKILL.md` | The decision guide (below) in all three, scaled to audience. `CLAUDE.md` also carries the architecture map + the hard-won caveats. |

### Decision guide (goes in all three docs, wording scaled per audience)

```
Scraping many pages → structured data?      → tb harvest (recipe/schema + --out)
Page won't load / bot-blocked / captcha?    → add --visible   (headless fails Baxia-class checks)
SPA loaded but content empty/hydrating?     → tb wait --settled
Need an image URL / href / attribute?       → tb extract 'sel@attr'   (plain extract is text-only)
Is this page actually a challenge wall?     → tb blocked
One page, quick structured pull?            → tb eval '<IIFE>' --json
```

`CLAUDE.md` additionally records: the daemon-hygiene gotcha; that `goto`'s status was once a
lie (and is now real); the visible-vs-headless lesson; and the teaser-price trap as a
worked example of why recipes exist.

## Verification

1. `bun run` typecheck / build is clean.
2. `tb doctor` passes.
3. Fingerprint probe: `navigator.userAgentData.brands` is non-empty and consistent with the
   UA; `navigator.webdriver` undefined; WebGL1 **and** WebGL2 report Intel; `attachShadow`
   is native.
4. Daemon race: launch 5 concurrent `tb open` calls → exactly one daemon process.
5. **Live smoke test**: `tb harvest` on 3 of today's AliExpress URLs (`--visible`) returns
   correct prices (matching the values we already verified: socks $9.44, EMS $13.02,
   sofa $413.30).
6. Regression: a normal site (example.com) still opens/reads headless.

## Out of scope (YAGNI)

- Dynamic UA-version detection (constant is enough).
- A `~/.tb/recipes/` auto-discovery registry (explicit `--recipe <path>` is enough now).
- Proxy support / per-session IP rotation (not needed at this scale).
