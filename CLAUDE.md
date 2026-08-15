# CLAUDE.md — working notes for agents in this repo

Engineering memory for `tb`. Read this before scraping work; it records things
that cost real time to discover and are not obvious from the code.

## Before you automate anything: check the rung

**tb is a mechanism, not the system.** The most expensive mistake made in this repo
was not a bug — it was reaching for browser automation on a target that had a typed
API, and then planning weeks of CDP work to make the browser path viable. When the
only tool you hold is a browser driver, every goal looks like a DOM problem, and the
driver's limits silently become the product's limits.

Interfaces rank, and the ranking is stable across every target:

| Rung | Interface | What you give up going lower |
|---|---|---|
| 1 | Typed API (e.g. Admin GraphQL) | — |
| 2 | Official CLI | fine-grained transactions |
| 3 | Structured file edit + push | write-time schema validation |
| 4 | Browser DOM automation | determinism, diffs, rollback, audit |
| 5 | Pixels / vision | repeatability |

**Act at the highest rung that can do the job; verify at the lowest rung that can see
the result.** Write the JSON via CLI, then screenshot the render to confirm. Acting and
verifying through the same path makes a lie in that path invisible.

Rules that follow, and are not optional:

1. **Map before you automate.** Enumerate a target's interfaces in rung order before
   writing one selector. Landing on rung 4–5 requires writing down what was ruled out
   above it. A missing map is itself the bug.
2. **Reads carry provenance.** "0 elements" is never an acceptable answer alone —
   "0 in frame 1; frames 2–3 skipped, cross-origin" is. Silent incompleteness is this
   codebase's recurring failure mode (see `goto` hardcoding 200, headless empty shells,
   iframes in the `SKIP` set at `session.ts:89`).
3. **Verify on a different path than you acted on.**
4. **Intent is the input, not the mechanism.** "Set product title padding to 8px", never
   "click the third slider". A workflow that names a mechanism has skipped the map.

### Shopify specifically

The theme editor is a GUI over JSON. `templates/*.json` and `config/settings_data.json`
hold every block setting — padding, alignment, width, presets. The editor URL literally
contains the block's path into that file
(`?block=template--...__product_title_YXxMTj`). **Do not drive the theme editor with a
browser.** Use `shopify theme pull` → edit JSON → `shopify theme push`, authenticated
with a **Theme Access** password (scoped `write_themes`; legacy custom apps were closed
to new creation on 2026-01-01). `themeFilesUpsert` is the API equivalent but needs a
Shopify exemption for distributed apps — unnecessary for our own store.

Products, orders, inventory, and bulk import are Admin GraphQL (rung 1). The Shopify
**Dev MCP** (`@shopify/dev-mcp`) gives schemas and validation inside Claude Code.

tb's correct role here is **rung 4 on purpose**: confirming a change actually renders
(`tb shots` across viewports, DOM diff, screenshot compare), plus vendors with no API.
That is a real job — the Admin API cannot tell you the grid breaks at 390px.

Full reasoning: `docs/superpowers/specs/` and the architecture review artifact.

## Which command do I reach for?

| Situation | Use |
|---|---|
| Site needs you logged in | `tb extension install` once, then `tb use chrome` — drives your own Chrome |
| Drive a tab that's already open | `tb tabs` then `tb attach <n>` (or `--tab <n>` on any command) |
| Many pages → structured data | `tb harvest <urls-file> --recipe r.js --out data.jsonl` |
| Page won't load / empty / bot-blocked | add `--visible` (headless is fingerprinted and silently served an empty shell) |
| Page loaded but content is empty (client-rendered) | `tb wait --settled` |
| Need an image URL, href, or any attribute | `tb extract '{"img":"img@src"}'` — plain `extract` is text-only |
| Suspect a captcha / challenge wall | `tb blocked` |
| One page, quick structured pull | `tb eval '<IIFE>' --json` |
| See/click things without selectors | `tb elements` then `tb tap <n>` |

## Architecture

```
bin/tb → src/cli.ts → daemon (unix socket ~/.tb/daemon.sock) → Session → CDP → engine
```

- **No build step.** `bin/tb` imports `src/cli.ts` directly; `dist/` is stale. Edit
  source and run — never `bun build` to test.
