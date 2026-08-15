---
name: tb
description: Headless browser for AI agents — navigate, screenshot, interact with numbered elements, site-aware reading, scraping, groups, DOM diffing
user-invocable: true
---

# tb — tiny browser skill

Use `tb` to browse websites, take screenshots, fill forms, and interact with page elements.
The number system lets you see and click elements without knowing CSS selectors.

## Setup (if `tb` isn't installed)

```bash
curl -fsSL https://raw.githubusercontent.com/hartmantexas/tb/main/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
tb doctor                         # verify engines + screenshot quality
```

## Quick Start

```bash
tb -w fhd open <url> -e c          # Open with Chromium at 1920x1080 (best for screenshots)
tb elements                       # See numbered interactive elements
tb tap <n>                        # Click element by number
tb screenshot /tmp/page.png       # Take screenshot
```

**For screenshots, always set `-w fhd`** (1920x1080) before `open` — it gives crisp, well-proportioned captures. Use `-w mobile` etc. only when you specifically want to test that device size.

**If the page needs a login,** don't fight it — drive the user's own browser instead:
`tb tabs` to see what they have open, `tb attach <n>` to take one over. Setup is
[one manual step](#logged-in-sites--drive-the-users-own-chrome) they run once.

## Core Commands

| Command | What it does |
|---------|-------------|
| `tb open <url> -e c` | Navigate to URL with Chromium |
| `tb open <url> -e c -n <name> --new` | Named session (for parallel work) |
| `tb elements` | List interactive elements with numbers |
| `tb tap <n>` | Click element by its number |
| `tb annotate [path]` | Screenshot with floating number badges |
| `tb screenshot [path]` | Plain screenshot |
| `tb clear <selector>` | Clear input field (React-compatible) |
| `tb type <selector> <text>` | Type text into element |
| `tb click <selector>` | Click by CSS selector |
| `tb eval <js>` | Run JavaScript in page |
| `tb text` | Get page text |
| `tb title` | Get page title |
| `tb url` | Get current URL |
| `tb shots <url> [outdir]` | Capture across viewports (`--viewports fhd,mobile,ipad`) |
| `tb ps` | List active sessions (shows names) |
| `tb kill <id-or-name>` | Kill a session |
| `tb stop` | Stop daemon and all engines |
| `tb extension install` | Connect tb to the user's own Chrome (one time, no restart) |
| `tb bridges` | Which Chrome profiles are connected |
| `tb use chrome` / `tb use tb` | Route commands through their browser, or back to tb's |
| `tb tabs` | List tabs they already have open, numbered |
| `tb attach <n\|title\|url>` | Bind a session to an existing tab |
| `tb <cmd> --tab <n\|title\|url>` | One-off against an existing tab |
| `tb <cmd> --bridge <profile>` | Pick a profile when several are connected |

## Session Lifecycle — close what you open

Every `tb open --new` spawns a session that stays alive until killed. They are
**not** garbage-collected. Be disciplined:

- **Close sessions when done.** `tb kill <name>` for one, `tb stop` to end all.
- **One-off tasks (e.g. a single research scrape): close on completion.** Open →
  read/scrape → `tb kill <name>`. Don't leave it running.
- **Reuse, don't multiply.** For multi-step work on the same site, keep using the
  same `--session <name>` instead of opening new tabs.
- **Check before you spawn.** `tb ps` shows what's already running. Aim to keep
  well under ~10–15 concurrent.
- **There is a hard cap** (default 25, `tb config max-sessions <n>`). Past it,
  `open` is refused — don't loop trying; close some first. For wide fan-out
  (distributed research), open a batch, finish it, **close it**, then continue —
  don't open 40 at once.
- **Bridge sessions are the user's browser, so the rules differ.** `tb kill` on a tab
  *they* opened only detaches — the tab stays. It closes only tabs tb created. `tb stop`
  never touches their browser. Still `tb kill` when done: an attached tab keeps a
  debugging banner until you let go of it.

## The Number System

This is how you interact with pages without CSS selectors.

### Step 1: See what's on the page
```bash
tb elements
```
Output:
```
    1  input   Email
    2  input   Password
    3  button  Sign In
    4  button  Continue with Google
    5  link    Forgot password?
```

### Step 2: Click by number
```bash
tb tap 3       # Clicks "Sign In"
```

### Step 3: Visual verification
```bash
tb annotate /tmp/annotated.png    # Screenshot with numbered badges overlaid
tb screenshot /tmp/clean.png      # Clean screenshot for comparison
```

Numbers are stable within a page load. After navigation, run `tb elements` again.

### How numbers are assigned
1. **Inputs first** (text, email, password, search, textarea) — yellow badges
2. **Buttons next** (button, submit, role=button) — green badges
3. **Links last** (a[href], up to 25) — blue badges

Hidden elements (`display:none`, `offsetParent === null`) are skipped.

## Scraping — pick the right tool

| Situation | Command |
|---|---|
| Many pages → structured data | `tb harvest <urls.txt> --recipe r.js --out data.jsonl` |
| Site needs a logged-in account | `tb use chrome` (see below) |
| Page empty / won't load / bot-blocked | add `--visible` |
| Loaded but content empty (client-rendered) | `tb wait --settled` |
| Need image URL / href / attribute | `tb extract '{"img":"img@src"}'` |
| Suspect a captcha wall | `tb blocked` |
| One page, quick pull | `tb eval '<IIFE>' --json` |

**`--visible` is the anti-bot escape hatch.** Sites like AliExpress fingerprint
headless Chrome and serve an empty shell — no error, just a page with no content. If
a page looks mysteriously blank, try `--visible` before debugging your selectors.

**Don't trust a clean `goto`.** It returns `{status, url, blocked}` — check them. A
challenge page is served as a normal 200.

## Logged-in sites — drive the user's own Chrome

A throwaway browser is logged into nothing. The extension bridge relays CDP into the
Chrome the user is already running, so their cookies, sessions, and extensions all apply.

```bash
tb extension install      # one time, no Chrome restart (user loads it by hand)
tb use chrome             # route everything through their browser
tb tabs                   # tabs they already have open
tb attach 2 -n shop       # drive an existing tab
tb --session shop extract '{"price":".price"}'
tb use tb                 # back to tb's own browser
```

The extension is loaded per Chrome profile — that *is* the profile picker. Several can
be connected; choose with `--bridge <name>`.

**tb never closes a tab it didn't open.** `tb kill` detaches from a tab the user opened
and only closes ones tb created. `tb stop` never touches their browser. Don't write
workflows that assume otherwise.

**Ask before scraping bulk through a logged-in profile.** It ties the activity to a real
account, so a throttle can hit the account and not just the IP.

**Never retry into a challenge.** It turns a temporary rate-limit into a hard block.
`tb harvest` already handles this: it waits ~40s for the challenge to clear, then
halts with a resumable checkpoint.

### Bulk scrape

```bash
# headful session for a bot-protected site
tb open https://site.com --visible -e c -n s --new
sleep 5                                   # let it warm up before hitting deep pages

tb --session s harvest urls.txt \
   --recipe src/recipes/aliexpress.js \   # or --schema '{"title":"h1","img":"img@src"}'
   --out data.jsonl --settle --jitter 3,7

# halted? fix the cause and re-run — it skips everything already in data.jsonl
```

A recipe is plain JS whose last expression is the record (same as `tb eval`). Prefer
`og:` meta tags — they're server-rendered and survive when the body is blocked. Match
hashed CSS-module classes on a prefix: `[class*="price-default--current--"]`.

## Patterns

### Scrape a site the user is logged into
```bash
# Prefer this over automating a login: no credentials, no 2FA, no captcha.
tb bridges                                  # is a profile connected?
tb tabs                                     # what do they already have open?

# Take over a tab they're already on...
tb attach aliexpress -n ali
tb --session ali extract '{"title":"h1","price":"[class*=price-default--current--]"}'

# ...or open new tabs in their window, still logged in
tb open https://www.aliexpress.com/item/123.html -n item --new
tb --session item extract '{"price":"[class*=price-default--current--]"}'

tb kill ali                                 # detaches; their tab stays open
tb kill item                                # tb opened this one, so it closes
```

Ask before bulk-harvesting through their account — it ties the traffic to a real
login, so a throttle can land on the account and not just the IP.

### Login Flow
```bash
tb stop
tb open http://localhost:3000/login -e c -n login --new
sleep 3

# Clear autofilled inputs (React apps need this)
tb --session login eval "
  const ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  const e = document.getElementById('email');
  const p = document.getElementById('password');
  ns.call(e, ''); e.dispatchEvent(new Event('input', {bubbles:true}));
  ns.call(p, ''); p.dispatchEvent(new Event('input', {bubbles:true}));
"

# Fill and submit
tb --session login click '#email'
tb --session login type '#email' user@example.com
tb --session login click '#password'
tb --session login type '#password' mypassword
tb --session login click 'button[type="submit"]'
sleep 5
tb --session login screenshot /tmp/after-login.png
tb --session login url    # Verify redirect
```

### QA Walkthrough
```bash
tb -w fhd open http://localhost:3000 -e c -n qa --new
sleep 3

# Take annotated screenshot to see all clickable elements
tb --session qa annotate /tmp/step1.png

# Check elements, click through the flow
tb --session qa elements
tb --session qa tap 5        # Click whatever element 5 is
sleep 2
tb --session qa screenshot /tmp/step2.png
tb --session qa elements     # Re-list after navigation
```

### React Controlled Inputs
React apps ignore `.value = ''`. Use `tb clear` or the native setter pattern:

```bash
tb clear '#email'                    # Dispatches native input event
tb type '#email' new@email.com       # Type fresh value
```

Or via eval for full control:
```bash
tb eval "
  const ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  const el = document.querySelector('#email');
  ns.call(el, '');
  el.dispatchEvent(new Event('input', {bubbles:true}));
"
```

### Parallel Sessions
```bash
# Two agents, two sessions, no collision
tb open http://app.com/page1 -e c -n agent1 --new
tb open http://app.com/page2 -e c -n agent2 --new

tb --session agent1 elements
tb --session agent2 screenshot /tmp/page2.png

tb kill agent1
tb kill agent2
```

## Viewport Presets

| Flag | Resolution | Use case |
|------|-----------|----------|
| `-w fhd` | 1920x1080 | Full HD, best for desktop QA |
| `-w hd` | 1280x720 | Standard |
| `-w mac` | 1440x900 | MacBook Pro |
| `-w air` | 1470x956 | MacBook Air M2 |
| `-w mobile` | 390x844 | iPhone 14/15 |
| `-w ipad` | 1024x1366 | iPad Pro |
| `-w WxH` | Custom | Any resolution |

Set viewport BEFORE `open` — it configures the engine at launch:
```bash
tb -w fhd open http://localhost:3000 -e c
```

**Capture several at once** — responsive QA or marketing shots, one command (opens
a throwaway session and closes it automatically):
```bash
tb shots http://localhost:3000 /tmp/shots --viewports fhd,ipad,mobile
# → /tmp/shots/<page>-fhd.png, -ipad.png, -mobile.png  (real reflow per size)
```

## Engine Selection

| Flag | Engine | When to use |
|------|--------|------------|
| `-e c` | Chromium | Real sites, pixel screenshots, bot-blocked pages, visual QA |
| `-e lp` | Lightpanda | Scraping, text extraction, fast DOM ops, low memory |
| `-e ext` | The user's own Chrome | Logged-in sites, tabs they already have open |
| (default) | auto | Picks Lightpanda (or the bridge, after `tb use chrome`) |

**Rendering paths:**
- **Chromium (`-e c`)** — the real browser paint. Pixel-perfect, retina, full device emulation. Use for anything where exactness matters.
- **Lightpanda + Blitz** — Lightpanda gives the DOM/CSSOM; the Blitz render engine (Stylo, Firefox's CSS engine, in an ~18MB binary) paints it. Near pixel-perfect (real gradients, grid, flexbox, tables, list markers) at 2× retina, no browser. Build once: `tb install render-engine` (needs Rust/cargo).
- **Lightpanda without Blitz** — falls back to an in-page CSS-cascade resolver → ~85% approximation. Still useful, not exact.

For pixel-perfect, either build Blitz or use `-e c`.

## JSON Mode

Add `--json` to any command for structured output:

```bash
tb --json elements
# [{"index":1,"type":"input","text":"Email","selector":"#email"}, ...]

tb --json tap 3
# {"ok":true,"index":3,"type":"button","text":"Sign In"}

tb --json screenshot /tmp/shot.png
# {"path":"/tmp/shot.png","size":142857}

tb --json tabs
# {"bridge":"you@gmail.com","tabs":[{"tabId":1001,"title":"AliExpress","url":"...","active":true}]}

tb --json ps
# sessions include "engine":"extension", "tabId", and "ownedTab" (false = the user's tab)
```

## Troubleshooting

**"Session not found"** — daemon timed out (30min idle). Run `tb open` again.

**Lightpanda screenshots look approximate** — the Blitz render engine isn't built. Run `tb install render-engine` (needs Rust) for near-pixel-perfect output, or use `-e c`.

**React inputs don't clear** — use `tb clear <selector>` instead of eval `.value = ''`.

**TMPDIR errors** — if your shell has `TMPDIR` pointing to a disconnected drive, tb handles it (falls back to `/tmp`).

**Elements missing from `tb elements`** — only visible, non-hidden elements with text are listed. Interactive divs with `onClick` but no `role="button"` may be missed. Use `tb eval` to find and click them directly.

**"No tb extension is connected"** — the bridge isn't loaded, or Chrome is closed. Have the user run `tb extension install`. It's a manual load (Chrome blocks programmatic unpacked installs), so you can't do it for them.

**"Could not attach to tab N"** — Chrome allows one debugger per tab. Something else holds it: DevTools is open on that tab, or another automation tool. Close DevTools and retry, or pick a different tab.

**A tab isn't in `tb tabs`** — `chrome://` pages, the Web Store, and extension pages are filtered out because `chrome.debugger` can't attach to them at all.

**"Chrome is no longer connected to tb"** — the user quit Chrome or removed the extension mid-session. Sessions bound to its tabs are dead; `tb kill` them. The extension reconnects on its own when Chrome comes back, but old sessions don't come back with it.

**Bridge commands fail right after Chrome restarts** — the extension's service worker reconnects on a backoff. Give it a couple of seconds and check `tb bridges`.

## Smart Reading & Scraping

### `tb read` — site-aware extraction (one command)

```bash
# GitHub repo — returns metadata + full README
tb read https://github.com/D4Vinci/Scrapling

# Multiple repos, one tab, sequential
tb read https://github.com/D4Vinci/Scrapling https://github.com/microsoft/markitdown

# GitHub trending — structured list of all repos
tb read https://github.com/trending

# Trending + follow top 5 repos for full READMEs
tb read https://github.com/trending --follow 5

# Hacker News — all stories with title, URL, points
tb read https://news.ycombinator.com

# Any unknown site — smart generic extraction
tb read https://example.com

# JSON output for programmatic use
tb read https://github.com/trending --json
```

`tb read` auto-detects the site and uses purpose-built extractors. GitHub repos return `{repo, description, stars, forks, topics, languages, readme}`. HN returns `{stories: [{title, url, points, comments}]}`.

### `tb describe` — page type detection

```bash
tb describe
```
Returns a structural summary: page type (form/list/table/article/directory), sections, forms with field names, repeating elements, button labels. Tells an agent everything about a page in ~200 tokens.

### `tb auto-extract` — zero-config structured data

```bash
tb auto-extract
```
Finds repeating items on any page automatically. No selectors needed. Uses structural fingerprinting (tag, depth, parent, children pattern) to find the dominant repeating group, then extracts fields by role. Works on product grids, search results, feeds, tables.

### `tb find-similar <selector>` — find matching elements

```bash
tb find-similar ".titleline"     # Give it one element, find all similar
tb find-similar "#3"             # By element number
```
Scrapling-inspired multi-signal similarity scoring. Compares tag, depth, parent, attributes, children, siblings, text.

### `tb batch` — multiple commands, one call

```bash
tb batch 'url ; title ; snapshot -i ; scrape' --json
```
Runs all commands sequentially, returns array of `{step, result}`.

## Groups & Parallel Scraping

Groups are windows. Sessions are tabs. Agents get whole groups.

```bash
# Create sessions in groups
tb open https://github.com/a -n repoA --group research --new
tb open https://github.com/b -n repoB --group research --new

# View/manage groups
tb groups                          # Quick overview
tb move repoA --group other        # Move tab to different window
tb group rename research dev       # Rename group

# Group-level commands — hit ALL tabs at once
tb url --group research            # URLs from all tabs
tb scrape --group research         # Scrape all tabs simultaneously
tb screenshot --group research     # Screenshot all tabs
tb eval "document.title" --group research  # Run JS on all tabs

# Watch a specific group
tb watch --group research          # Focused window with only group tabs
```

### Fan-out with `tb pipe`

```bash
# Extract links from current page, open each as a tab, run command on all
tb pipe --links ".titleline a" --group stories --then scrape --limit 5
```

## DOM Diffing

Auto-snapshots fire on every navigation and click. Ask what changed:

```bash
tb dom-snapshot                    # Take manual snapshot
tb dom-diff                        # What changed since last snapshot?
# → +3 elements added (form, input#email, input#password)
# → -1 element removed (div.welcome-banner)
# → ~2 elements changed (nav.active, #cart-count: "0" → "1")
```

### `tb snapshot` — accessibility tree

```bash
tb snapshot -i                     # Interactive elements with @e refs
tb act "click sign in"             # Natural language action (no LLM)
tb tap-ref @e3                     # Click by accessibility ref
```

## Workflow Commands

| Command | What it does |
|---------|-------------|
| `tb read <url>` | Site-aware reading (GitHub, HN, generic) |
| `tb read <url> --follow N` | Read + follow N links |
| `tb describe` | Page type + structure summary |
| `tb auto-extract` | Zero-config repeated item extraction |
| `tb find-similar <sel>` | Find structurally similar elements |
| `tb batch 'cmd1;cmd2'` | Multi-command in one call |
| `tb pipe --links <sel>` | Fan-out: open links, run on all |
| `tb dom-diff` | Structural changes since last action |
| `tb dom-snapshot` | Take DOM fingerprint |
| `tb groups` | List all groups and tabs |
| `tb move <session> --group` | Move tab between windows |
| `tb intercept block <pat>` | Block URL patterns |
| `tb intercept mock <pat> <json>` | Mock API responses |
| `tb history` | DVR action log |
| `tb events` | Live page events (console, nav, errors) |
| `tb record <name>` | Record user actions |
| `tb replay <name>` | Replay recorded actions |
| `tb auth save/load <name>` | Save/restore cookies + storage |
| `tb watch` | Live web UI viewer |
| `tb watch --group <name>` | Watch specific group |
| `tb cc` | Command center (grid of all windows) |
