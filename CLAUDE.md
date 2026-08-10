# CLAUDE.md — working notes for agents in this repo

Engineering memory for `tb`. Read this before scraping work; it records things
that cost real time to discover and are not obvious from the code.

## Which command do I reach for?

| Situation | Use |
|---|---|
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
- **Engines:** `chromium` (real Chrome, use `-e c` for anything JS-heavy) and
  `lightpanda` (fast, but won't run a real SPA). `auto` resolves to chromium.
- **Sessions are tabs; groups are windows.** One browser process is shared by all
  sessions, so **they share one cookie jar, one fingerprint, one IP.** Parallel
  fan-out multiplies bot-detection risk without isolating anything.
- Daemon idles out after 30 min; session cap is 25 (`tb config max-sessions <n>`).
- Sessions are **not** garbage collected — `tb kill <name>` when done.

## Hard-won caveats

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