- **Engines:** `chromium` (real Chrome, use `-e c` for anything JS-heavy),
  `lightpanda` (fast, but won't run a real SPA), and `extension` (`-e ext` — not a
  browser tb launches, but a bridge into one you're already running). `auto`
  resolves to `defaultEngine`, which is `chromium` unless `tb use chrome` set it
  to `extension`.
- **Sessions are tabs; groups are windows.** One browser process is shared by all
  sessions, so **they share one cookie jar, one fingerprint, one IP.** Parallel
  fan-out multiplies bot-detection risk without isolating anything.
- Daemon idles out after 30 min; session cap is 25 (`tb config max-sessions <n>`).
- Sessions are **not** garbage collected — `tb kill <name>` when done.

## The extension bridge (logged-in sessions)

`tb extension install` loads an unpacked MV3 extension that relays CDP into a Chrome
you are *already running* — `chrome.debugger.sendCommand` is literally CDP, so all of
`Session` works over it unchanged. No debug port, no relaunch.

**Why not just launch Chrome with `--user-data-dir=<real profile>`?** Because Chrome
refuses to start a second process against a user-data-dir already in use — it hands the
URL to the running instance and exits, so tb never gets a debug port and `waitForPort`
times out. That design forces the user to quit Chrome first. The extension does not.

- **The extension is per-profile, and that's the profile selector.** Load it in the
  profile you want driven; load it in several and `tb bridges` lists each. Target one
  with `--bridge <name>`.
- **tb never closes a tab it didn't open.** Sessions carry `createdByTb`; `tb kill`
  closes tb's own tabs and merely detaches from yours. Enforced twice — in the daemon's
  `releaseTab` and again in the extension. Do not "simplify" either one away.
- **`tb stop` must never kill the user's browser.** Bridge sessions have no entry in
  `engineProcesses`, which is what makes that true. Keep it that way.
- Attached tabs show a "tb started debugging this browser" infobar. Unavoidable without
  a restart-only Chrome flag. It's browser UI, so it does not appear in screenshots.
- One debugger per tab: attach fails if DevTools is open on it, and `chrome://` pages
  and the Web Store can't be attached at all (the extension filters them out of `tb tabs`).
- **Fingerprint patches are skipped for bridge sessions** (`native` flag on `Session`).
  Pinning `CHROME_VERSION` over a browser that auto-updates would eventually contradict
  the real UA, and de-nativing functions in a profile you actually browse with is the
  fingerprint-*creating* mistake this file warns about below.
- Scraping through a logged-in profile ties the activity to a real account, so a
  throttle can attach to the account and not just the IP. Point `tb harvest` at a bridge
  session deliberately.

## Hard-won caveats

**Don't match error strings loosely.** `cli.ts`'s global handler used to treat any
message containing `"connect"` as a dead daemon — which silently rewrote
"No tb extension is connected" into "Failed to start daemon. Check: tb status". It now
matches ECONNREFUSED / `daemon.sock` / "failed to connect" specifically.

**A dead bridge must fail fast, not time out.** When Chrome quits with sessions open,
`Bridge.request` rejects immediately via the `dead` flag. Without it, `tb kill-all` sat
on the 30s CDP timeout and the CLI's socket gave up first, reporting a connection error
while the daemon was actually fine.

**`--visible` is the anti-bot escape hatch.** Alibaba/AliExpress (Baxia/x5sec) detect
headless Chrome and return a page shell with no product data — no error, just ~1200
chars of header and footer. A headful window renders it fine. If a page looks
mysteriously empty, try `--visible` before debugging selectors.

**`goto` used to lie.** It hardcoded `status: 200`. It now returns the real
main-frame status plus `blocked`. Old code (and habits) that assume "it resolved,
so it loaded" are wrong — check `status` and `blocked`.

**A challenge is soft, until it isn't.** `tb harvest` waits ~40s for a challenge to
clear (they often do, or you solve it in the visible window) and only then halts.
**Never retry into a challenge** — that converts a self-expiring rate limit into a
hard block. If harvest halts, the output file is a valid checkpoint: fix the cause,
re-run, and it resumes.

**Rate limits are real and per-IP.** ~65 AliExpress product pages in an evening was
enough to get PDP requests throttled while the homepage still loaded fine. Pace with
`--jitter`, and if you get throttled, wait rather than push.

**Daemon hygiene.** Concurrent `tb` calls used to race and spawn several daemons,
producing intermittent `Session not found` (your session lived in an orphan process).
`ensureDaemon` now takes an exclusive lockfile (`~/.tb/daemon.lock`). If you ever see
that error again, check `pgrep -f 'daemon.ts --daemon'` — it should be exactly 1.

**Recipes exist because pages lie.** The AliExpress recipe
(`src/recipes/aliexpress.js`) skips the "$0.99 — New shoppers save $12.96" banner
because that price is a one-time promo, not the product cost. Recording it silently
corrupts every downstream margin. Encode traps like this in the recipe, not in
whatever script is calling tb.

**Fingerprint is maintained in one place.** `CHROME_VERSION` in `src/session.ts`
drives the UA string *and* the `userAgentMetadata` client hints. Keep them in step —
an empty `navigator.userAgentData` beside a populated UA (the old behaviour) is
itself a bot signal. Don't add "stealth" patches that wrap a native function without
changing behaviour: that de-natives it and *creates* a fingerprint. Two such patches
were removed for exactly this reason.

## Writing a recipe

Plain JS whose final expression is the record. Same thing you'd hand `tb eval`:

```js
(() => {
  const og = (p) => (document.querySelector(`meta[property="og:${p}"]`) || {}).content;
  return { url: location.href, title: og('title'), image: og('image') };
})()
```

Prefer `og:` meta tags — they're server-rendered, so they survive even when the
client-rendered body is blocked. Match CSS-module class names on a stable prefix
(`[class*="price-default--current--"]`), never the full hashed name.

## Verifying changes

There is no test suite, and `tsc --noEmit` does **not** pass at baseline (no
`@types/node`/`@types/bun`), so don't treat existing type errors as regressions —
filter for your own files. Real smoke test:

```bash
./bin/tb doctor
./bin/tb open https://example.com -e c -n t --new && ./bin/tb --session t title
./bin/tb --session t extract '{"h":"h1","link":"a@href"}'
./bin/tb kill t
```

Full design + rationale for the scraping work:
`docs/superpowers/specs/2026-08-10-tb-scraping-improvements-design.md`
