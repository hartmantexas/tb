---
name: tb
description: Headless browser for AI agents — navigate, screenshot, interact with numbered elements
user-invocable: true
---

# tb — tiny browser skill

Use `tb` to browse websites, take screenshots, fill forms, and interact with page elements.
The number system lets you see and click elements without knowing CSS selectors.

## Quick Start

```bash
tb open <url> -e c                # Open with Chromium (use -e c for real sites)
tb elements                       # See numbered interactive elements
tb tap <n>                        # Click element by number
tb screenshot /tmp/page.png       # Take screenshot
```

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
| `tb ps` | List active sessions |
| `tb kill <id-or-name>` | Kill a session |
| `tb stop` | Stop daemon and all engines |

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

## Patterns

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

## Engine Selection

| Flag | Engine | When to use |
|------|--------|------------|
| `-e c` | Chromium | Real sites, pixel screenshots, bot-blocked pages, visual QA |
| `-e lp` | Lightpanda | Scraping, text extraction, fast DOM ops, low memory |
| (default) | auto | Picks Lightpanda |

**Use `-e c` for any visual work.** Lightpanda doesn't render CSS — screenshots are DOM-to-image approximations. Chromium gives pixel-perfect output.

## JSON Mode

Add `--json` to any command for structured output:

```bash
tb --json elements
# [{"index":1,"type":"input","text":"Email","selector":"#email"}, ...]

tb --json tap 3
# {"ok":true,"index":3,"type":"button","text":"Sign In"}

tb --json screenshot /tmp/shot.png
# {"path":"/tmp/shot.png","size":142857}
```

## Troubleshooting

**"Session not found"** — daemon timed out (30min idle). Run `tb open` again.

**Screenshots are blank/tiny** — lightpanda can't render CSS. Use `-e c` for Chromium.

**React inputs don't clear** — use `tb clear <selector>` instead of eval `.value = ''`.

**TMPDIR errors** — if your shell has `TMPDIR` pointing to a disconnected drive, tb handles it (falls back to `/tmp`).

**Elements missing from `tb elements`** — only visible, non-hidden elements with text are listed. Interactive divs with `onClick` but no `role="button"` may be missed. Use `tb eval` to find and click them directly.
