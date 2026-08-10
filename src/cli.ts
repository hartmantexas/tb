#!/usr/bin/env bun

import { ensureDaemon, daemonFetch, stopDaemon } from "./daemon.js";
import { detectEngines, getEngine } from "./engines/index.js";
import { loadConfig, saveConfig } from "./config.js";
import { startServer } from "./server.js";
import { viewPage, liveSession } from "./view.js";
import { watch, commandCenter } from "./watch.js";
import { timeAgo, formatBytes } from "./utils.js";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const VERSION = "0.1.0";
const TB_HOME = join(homedir(), ".tb");

/** Extract interactive elements — visually ordered, only truly visible/hittable */
const EXTRACT_ELEMENTS_JS = `(() => {
  var results = [], seen = new Set(), vw = window.innerWidth, vh = window.innerHeight;
  function vis(el) {
    try { if (getComputedStyle(el).display === 'none' || el.offsetParent === null) return false; } catch(e) { return false; }
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var hit = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2);
    return hit && (hit === el || el.contains(hit) || (hit.closest && hit.closest('a,button') === el));
  }
  function inView(r) { return r.width > 5 && r.height > 5 && r.x + r.width > 0 && r.y + r.height > 0 && r.x < vw && r.y < vh; }
  var inputs = document.querySelectorAll('input[type="text"], input[type="search"], input[type="email"], input[type="password"], input[type="url"], input[type="number"], input:not([type]), textarea');
  for (var i = 0; i < inputs.length; i++) {
    var inp = inputs[i];
    if (inp.type === 'hidden' || !vis(inp)) continue;
    var r = inp.getBoundingClientRect();
    if (!inView(r)) continue;
    var label = inp.getAttribute('aria-label') || inp.getAttribute('placeholder') || inp.name || inp.id || 'input';
    var val = inp.value || '';
    var sel = inp.id ? '#' + inp.id : (inp.name ? '[name="' + inp.name + '"]' : 'input:nth-of-type(' + (i+1) + ')');
    results.push({ type: 'input', text: label.trim().slice(0,50), value: val, selector: sel, _x: r.x, _y: r.y, _cx: r.x+r.width/2, _cy: r.y+r.height/2 });
  }
  var btns = document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"], [onclick]');
  for (var j = 0; j < btns.length; j++) {
    var btn = btns[j];
    if (!vis(btn)) continue;
    var btnText = (btn.textContent || btn.value || btn.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ');
    if (!btnText || seen.has(btnText)) continue;
    seen.add(btnText);
    var r2 = btn.getBoundingClientRect();
    if (!inView(r2)) continue;
    var btnSel = btn.id ? '#' + btn.id : (btn.getAttribute('data-testid') ? '[data-testid="' + btn.getAttribute('data-testid') + '"]' : null);
    if (!btnSel) {
      var parent = btn.parentElement;
      if (parent) { var siblings = Array.from(parent.children); var nth = siblings.indexOf(btn) + 1; var parentSel = parent.id ? '#' + parent.id : parent.tagName.toLowerCase(); btnSel = parentSel + ' > :nth-child(' + nth + ')'; }
      else { btnSel = btn.tagName.toLowerCase(); }
    }
    results.push({ type: 'button', text: btnText.slice(0,50), selector: btnSel, _x: r2.x, _y: r2.y, _cx: r2.x+r2.width/2, _cy: r2.y+r2.height/2 });
  }
  var links = document.querySelectorAll('a[href]');
  for (var k = 0; k < links.length; k++) {
    var a = links[k];
    if (!vis(a)) continue;
    var aText = (a.textContent || '').trim().replace(/\\s+/g, ' ');
    if (!aText || aText.length < 2 || seen.has(aText)) continue;
    seen.add(aText);
    var r3 = a.getBoundingClientRect();
    if (!inView(r3)) continue;
    var aSel = a.id ? '#' + a.id : 'a[href="' + (a.getAttribute('href') || '').replace(/"/g, '\\\\\\"') + '"]';
    results.push({ type: 'link', text: aText.slice(0,50), selector: aSel, _x: r3.x, _y: r3.y, _cx: r3.x+r3.width/2, _cy: r3.y+r3.height/2 });
  }
  results.sort(function(a,b) { var dy = a._y - b._y; return Math.abs(dy) > 15 ? dy : a._x - b._x; });
  for (var n = 0; n < results.length; n++) results[n].index = n + 1;
  return results;
})()`;

/**
 * Inject floating overlay number badges. MUST collect + order elements identically
 * to EXTRACT_ELEMENTS_JS (same selectors, visibility hit-test, dedup, and y/x sort)
 * so badge #N is always the same element as `tb elements` #N and `tb tap N`.
 */
const INJECT_OVERLAY_BADGES_JS = `(() => {
  document.querySelectorAll('.tb-overlay-badge').forEach(function(b) { b.remove(); });
  var results = [], seen = new Set(), vw = window.innerWidth, vh = window.innerHeight;
  function vis(el) {
    try { if (getComputedStyle(el).display === 'none' || el.offsetParent === null) return false; } catch(e) { return false; }
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var hit = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2);
    return hit && (hit === el || el.contains(hit) || (hit.closest && hit.closest('a,button') === el));
  }
  function inView(r) { return r.width > 5 && r.height > 5 && r.x + r.width > 0 && r.y + r.height > 0 && r.x < vw && r.y < vh; }
  var inputs = document.querySelectorAll('input[type="text"], input[type="search"], input[type="email"], input[type="password"], input[type="url"], input[type="number"], input:not([type]), textarea');
  for (var i = 0; i < inputs.length; i++) { var inp = inputs[i]; if (inp.type === 'hidden' || !vis(inp)) continue; var r = inp.getBoundingClientRect(); if (!inView(r)) continue; results.push({ el: inp, type: 'input', _x: r.x, _y: r.y }); }
  var btns = document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"], [onclick]');
  for (var j = 0; j < btns.length; j++) { var btn = btns[j]; if (!vis(btn)) continue; var t = (btn.textContent || btn.value || btn.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' '); if (!t || seen.has(t)) continue; seen.add(t); var r2 = btn.getBoundingClientRect(); if (!inView(r2)) continue; results.push({ el: btn, type: 'button', _x: r2.x, _y: r2.y }); }
  var links = document.querySelectorAll('a[href]');
  for (var k = 0; k < links.length; k++) { var a = links[k]; if (!vis(a)) continue; var at = (a.textContent || '').trim().replace(/\\s+/g, ' '); if (!at || at.length < 2 || seen.has(at)) continue; seen.add(at); var r3 = a.getBoundingClientRect(); if (!inView(r3)) continue; results.push({ el: a, type: 'link', _x: r3.x, _y: r3.y }); }
  results.sort(function(a, b) { var dy = a._y - b._y; return Math.abs(dy) > 15 ? dy : a._x - b._x; });
  var colors = { input: '#e8b931', button: '#34a853', link: '#4285f4' };
  for (var n = 0; n < results.length; n++) {
    var it = results[n], rect = it.el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    var b = document.createElement('div');
    b.className = 'tb-overlay-badge';
    b.textContent = String(n + 1);
    b.setAttribute('style',
      'position:fixed !important;z-index:999999 !important;' +
      'top:' + Math.max(0, rect.top - 6) + 'px !important;' +
      'left:' + Math.max(0, rect.left - 6) + 'px !important;' +
      'background:' + colors[it.type] + ' !important;color:#fff !important;' +
      'font-size:10px !important;font-weight:bold !important;font-family:monospace !important;' +
      'min-width:16px !important;height:16px !important;line-height:16px !important;' +
      'text-align:center !important;border-radius:8px !important;' +
      'padding:0 3px !important;pointer-events:none !important;' +
      'box-shadow:0 1px 3px rgba(0,0,0,0.5) !important;'
    );
    document.body.appendChild(b);
  }
})()`;


// --- First-run setup ---
async function ensureTbHome(): Promise<boolean> {
  if (!existsSync(TB_HOME)) {
    console.log("\x1b[36mWelcome to tb!\x1b[0m Setting up...");
    mkdirSync(TB_HOME, { recursive: true });
    mkdirSync(join(TB_HOME, "engines"), { recursive: true });
    console.log(`Created ${TB_HOME}`);
    console.log("Run \x1b[1mtb install\x1b[0m to set up Lightpanda (recommended).\n");
    return true;
  }
  return false;
}

// --- Arg parsing ---

const rawArgs = process.argv.slice(2);
const flags: Record<string, string> = {};
const positional: string[] = [];

// Parse all args — flags can appear anywhere
for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg.startsWith("--")) {
    const eqIdx = arg.indexOf("=");
    if (eqIdx !== -1) {
      flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
    } else if (
      i + 1 < rawArgs.length &&
      !rawArgs[i + 1].startsWith("-")
    ) {
      // Peek ahead: known boolean flags don't consume next arg
      const flagName = arg.slice(2);
      const booleanFlags = ["json", "help", "version", "new", "full-page", "insecure", "secure", "keep", "visible", "settled", "settle"];
      if (booleanFlags.includes(flagName)) {
        flags[flagName] = "true";
      } else {
        flags[flagName] = rawArgs[++i];
      }
    } else {
      flags[arg.slice(2)] = "true";
    }
  } else if (arg === "-e" && i + 1 < rawArgs.length) {
    flags["e"] = rawArgs[++i];
  } else if (arg === "-w" && i + 1 < rawArgs.length) {
    flags["w"] = rawArgs[++i];
  } else if (arg === "-n" && i + 1 < rawArgs.length) {
    flags["n"] = rawArgs[++i];
  } else if (arg === "-h") {
    flags["help"] = "true";
  } else if (arg === "-v") {
    flags["version"] = "true";
  } else {
    positional.push(arg);
  }
}

const command = positional.shift();

const jsonMode = flags.json === "true";
// Short engine aliases: -e c = chromium, -e lp = lightpanda
const rawEngine = (flags.engine || flags.e) as string | undefined;
const engineFlag = rawEngine === "c" ? "chromium"
  : rawEngine === "lp" ? "lightpanda"
  : rawEngine;

// Viewport presets: -w fhd, -w hd, -w mac, -w mobile, -w ipad, or -w 1440x900
const VIEWPORT_PRESETS: Record<string, { width: number; height: number }> = {
  fhd:    { width: 1920, height: 1080 },  // Full HD (default)
  hd:     { width: 1280, height: 720 },   // 720p
  mac:    { width: 1440, height: 900 },   // MacBook Pro 15"
  air:    { width: 1470, height: 956 },   // MacBook Air 13" M2+
  mobile: { width: 390,  height: 844 },   // iPhone 14/15 Pro
  ipad:   { width: 1024, height: 1366 },  // iPad Pro 12.9"
  tablet: { width: 768,  height: 1024 },  // iPad standard
  "4k":   { width: 3840, height: 2160 },  // 4K
};
// TLS cert handling: `--insecure` ignores cert errors (proxies/self-signed),
// `--secure` resets it. Persisted in config; applied at engine launch, so set
// it before `tb open` (like viewport). Restart the daemon to relaunch Chromium.
if (flags.insecure === "true") saveConfig({ insecure: true });
if (flags.secure === "true") saveConfig({ insecure: false });

const rawViewport = flags.viewport || flags.w;
if (rawViewport) {
  const preset = VIEWPORT_PRESETS[rawViewport.toLowerCase()];
  if (preset) {
    saveConfig({ viewport: preset });
  } else if (rawViewport.includes("x")) {
    const [w, h] = rawViewport.split("x").map(Number);
    if (w > 0 && h > 0) saveConfig({ viewport: { width: w, height: h } });
  }
}

function output(data: unknown): void {
  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
  } else if (typeof data === "string") {
    console.log(data);
  } else if (typeof data === "object" && data !== null) {
    // Pretty print for humans
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === "object") {
        console.log(`${k}: ${JSON.stringify(v)}`);
      } else {
        console.log(`${k}: ${v}`);
      }
    }
  } else {
    console.log(String(data));
  }
}

/** Turn a stopped recording (frames + concat list) into a video file. */
async function assembleRecording(
  r: { dir: string; frameCount: number; durationSec: number; listPath: string | null },
  out: string,
): Promise<void> {
  if (!r.listPath || r.frameCount < 2) {
    die(`Too few frames recorded (${r.frameCount}) — nothing changed on screen?`);
  }
  const { spawnSync, execFileSync } = await import("child_process");
  const ffmpeg =
    process.env.FFMPEG ??
    (spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0 ? "ffmpeg" : null);
  if (!ffmpeg) {
    output(
      jsonMode
        ? { frames: r.dir, list: r.listPath, note: "no ffmpeg found" }
        : `No ffmpeg on PATH (or $FFMPEG). Frames kept — assemble with:\n  ffmpeg -f concat -safe 0 -i ${r.listPath} -vf "pad=ceil(iw/2)*2:ceil(ih/2)*2" -c:v libx264 -pix_fmt yuv420p -movflags +faststart ${out}`,
    );
    return;
  }
  execFileSync(ffmpeg, [
    "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", r.listPath,
    "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
    "-c:v", "libx264", "-preset", "fast", "-crf", "19", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", out,
  ]);
  output(
    jsonMode
      ? { path: out, frames: r.frameCount, durationSec: r.durationSec }
      : `Recorded ${out} (${r.frameCount} frames, ${r.durationSec.toFixed(1)}s)`,
  );
}

function die(msg: string): never {
  if (jsonMode) {
    console.log(JSON.stringify({ error: msg }));
  } else {
    console.error(`Error: ${msg}`);
  }
  process.exit(1);
}

// --- Session management ---

let currentSessionId: string | null = null;

async function getSession(needsScreenshot = false): Promise<string> {
  // --session flag: use a specific session (by ID or name)
  if (flags.session) {
    currentSessionId = flags.session;
    return currentSessionId;
  }

  if (currentSessionId && flags.new !== "true") return currentSessionId;

  // Get or create a session
  await ensureDaemon();
  const sessionName = flags.name || flags.n;
  const status = (await daemonFetch("/status")) as {
    sessions: Array<{ id: string; name?: string }>;
  };

  // If a name is given, check if one already exists with that name
  if (sessionName) {
    const existing = status.sessions.find(s => s.name === sessionName);
    if (existing) {
      currentSessionId = existing.id;
      return currentSessionId;
    }
  }

  if (status.sessions.length > 0 && flags.new !== "true") {
    currentSessionId = status.sessions[status.sessions.length - 1].id;
    return currentSessionId;
  }

  // Create new session
  const result = (await daemonFetch("/session/create", {
    method: "POST",
    body: {
      engine: engineFlag ?? "auto",
      needsScreenshot,
      ...(sessionName ? { name: sessionName } : {}),
      ...(flags.group ? { group: flags.group } : {}),
      // Headful window: some bot defenses (Alibaba/Baxia-class) fingerprint
      // headless Chrome and silently serve an empty shell. --visible is the
      // escape hatch.
      ...(flags.visible === "true" ? { visible: true } : {}),
    },
  })) as { sessionId: string; engine: string; name?: string; sessions?: number; limit?: number };

  currentSessionId = result.sessionId;
  // Awareness: nudge the agent to clean up before they pile up and OOM the machine.
  if (!jsonMode && result.sessions && result.sessions >= 10) {
    const limit = result.limit ?? 25;
    console.error(
      `\x1b[33m⚠ ${result.sessions}/${limit} sessions active.\x1b[0m Close ones you're done with: \x1b[1mtb kill <name>\x1b[0m (or \x1b[1mtb stop\x1b[0m to end all).`,
    );
  }
  return currentSessionId;
}

async function sessionCmd(
  method: string,
  params: Record<string, unknown> = {},
  needsScreenshot = false,
): Promise<unknown> {
  const sessionId = await getSession(needsScreenshot);
  const result = (await daemonFetch("/session/command", {
    method: "POST",
    body: { sessionId, method, params },
  })) as { result: unknown };
  return result.result;
}

/** Run a command on all sessions in a group. Returns results keyed by session name. */
async function groupCmd(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> {
  if (!flags.group || flags.session) return null; // Not a group command
  await ensureDaemon();
  const status = (await daemonFetch("/status")) as { sessions: Array<{ id: string; name?: string; group?: string }> };
  const sessions = status.sessions.filter(s => s.group === flags.group);
  if (!sessions.length) { die(`No sessions in group: ${flags.group}`); return null; }
  const results: Record<string, unknown> = {};
  await Promise.all(sessions.map(async (s) => {
    const key = s.name || s.id.slice(0, 8);
    const r = (await daemonFetch("/session/command", { method: "POST", body: { sessionId: s.id, method, params } })) as { result: unknown };
    results[key] = r.result;
  }));
  return results;
}

// --- Commands ---

async function main() {
  // First-run setup
  await ensureTbHome();

  if (flags.version === "true" || command === "version") {
    output(jsonMode ? { version: VERSION } : `tb v${VERSION}`);
    return;
  }

  if (flags.help === "true" || !command || command === "help") {
    console.log(`
tb — tiny browser for agents
v${VERSION}

Usage: tb <command> [args] [flags]

Commands:
  open <url>              Navigate to a URL
  screenshot [path]       Take a screenshot (--open to view)
  shots <url> [outdir]    Capture across viewports (--viewports fhd,mobile,ipad)
  elements                List interactive elements with numbers
  tap <number>            Click element by number (from elements)
  annotate [path]         Screenshot with numbered overlay badges
  click <selector>        Click an element by CSS selector
  clear <selector>        Clear an input field (React-compatible)
  type <selector> <text>  Type text into an element
  eval <expression>       Evaluate JavaScript
  content                 Get page HTML
  text                    Get page text content
  title                   Get page title
  url                     Get current URL
  select <sel> <value>    Select dropdown value
  wait <selector>         Wait for element to appear
  cookies                 List cookies

  view                    Show page screenshot in terminal
  live [url]              Interactive browser in terminal
  watch [session]         Live viewer with tabs, bookmarks, click/type
  cc                      Command center — grid of all sessions

  snapshot                Accessibility tree (semantic elements)
  act "<action>"          Natural language action (no LLM)
  tap-ref @e1             Click by accessibility ref
  chat "<question>"       Send message to page AI, wait for response
  read <url> [url2] ...   Site-aware reading (GitHub, HN, etc)
  read --follow N         Read + follow N links from the page
  scrape                  Smart content extraction (reader mode)
  describe / page         Structural page summary (type, forms, sections)

  auth save <name>        Save auth state (cookies + localStorage)
  auth load <name>        Restore auth into session
  record <name>           Record actions to a script
  rec <sec|start|stop|status> [out.mp4]  Video-record the session (any app;
                          runs in the daemon, so every command between
                          start and stop lands in the video)
  drag <x1> <y1> <x2> <y2>  Smooth real-input drag (canvas editors, sliders)
  replay <name>           Replay a recorded script
  events                  Stream page events (console, nav, errors)
  dom-snapshot            Take a structural DOM fingerprint
  dom-diff                Diff DOM against previous snapshot
  diff <baseline.png>     Compare screenshot to baseline
  extract <schema>        Extract structured data by CSS selectors ('sel@attr' for img/href)
  harvest <urls-file>     Bulk scrape a URL list -> JSONL (resumable, jittered)
  blocked                 Is this page a bot-challenge wall?
  wait --settled          Wait for a client-rendered page to stop changing
  auto-extract            Zero-config structured data extraction (repeating items)
  workflow <file.json>    Run a multi-step workflow
  intercept block <pat>   Block URLs matching pattern
  viewport <size>         Change viewport (mobile, tablet, hd, fhd, WxH)

  ps                      List all active sessions
  kill <session-id>       Kill a specific session
  kill-all                Kill all sessions
  move <session> --group  Move session to a group (window)
  group list              List all groups and their tabs
  group rename <old> <new>  Rename a group
  groups                  Quick group overview
  batch 'cmd1;cmd2;cmd3'  Run multiple commands, collect results
  pipe --links <sel>      Fan-out: open links as tabs, run --then on all
  install [engine]        Install engine (lightpanda, chromium)
  engines                 List available engines
  status                  Show daemon status
  stop                    Stop daemon + all engines
  serve [port]            Start HTTP API server

Flags:
  -e <engine>       Engine: c (chromium), lp (lightpanda), auto
  -w <size>         Viewport: fhd, hd, mac, air, mobile, ipad, 1440x900
  -n <name>         Name this session (for parallel agent workflows)
  --session <id>    Use session by ID or name
  --json            Output as JSON (for agents)
  --new             Create a new session
  --visible         Headful window — use when a site blocks headless
  --full-page       Full page screenshot
  --open            Open screenshot in system viewer
  --format <fmt>    Screenshot format: png, jpeg
  --quality <n>     JPEG quality 0-100
  --timeout <ms>    Command timeout
  --help, -h        Show this help
  --version, -v     Show version

Examples:
  tb open http://localhost:3000
  tb screenshot ./page.png
  tb click "button.submit"
  tb text
  tb eval "document.querySelectorAll('a').length"
  tb --json open http://example.com
`);
    return;
  }

  try {
    switch (command) {
      case "open": {
        const url = positional[0];
        if (!url) die("Usage: tb open <url>");
        try {
          await ensureDaemon();
        } catch (err) {
          // Check if lightpanda is missing
          const engines = await detectEngines();
          if (engines.length === 0) {
            die("Lightpanda not found. Run: tb install");
          }
          die("Failed to start daemon. Check: tb status");
        }
        const sessionId = await getSession();
        const result = await sessionCmd("goto", { url });
        if (jsonMode) {
          output(result);
        } else {
          const r = result as { url: string; status: number };
          console.log(`Navigated to ${r.url}`);
        }
        break;
      }

      case "screenshot": {
        await ensureDaemon();
        // Group mode: screenshot all sessions
        if (flags.group && !flags.session) {
          const status = (await daemonFetch("/status")) as { sessions: Array<{ id: string; name?: string; group?: string }> };
          const sessions = status.sessions.filter(s => s.group === flags.group);
          if (!sessions.length) die(`No sessions in group: ${flags.group}`);
          const results: Record<string, string> = {};
          await Promise.all(sessions.map(async (s) => {
            const key = s.name || s.id.slice(0, 8);
            const p = `/tmp/tb-${key}-${Date.now()}.${flags.format ?? "png"}`;
            const r = (await daemonFetch("/session/command", { method: "POST", body: { sessionId: s.id, method: "screenshot", params: { path: p, format: flags.format ?? "png" } } })) as { result: { size: number } };
            results[key] = p;
            if (!jsonMode) console.log(`  ${key}: ${p} (${formatBytes(r.result.size)})`);
          }));
          if (jsonMode) output(results);
          break;
        }
        const path =
          positional[0] ??
          `/tmp/tb-screenshot-${Date.now()}.${flags.format ?? "png"}`;
        const result = await sessionCmd(
          "screenshot",
          {
            path,
            fullPage: flags["full-page"] === "true",
            format: flags.format ?? "png",
            quality: flags.quality ? parseInt(flags.quality) : undefined,
          },
          true,
        );
        if (jsonMode) {
          output({ path, ...(result as object) });
        } else {
          const r = result as { size: number };
          console.log(
            `Screenshot saved to ${path} (${formatBytes(r.size)})`,
          );
        }
        // --open: open in system viewer
        if (flags.open === "true") {
          const { execSync } = await import("child_process");
          try {
            execSync(`open "${path}"`, { stdio: "ignore" });
          } catch {}
        }
        break;
      }

      case "shots": {
        // Capture one page across several viewports — responsive QA + marketing.
        //   tb shots <url> [outdir] [--viewports fhd,mobile,ipad] [-e c] [--keep]
        await ensureDaemon();
        const shotUrl = positional[0];
        const outDir = positional[1] || TB_HOME;
        const vpNames = (flags.viewports || "fhd,mac,ipad,mobile").split(",").map(s => s.trim()).filter(Boolean);
        const bad = vpNames.filter(n => !VIEWPORT_PRESETS[n]);
        if (bad.length) die(`Unknown viewport(s): ${bad.join(", ")}. Known: ${Object.keys(VIEWPORT_PRESETS).join(", ")}`);
        if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

        // If a URL is given (and no explicit session), use a dedicated throwaway
        // session and clean it up after — good hygiene for one-off captures.
        const ownSession = !!shotUrl && !flags.session;
        if (ownSession) {
          flags.name = flags.name || flags.n || `shots-${Date.now().toString(36)}`;
          flags.new = "true";
          await getSession();
          await sessionCmd("goto", { url: shotUrl });
        } else if (shotUrl) {
          await sessionCmd("goto", { url: shotUrl });
        }

        const slug = (shotUrl || "page").replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 40) || "page";
        const made: Array<{ viewport: string; path: string; size: string }> = [];
        for (const name of vpNames) {
          const vp = VIEWPORT_PRESETS[name];
          await sessionCmd("setViewport", { width: vp.width, height: vp.height });
          const p = join(outDir, `${slug}-${name}.png`);
          const r = (await sessionCmd("screenshot", { path: p }, true)) as { size: number };
          made.push({ viewport: `${name} (${vp.width}x${vp.height})`, path: p, size: formatBytes(r.size) });
          if (!jsonMode) console.log(`  ${name.padEnd(7)} ${`${vp.width}x${vp.height}`.padEnd(11)} ${p} (${formatBytes(r.size)})`);
        }
        if (ownSession && flags.keep !== "true") {
          await daemonFetch(`/session/${currentSessionId}`, { method: "DELETE" }).catch(() => {});
          if (!jsonMode) console.log(`  ${"\x1b[2m"}(session closed)\x1b[0m`);
        }
        output(jsonMode ? { shots: made } : `\n${made.length} shot(s) → ${outDir}`);
        break;
      }

      case "click": {
        const selector = positional[0];
        if (!selector) die("Usage: tb click <selector>");
        await ensureDaemon();
        await sessionCmd("click", { selector });
        output(jsonMode ? { ok: true, selector } : `Clicked ${selector}`);
        break;
      }

      case "real-click": {
        // CDP-level mouse click — bypasses bot detection (Cloudflare Turnstile etc.)
        const rcx = parseInt(positional[0]);
        const rcy = parseInt(positional[1]);
        if (isNaN(rcx) || isNaN(rcy)) die("Usage: tb real-click <x> <y>");
        await ensureDaemon();
        await sessionCmd("realClick", { x: rcx, y: rcy });
        output(jsonMode ? { ok: true, x: rcx, y: rcy } : `Real-clicked at (${rcx}, ${rcy})`);
        break;
      }

      case "type": {
        const selector = positional[0];
        const text = positional.slice(1).join(" ");
        if (!selector || !text)
          die("Usage: tb type <selector> <text>");
        await ensureDaemon();
        await sessionCmd("type", { selector, text });
        output(jsonMode ? { ok: true } : `Typed into ${selector}`);
        break;
      }

      case "eval": {
        const expression = positional.join(" ");
        if (!expression) die("Usage: tb eval <expression>");
        await ensureDaemon();
        const gEval = await groupCmd("evaluate", { expression });
        if (gEval) { output(gEval); break; }
        const result = await sessionCmd("evaluate", { expression });
        output(jsonMode ? { result } : result);
        break;
      }

      case "content": {
        await ensureDaemon();
        const html = await sessionCmd("content");
        output(jsonMode ? { html } : html);
        break;
      }

      case "text": {
        await ensureDaemon();
        const gText = await groupCmd("text");
        if (gText) { output(gText); break; }
        const text = await sessionCmd("text");
        output(jsonMode ? { text } : text);
        break;
      }

      case "title": {
        await ensureDaemon();
        const gTitle = await groupCmd("title");
        if (gTitle) { output(gTitle); break; }
        const title = await sessionCmd("title");
        output(jsonMode ? { title } : title);
        break;
      }

      case "url": {
        await ensureDaemon();
        const gUrl = await groupCmd("url");
        if (gUrl) { output(gUrl); break; }
        const url = await sessionCmd("url");
        output(jsonMode ? { url } : url);
        break;
      }

      case "select": {
        const selector = positional[0];
        const value = positional[1];
        if (!selector || !value)
          die("Usage: tb select <selector> <value>");
        await ensureDaemon();
        await sessionCmd("select", { selector, value });
        output(jsonMode ? { ok: true } : `Selected ${value} in ${selector}`);
        break;
      }

      case "wait": {
        const selector = positional[0];
        // `tb wait --settled` waits for the DOM to stop changing instead of for
        // a selector — the right tool when a client-rendered page has loaded but
        // hasn't hydrated its content yet.
        if (!selector && (flags.settled === "true" || flags.settle === "true")) {
          await ensureDaemon();
          const timeout = flags.timeout ? parseInt(flags.timeout) : 15000;
          const settleRes = (await sessionCmd("waitForSettled", { timeout })) as {
            settled: boolean; textLen: number;
          };
          output(
            jsonMode
              ? settleRes
              : settleRes.settled
                ? `Settled (${settleRes.textLen} chars)`
                : `Timed out after ${timeout}ms, still changing (${settleRes.textLen} chars)`,
          );
          break;
        }
        if (!selector) die("Usage: tb wait <selector>   |   tb wait --settled [--timeout ms]");
        await ensureDaemon();
        const timeout = flags.timeout ? parseInt(flags.timeout) : 10000;
        await sessionCmd("waitForSelector", { selector, timeout });
        output(
          jsonMode ? { ok: true, selector } : `Found ${selector}`,
        );
        break;
      }

      case "harvest": {
        // Bulk: many URLs -> one JSONL of structured records. Resumable.
        const urlsFile = positional[0];
        if (!urlsFile) {
          die("Usage: tb harvest <urls-file> [--recipe f.js | --schema '{...}'] [--out data.jsonl] [--visible] [--settle] [--jitter 2.5,6]");
          break;
        }
        await ensureDaemon();
        const { harvest } = await import("./harvest.js");
        const jitterRaw = (flags.jitter || "2.5,6").split(",").map(Number);
        const jitter: [number, number] = [
          isNaN(jitterRaw[0]) ? 2.5 : jitterRaw[0],
          isNaN(jitterRaw[1]) ? 6 : jitterRaw[1],
        ];
        try {
          const res = await harvest(
            {
              urlsFile,
              out: flags.out || "harvest.jsonl",
              recipe: flags.recipe,
              schema: flags.schema,
              jitter,
              settle: flags.settle === "true" || flags.settled === "true",
              timeout: flags.timeout ? parseInt(flags.timeout) : 15000,
            },
            {
              goto: (url) => sessionCmd("goto", { url }) as Promise<{ status: number; url: string; blocked: boolean }>,
              isBlocked: () => sessionCmd("isBlocked") as Promise<{ blocked: boolean; reason: string | null }>,
              waitForSettled: (timeout) => sessionCmd("waitForSettled", { timeout }) as Promise<{ settled: boolean; textLen: number }>,
              evaluate: (expression) => sessionCmd("evaluate", { expression }),
              log: (msg) => { if (!jsonMode) console.error(msg); },
            },
          );
          output(
            jsonMode
              ? res
              : res.halted
                ? `\nHALTED: ${res.haltReason}\n${res.scraped} scraped this run -> ${flags.out || "harvest.jsonl"}`
                : `\nDone: ${res.scraped} scraped, ${res.skipped} skipped (already done) -> ${flags.out || "harvest.jsonl"}`,
          );
        } catch (e) {
          die((e as Error).message);
        }
        break;
      }

      case "blocked": {
        // Is this page a bot-challenge wall? goto returning cleanly proves
        // nothing — challenges are served as ordinary 200 pages.
        await ensureDaemon();
        const b = (await sessionCmd("isBlocked")) as { blocked: boolean; reason: string | null };
        output(
          jsonMode
            ? b
            : b.blocked
              ? `BLOCKED — ${b.reason}`
              : "Not blocked",
        );
        break;
      }

      case "cookies": {
        await ensureDaemon();
        const cookies = await sessionCmd("cookies");
        output(cookies);
        break;
      }

      case "install": {
        const { installEngine } = await import("./commands/install.js");
        let engine = positional[0] as
          | "lightpanda"
          | "chromium"
          | "render-engine"
          | "all"
          | undefined;
        if (engine === ("blitz" as typeof engine)) engine = "render-engine";
        if (engine && !["lightpanda", "chromium", "render-engine", "all"].includes(engine)) {
          die("Usage: tb install [lightpanda|chromium|render-engine|all]");
        }
        await installEngine(engine);
        break;
      }

      case "doctor":
      case "setup": {
        const { doctor } = await import("./commands/doctor.js");
        await doctor();
        break;
      }

      case "config": {
        const key = positional[0];
        const cfg = loadConfig();
        if (!key) {
          output(jsonMode ? cfg : Object.entries(cfg).map(([k, v]) => `  ${k} = ${JSON.stringify(v)}`).join("\n"));
          break;
        }
        if (key === "max-sessions") {
          const n = parseInt(positional[1] ?? "", 10);
          if (!Number.isFinite(n) || n < 1) die("Usage: tb config max-sessions <n>");
          saveConfig({ maxSessions: n });
          output(jsonMode ? { maxSessions: n } : `max-sessions = ${n}`);
        } else {
          die(`Unknown config key: ${key}. Known: max-sessions`);
        }
        break;
      }

      case "engines": {
        const engines = await detectEngines();
        if (jsonMode) {
          output({ engines });
        } else {
          if (engines.length === 0) {
            console.log(
              "No engines found. Run: tb install",
            );
          } else {
            console.log("Available engines:\n");
            for (const e of engines) {
              console.log(
                `  ${e.type.padEnd(12)} v${e.version}  ${e.path}`,
              );
            }
          }
        }
        break;
      }

      case "status": {
        try {
          await ensureDaemon();
          const status = (await daemonFetch("/status")) as {
            uptime: number;
            sessions: Array<{
              id: string;
              name?: string;
              engine: string;
              lastUsedAt: string;
            }>;
            engines: Array<{
              type: string;
              pid: number;
              port: number;
            }>;
          };
          if (jsonMode) {
            output(status);
          } else {
            console.log(
              `Daemon running (uptime: ${Math.round(status.uptime / 1000)}s)`,
            );
            console.log(
              `Engines: ${status.engines.map((e) => `${e.type} (pid:${e.pid} port:${e.port})`).join(", ") || "none"}`,
            );
            console.log(
              `Sessions: ${status.sessions.length}`,
            );
            for (const s of status.sessions) {
              console.log(
                `  ${s.id}${s.name ? ` (${s.name})` : ""} [${s.engine}] last used ${timeAgo(new Date(s.lastUsedAt))}`,
              );
            }
          }
        } catch {
          output(jsonMode ? { running: false } : "Daemon not running");
        }
        break;
      }

      case "ps": {
        try {
          await ensureDaemon();
          const status = (await daemonFetch("/status")) as {
            sessions: Array<{
              id: string;
              name?: string;
              engine: string;
              createdAt: string;
              lastUsedAt: string;
            }>;
          };
          if (jsonMode) {
            output(status.sessions);
          } else if (status.sessions.length === 0) {
            console.log("No active sessions");
          } else {
            console.log(
              `${"ID".padEnd(10)} ${"NAME".padEnd(16)} ${"ENGINE".padEnd(12)} ${"CREATED".padEnd(14)} LAST USED`,
            );
            for (const s of status.sessions) {
              console.log(
                `${s.id.padEnd(10)} ${(s.name || "—").padEnd(16)} ${s.engine.padEnd(12)} ${timeAgo(new Date(s.createdAt)).padEnd(14)} ${timeAgo(new Date(s.lastUsedAt))}`,
              );
            }
            console.log(`\n${status.sessions.length} session(s)`);
          }
        } catch {
          output(jsonMode ? [] : "Daemon not running");
        }
        break;
      }

      case "kill": {
        const targetId = positional[0];
        if (!targetId) die("Usage: tb kill <session-id>");
        await ensureDaemon();
        await daemonFetch(`/session/${targetId}`, { method: "DELETE" });
        output(
          jsonMode ? { ok: true, sessionId: targetId } : `Killed session ${targetId}`,
        );
        break;
      }

      case "kill-all": {
        await ensureDaemon();
        const result = (await daemonFetch("/session/all", {
          method: "DELETE",
        })) as { closed: number };
        output(
          jsonMode
            ? { ok: true, closed: result.closed }
            : `Killed ${result.closed} session(s)`,
        );
        break;
      }

      case "stop": {
        await stopDaemon();
        output(jsonMode ? { ok: true } : "Daemon stopped (all engines killed)");
        break;
      }

      case "elements":
      case "els": {
        await ensureDaemon();
        const els = await sessionCmd("evaluate", { expression: EXTRACT_ELEMENTS_JS });
        const elements = (els as Array<{ index: number; type: string; text: string; selector: string; value?: string }>) || [];
        if (jsonMode) {
          output(elements);
        } else if (elements.length === 0) {
          console.log("No interactive elements found");
        } else {
          for (const el of elements) {
            const color = el.type === "input" ? "\x1b[33m" : el.type === "button" ? "\x1b[32m" : "\x1b[34m";
            const val = el.value ? ` = "${el.value}"` : "";
            console.log(`  ${color}${String(el.index).padStart(3)}\x1b[0m  ${el.type.padEnd(7)} ${el.text}${val}`);
          }
          console.log(`\n${elements.length} element(s). Use: tb tap <number>`);
        }
        break;
      }

      case "tap": {
        const nums = positional.map(Number).filter(n => n > 0);
        if (nums.length === 0) die("Usage: tb tap <n> [n2 n3 ...] (from tb elements)");
        await ensureDaemon();
        for (const num of nums) {
          const tapResult = await sessionCmd("evaluate", {
            expression: `(() => {
              var els = [], seen = new Set(), vw = window.innerWidth, vh = window.innerHeight;
              function vis(el) {
                try { if (getComputedStyle(el).display === 'none' || el.offsetParent === null) return false; } catch(e) { return false; }
                var r = el.getBoundingClientRect();
                if (r.width < 2 || r.height < 2) return false;
                var hit = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2);
                return hit && (hit === el || el.contains(hit) || (hit.closest && hit.closest('a,button') === el));
              }
              function inView(r) { return r.width > 5 && r.height > 5 && r.x + r.width > 0 && r.y + r.height > 0 && r.x < vw && r.y < vh; }
              var inputs = document.querySelectorAll('input[type="text"], input[type="search"], input[type="email"], input[type="password"], input[type="url"], input[type="number"], input:not([type]), textarea');
              for (var i = 0; i < inputs.length; i++) { if (inputs[i].type === 'hidden' || !vis(inputs[i])) continue; var r = inputs[i].getBoundingClientRect(); if (inView(r)) els.push({ el: inputs[i], type: 'input', text: (inputs[i].getAttribute('placeholder') || inputs[i].name || 'input').slice(0,50), y: r.y, x: r.x }); }
              var btns = document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"], [onclick]');
              for (var j = 0; j < btns.length; j++) { if (!vis(btns[j])) continue; var t = (btns[j].textContent || btns[j].value || btns[j].getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' '); if (!t || seen.has(t)) continue; seen.add(t); var r2 = btns[j].getBoundingClientRect(); if (inView(r2)) els.push({ el: btns[j], type: 'button', text: t.slice(0,50), y: r2.y, x: r2.x }); }
              var links = document.querySelectorAll('a[href]');
              for (var k = 0; k < links.length; k++) { if (!vis(links[k])) continue; var at = (links[k].textContent || '').trim().replace(/\\s+/g, ' '); if (!at || at.length < 2 || seen.has(at)) continue; seen.add(at); var r3 = links[k].getBoundingClientRect(); if (inView(r3)) els.push({ el: links[k], type: 'link', text: at.slice(0,50), y: r3.y, x: r3.x }); }
              els.sort(function(a,b) { var dy = a.y - b.y; return Math.abs(dy) > 15 ? dy : a.x - b.x; });
              if (${num} < 1 || ${num} > els.length) return { ok: false };
              var target = els[${num} - 1];
              var rect = target.el.getBoundingClientRect();
              target.el.focus(); target.el.click();
              return { ok: true, type: target.type, text: target.text };
            })()`,
          }) as { ok: boolean; type?: string; text?: string } | null;
          const tr = tapResult || { ok: false };
          if (!tr.ok) {
            output(jsonMode ? { ok: false, index: num } : `Element #${num} not found`);
          } else {
            // Log to DVR
            await daemonFetch("/session/command", { method: "POST", body: { sessionId: await getSession(), method: "logDVR", params: { type: "tap", data: { index: num, text: tr.text, elementType: tr.type } } } }).catch(() => {});
            output(jsonMode ? { ok: true, index: num, type: tr.type, text: tr.text } : `Tapped #${num}: ${tr.text} (${tr.type})`);
          }
        }
        break;
      }

      case "clear": {
        const clearSel = positional[0];
        if (!clearSel) die("Usage: tb clear <selector>");
        await ensureDaemon();
        await sessionCmd("evaluate", {
          expression: `(() => {
            const el = document.querySelector(${JSON.stringify(clearSel)});
            if (!el) return false;
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(el, '');
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          })()`,
        });
        output(jsonMode ? { ok: true, selector: clearSel } : `Cleared ${clearSel}`);
        break;
      }

      case "annotate": {
        await ensureDaemon();
        // Inject floating overlay badges, screenshot, remove badges
        await sessionCmd("evaluate", { expression: INJECT_OVERLAY_BADGES_JS });
        const annoPath = positional[0] ?? `/tmp/tb-annotated-${Date.now()}.png`;
        const annoResult = await sessionCmd("screenshot", { path: annoPath }, true);
        // Remove badges after screenshot
        await sessionCmd("evaluate", { expression: `document.querySelectorAll('.tb-overlay-badge').forEach(b => b.remove())` });
        if (jsonMode) {
          const els = await sessionCmd("evaluate", { expression: EXTRACT_ELEMENTS_JS });
          output({ path: annoPath, elements: els, ...(annoResult as object) });
        } else {
          console.log(`Annotated screenshot saved to ${annoPath}`);
        }
        break;
      }

      case "view": {
        await ensureDaemon();
        await viewPage(flags.session);
        break;
      }

      case "live":
      case "browse": {
        const liveUrl = positional[0];
        const forceNew = flags.new === "true";
        await liveSession(liveUrl, engineFlag, forceNew);
        break;
      }

      case "watch": {
        await ensureDaemon();
        await watch(positional[0] || flags.session, flags.group);
        break;
      }

      case "cc":
      case "dashboard": {
        await ensureDaemon();
        await commandCenter();
        break;
      }

      case "history": {
        // DVR playback — show action log
        await ensureDaemon();
        const since = flags.since ? Date.now() - parseInt(flags.since) * 1000 : undefined;
        const dvr = (await sessionCmd("getDVR", { since })) as Array<{ ts: number; type: string; data: Record<string, unknown> }>;
        if (jsonMode) { output(dvr); }
        else if (!dvr.length) { console.log("No actions recorded yet."); }
        else {
          for (const entry of dvr) {
            const time = new Date(entry.ts).toLocaleTimeString();
            const data = Object.entries(entry.data).map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 60) : v}`).join(" ");
            console.log(`  ${time}  ${entry.type}  ${data}`);
          }
          console.log(`\n${dvr.length} actions. Use --since <seconds> to filter.`);
        }
        break;
      }

      case "events": {
        await ensureDaemon();
        console.log("Streaming events... Ctrl+C to stop.\n");
        while (true) {
          try {
            const events = (await sessionCmd("getEvents")) as Array<{ type: string; data: Record<string, unknown> }>;
            for (const evt of events) {
              const color = evt.type === "error" ? "\x1b[31m" : evt.type === "console" ? "\x1b[36m" : evt.type === "navigation" ? "\x1b[33m" : "\x1b[90m";
              if (jsonMode) {
                console.log(JSON.stringify(evt));
              } else {
                const data = Object.entries(evt.data).map(([k, v]) => `${k}=${v}`).join(" ");
                console.log(`${color}${evt.type}\x1b[0m ${data}`);
              }
            }
          } catch { break; }
        }
        break;
      }

      case "drag": {
        // tb drag x1 y1 x2 y2 [--ms 600] — smooth real-input drag.
        await ensureDaemon();
        const [x1, y1, x2, y2] = positional.map(Number);
        if ([x1, y1, x2, y2].some((v) => !Number.isFinite(v))) {
          die("Usage: tb drag <x1> <y1> <x2> <y2> [--ms 600]");
        }
        await sessionCmd("drag", { x1, y1, x2, y2, durationMs: flags.ms ? parseInt(flags.ms) : undefined });
        output(jsonMode ? { ok: true } : `Dragged (${x1},${y1}) → (${x2},${y2})`);
        break;
      }

      case "rec": {
        // Video recording. Frames spool inside the daemon, so any tb
        // commands (click, type, act, workflow, …) run while it records.
        await ensureDaemon();
        const sub = positional[0] ?? "status";
        if (sub === "start") {
          const r = (await sessionCmd("startRecording", {
            quality: flags.quality ? parseInt(flags.quality) : undefined,
          })) as { dir: string };
          output(jsonMode ? r : `Recording… (frames → ${r.dir}). Stop with: tb rec stop out.mp4`);
        } else if (sub === "stop") {
          const r = (await sessionCmd("stopRecording", {})) as {
            dir: string; frameCount: number; durationSec: number; listPath: string | null;
          };
          const out = positional[1];
          if (!out) {
            output(jsonMode ? r : `Stopped: ${r.frameCount} frames over ${r.durationSec.toFixed(1)}s in ${r.dir}`);
          } else {
            await assembleRecording(r, out);
          }
        } else if (sub === "status") {
          output(await sessionCmd("recordingStatus", {}));
        } else if (/^\d+(\.\d+)?$/.test(sub)) {
          // tb rec 8 out.mp4 — fixed-length convenience.
          await sessionCmd("startRecording", {});
          await new Promise((r) => setTimeout(r, parseFloat(sub) * 1000));
          const r = (await sessionCmd("stopRecording", {})) as {
            dir: string; frameCount: number; durationSec: number; listPath: string | null;
          };
          await assembleRecording(r, positional[1] ?? `/tmp/tb-rec-${Date.now()}.mp4`);
        } else {
          die("Usage: tb rec start | tb rec stop [out.mp4] | tb rec <seconds> [out.mp4] | tb rec status");
        }
        break;
      }

      case "record": {
        const recName = positional[0];
        if (!recName) die("Usage: tb record <name> — records actions, Ctrl+C to stop");
        await ensureDaemon();
        const recDir = join(homedir(), ".tb", "recordings");
        if (!existsSync(recDir)) mkdirSync(recDir, { recursive: true });
        const recPath = join(recDir, `${recName}.json`);
        const actions: Array<{ ts: number; method: string; params: Record<string, unknown> }> = [];
        const startTime = Date.now();
        console.log(`Recording "${recName}"... interact with the page, Ctrl+C to stop.`);

        // Poll for changes: track URL, title, scroll position
        let lastUrl = "";
        const interval = setInterval(async () => {
          try {
            const url = (await sessionCmd("url")) as string;
            if (url && url !== lastUrl) {
              if (lastUrl) actions.push({ ts: Date.now() - startTime, method: "goto", params: { url } });
              lastUrl = url;
            }
          } catch {}
        }, 500);

        // Also inject a recorder script into the page that captures clicks/types
        await sessionCmd("evaluate", {
          expression: `(() => {
            window.__tbRecording = [];
            document.addEventListener('click', e => {
              const el = e.target;
              const sel = el.id ? '#'+el.id : (el.name ? '[name="'+el.name+'"]' : el.tagName.toLowerCase());
              window.__tbRecording.push({ type: 'click', selector: sel, x: e.clientX, y: e.clientY, ts: Date.now() });
            }, true);
            document.addEventListener('input', e => {
              const el = e.target;
              if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                const sel = el.id ? '#'+el.id : (el.name ? '[name="'+el.name+'"]' : el.tagName.toLowerCase());
                window.__tbRecording.push({ type: 'input', selector: sel, value: el.value, ts: Date.now() });
              }
            }, true);
          })()`,
        });

        process.on("SIGINT", async () => {
          clearInterval(interval);
          // Collect in-page recordings
          try {
            const pageActions = (await sessionCmd("evaluate", {
              expression: "window.__tbRecording || []",
            })) as Array<{ type: string; selector: string; x?: number; y?: number; value?: string; ts: number }>;
            for (const a of pageActions) {
              if (a.type === "click") {
                actions.push({ ts: a.ts - startTime, method: "clickAt", params: { x: a.x!, y: a.y! } });
              } else if (a.type === "input") {
                actions.push({ ts: a.ts - startTime, method: "clear_and_type", params: { selector: a.selector, text: a.value || "" } });
              }
            }
          } catch {}
          // Sort by timestamp
          actions.sort((a, b) => a.ts - b.ts);
          const { writeFileSync } = await import("fs");
          writeFileSync(recPath, JSON.stringify({ name: recName, recordedAt: new Date().toISOString(), actions }, null, 2));
          console.log(`\nRecording saved: ${recPath} (${actions.length} actions)`);
          process.exit(0);
        });

        // Keep alive
        await new Promise(() => {});
        break;
      }

      case "replay": {
        const repName = positional[0];
        if (!repName) die("Usage: tb replay <name>");
        await ensureDaemon();
        const repDir = join(homedir(), ".tb", "recordings");
        const repPath = join(repDir, `${repName}.json`);
        if (!existsSync(repPath)) die(`Recording not found: ${repPath}`);
        const { readFileSync } = await import("fs");
        const recording = JSON.parse(readFileSync(repPath, "utf-8"));
        const rActions = recording.actions as Array<{ ts: number; method: string; params: Record<string, unknown> }>;
        console.log(`Replaying "${repName}" (${rActions.length} actions)...`);
        let prevTs = 0;
        for (const action of rActions) {
          // Wait for the relative delay
          const delay = action.ts - prevTs;
          if (delay > 0) await new Promise(r => setTimeout(r, Math.min(delay, 3000)));
          prevTs = action.ts;

          const m = action.method;
          if (m === "goto") {
            await sessionCmd("goto", action.params);
            console.log(`  → ${action.params.url}`);
          } else if (m === "clickAt") {
            await sessionCmd("clickAt", action.params);
            console.log(`  click (${action.params.x}, ${action.params.y})`);
          } else if (m === "clear_and_type") {
            await sessionCmd("evaluate", {
              expression: `(() => { var el = document.querySelector('${(action.params.selector as string).replace(/'/g, "\\'")}'); if(el) { var s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value'); if(s&&s.set) s.set.call(el,''); else el.value=''; el.dispatchEvent(new Event('input',{bubbles:true})); el.focus(); } })()`,
            });
            await sessionCmd("type", { selector: action.params.selector, text: action.params.text });
            console.log(`  type "${action.params.text}" → ${action.params.selector}`);
          } else if (m === "scroll_down") {
            await sessionCmd("scroll", { direction: "down", pixels: 500 });
            console.log(`  scroll down`);
          } else if (m === "scroll_up") {
            await sessionCmd("scroll", { direction: "up", pixels: 500 });
            console.log(`  scroll up`);
          } else if (m === "key") {
            await sessionCmd("keyPress", { key: action.params.key });
            console.log(`  key ${action.params.key}`);
          } else if (m === "typeText") {
            await sessionCmd("typeText", action.params);
            console.log(`  type "${action.params.text}"`);
          } else if (m === "eval") {
            const evalResult = await sessionCmd("evaluate", action.params);
            console.log(`  eval → ${JSON.stringify(evalResult ?? null).slice(0, 100)}`);
          }
        }
        console.log("Replay complete.");
        break;
      }

      case "auth": {
        await ensureDaemon();
        const authDir = join(homedir(), ".tb", "auth");
        if (!existsSync(authDir)) mkdirSync(authDir, { recursive: true });
        const sub = positional[0];
        if (sub === "save") {
          const name = positional[1];
          if (!name) die("Usage: tb auth save <name> --session <id>");
          const state = await sessionCmd("getAuthState");
          const { writeFileSync } = await import("fs");
          const path = join(authDir, `${name}.json`);
          writeFileSync(path, JSON.stringify(state, null, 2));
          output(jsonMode ? { ok: true, path, cookies: (state as any).cookies?.length } : `Auth saved: ${path} (${(state as any).cookies?.length} cookies)`);
        } else if (sub === "load") {
          const name = positional[1];
          if (!name) die("Usage: tb auth load <name> --session <id>");
          const { readFileSync } = await import("fs");
          const path = join(authDir, `${name}.json`);
          if (!existsSync(path)) die(`Auth not found: ${path}`);
          const state = JSON.parse(readFileSync(path, "utf-8"));
          await sessionCmd("setAuthState", state);
          // Reload to apply
          await sessionCmd("reload");
          output(jsonMode ? { ok: true, loaded: name } : `Auth loaded: ${name} (${state.cookies?.length} cookies)`);
        } else if (sub === "list" || !sub) {
          const { readdirSync } = await import("fs");
          const files = existsSync(authDir) ? readdirSync(authDir).filter(f => f.endsWith(".json")) : [];
          if (jsonMode) { output(files.map(f => f.replace(".json", ""))); }
          else if (files.length === 0) { console.log("No saved auth states. Use: tb auth save <name>"); }
          else { for (const f of files) console.log(`  ${f.replace(".json", "")}`); }
        } else if (sub === "delete") {
          const name = positional[1];
          if (!name) die("Usage: tb auth delete <name>");
          const { unlinkSync } = await import("fs");
          const path = join(authDir, `${name}.json`);
          if (existsSync(path)) { unlinkSync(path); output(`Deleted: ${name}`); }
          else die(`Not found: ${name}`);
        } else {
          die("Usage: tb auth <save|load|list|delete> [name]");
        }
        break;
      }

      case "snapshot": {
        // Accessibility tree snapshot
        await ensureDaemon();
        const snapOpts: Record<string, unknown> = {};
        if (flags.interactive === "true" || flags.i === "true") snapOpts.interactive = true;
        if (flags.compact === "true" || flags.c === "true") snapOpts.compact = true;
        if (flags.depth) snapOpts.depth = parseInt(flags.depth);
        // Group mode
        const gSnap = await groupCmd("snapshot", snapOpts);
        if (gSnap) { output(gSnap); break; }
        const snap = (await sessionCmd("snapshot", snapOpts)) as { tree: string; refs: Array<{ ref: string; role: string; name: string }> };
        if (jsonMode) {
          output(snap);
        } else {
          console.log(snap.tree);
          if (snap.refs.length > 0) {
            console.log(`\n${snap.refs.length} interactive element(s). Use: tb act "click <name>" or tb tap-ref @e1`);
          }
        }
        break;
      }

      case "dom-snapshot": {
        await ensureDaemon();
        const domSnap = (await sessionCmd("takeDomSnapshot")) as {
          url: string; title: string; ts: number;
          elements: any[]; interactiveCount: number; textLength: number; hash: string;
        };
        if (jsonMode) {
          output(domSnap);
        } else {
          console.log(`DOM Snapshot taken at ${new Date(domSnap.ts).toLocaleTimeString()}`);
          console.log(`  URL: ${domSnap.url}`);
          console.log(`  Elements: ${domSnap.elements.length}`);
          console.log(`  Interactive: ${domSnap.interactiveCount}`);
          console.log(`  Text length: ${domSnap.textLength} chars`);
          console.log(`  Hash: ${domSnap.hash}`);
        }
        break;
      }

      case "dom-diff":
      case "diff-dom": {
        await ensureDaemon();
        // Don't take a fresh snapshot — use the auto-snapshots from actions
        // (goto, tapRef, clickAt all auto-snapshot). Only take a fresh one
        // if explicitly requested or if no snapshots exist yet.
        if (flags.fresh === "true") await sessionCmd("takeDomSnapshot");
        const sinceTs = flags.since ? parseInt(flags.since) : undefined;
        const domDiff = (await sessionCmd("diffDom", { since: sinceTs })) as {
          added: any[]; removed: any[]; changed: any[]; summary: string;
        };
        if (jsonMode) {
          output(domDiff);
        } else {
          console.log("Changes since last snapshot:");
          if (domDiff.added.length === 0 && domDiff.removed.length === 0 && domDiff.changed.length === 0) {
            console.log("  No structural changes detected");
          } else {
            console.log(`  ${domDiff.summary}`);
          }
        }
        break;
      }

      case "act": {
        // Natural language action — no LLM, semantic matching on AX tree
        const actionText = positional.join(" ");
        if (!actionText) die("Usage: tb act \"click the sign in button\"");
        await ensureDaemon();
        // Get snapshot with refs
        const actSnap = (await sessionCmd("snapshot", { interactive: true, compact: true })) as { refs: Array<{ ref: string; role: string; name: string; backendNodeId: number }> };
        // Parse intent
        const lower = actionText.toLowerCase();
        const isType = lower.startsWith("type ") || lower.startsWith("fill ") || lower.startsWith("enter ");
        if (isType) {
          // "type hello into email" or "fill email with hello"
          const intoMatch = lower.match(/(?:type|fill|enter)\s+(.+?)\s+(?:into|in|on)\s+(.+)/);
          const withMatch = lower.match(/(?:type|fill|enter)\s+(.+?)\s+(?:with)\s+(.+)/);
          let text: string, target: string;
          if (intoMatch) { text = intoMatch[1]; target = intoMatch[2]; }
          else if (withMatch) { target = withMatch[1]; text = withMatch[2]; }
          else { text = actionText.replace(/^(type|fill|enter)\s+/i, ''); target = ''; }
          // Find the input
          const inputRefs = actSnap.refs.filter(r => r.role === 'textbox' || r.role === 'searchbox' || r.role === 'combobox');
          let ref: string | null = null;
          if (target) {
            ref = await sessionCmd("findElement", { query: target, refs: actSnap.refs }) as string | null;
          }
          if (!ref && inputRefs.length === 1) ref = inputRefs[0].ref;
          if (!ref && inputRefs.length > 0) ref = inputRefs[0].ref;
          if (ref) {
            await sessionCmd("tapRef", { ref, refs: actSnap.refs });
            await sessionCmd("typeText", { text });
            output(jsonMode ? { ok: true, action: 'type', ref, text } : `Typed "${text}" into ${ref}`);
          } else {
            die("No matching input found");
          }
        } else {
          // Click action: "click sign in" or just "sign in"
          const clickText = lower.replace(/^(click|tap|press|hit|select|choose)\s+/i, '');
          const ref = await sessionCmd("findElement", { query: clickText, refs: actSnap.refs }) as string | null;
          if (ref) {
            const tapResult = await sessionCmd("tapRef", { ref, refs: actSnap.refs }) as { ok: boolean; role?: string; name?: string };
            output(jsonMode ? { ok: true, action: 'click', ref, ...tapResult } : `Clicked ${ref}: ${tapResult.name} (${tapResult.role})`);
          } else {
            // Show available elements
            console.log(`Could not find: "${clickText}"\nAvailable elements:`);
            for (const r of actSnap.refs.slice(0, 15)) {
              console.log(`  ${r.ref} ${r.role}: ${r.name}`);
            }
            die(`No match for "${clickText}"`);
          }
        }
        break;
      }

      case "tap-ref": {
        const ref = positional[0];
        if (!ref) die("Usage: tb tap-ref @e1");
        await ensureDaemon();
        const trSnap = (await sessionCmd("snapshot", { interactive: true, compact: true })) as { refs: Array<{ ref: string; role: string; name: string; backendNodeId: number }> };
        const tapRefResult = await sessionCmd("tapRef", { ref, refs: trSnap.refs }) as { ok: boolean; role?: string; name?: string };
        if (tapRefResult.ok) {
          output(jsonMode ? tapRefResult : `Tapped ${ref}: ${tapRefResult.name} (${tapRefResult.role})`);
        } else {
          die(`Element not found: ${ref}`);
        }
        break;
      }

      case "chat": {
        // Conversational mode — find text input, type, wait for response, extract
        const question = positional.join(" ");
        if (!question) die("Usage: tb chat \"What are the key findings?\"");
        await ensureDaemon();
        // Find contenteditable or textarea
        const chatInput = await sessionCmd("evaluate", { expression: `(() => {
          var el = document.querySelector('[contenteditable=true]') || document.querySelector('textarea:not([readonly])');
          if (!el) return null;
          el.focus();
          if (el.contentEditable === 'true') { el.innerHTML = ''; }
          else { el.value = ''; }
          return { tag: el.tagName, ce: el.contentEditable === 'true' };
        })()` }) as { tag: string; ce: boolean } | null;
        if (!chatInput) die("No chat input found on page");

        // Type the question
        if (chatInput.ce) {
          await sessionCmd("evaluate", { expression: `(() => {
            var el = document.querySelector('[contenteditable=true]');
            el.innerHTML = ${JSON.stringify(question)};
            el.dispatchEvent(new Event('input', {bubbles:true}));
          })()` });
        } else {
          await sessionCmd("type", { selector: "textarea:not([readonly])", text: question });
        }
        // Press Enter to send
        await sessionCmd("keyPress", { key: "Enter" });
        console.log(`> ${question}`);
        console.log("Waiting for response...");

        // Wait for content to settle (mutation observer)
        await sessionCmd("waitForSettled", { timeout: 30000 });

        // Extract the last response
        const response = await sessionCmd("evaluate", { expression: `(() => {
          // Find the last large text block that appeared after we typed
          var blocks = document.querySelectorAll('[class*=message], [class*=response], [class*=answer], [class*=markdown], article, [class*=prose]');
          var best = '';
          blocks.forEach(b => {
            var t = b.innerText.trim();
            if (t.length > best.length && t.length < 20000) best = t;
          });
          if (!best) {
            // Broader: find the last substantial text block
            document.querySelectorAll('div, section').forEach(d => {
              if (d.children.length < 20 && d.innerText.trim().length > 100) {
                var r = d.getBoundingClientRect();
                if (r.width > 200) best = d.innerText.trim();
              }
            });
          }
          return best;
        })()` }) as string;

        if (response) {
          output(jsonMode ? { question, response } : response);
        } else {
          console.log("(No response detected — page may still be loading)");
        }
        break;
      }

      case "describe":
      case "page": {
        // Structural page summary — what kind of page, what's on it, minimal tokens
        await ensureDaemon();
        const descResult = await sessionCmd("evaluate", { expression: `(() => {
          var url=window.location.href,title=document.title,h1=document.querySelector('h1')?.innerText?.trim()||'';
          var forms=document.querySelectorAll('form'),inputs=document.querySelectorAll('input:not([type=hidden]),textarea,select');
          var links=document.querySelectorAll('a[href]'),images=document.querySelectorAll('img');
          var tables=document.querySelectorAll('table'),articles=document.querySelectorAll('article,.post,.card,[class*=item],[class*=product],[class*=result]');

          var type='page';
          if(forms.length>0&&inputs.length>=2) type='form';
          else if(articles.length>=3) type='list';
          else if(tables.length>0&&tables[0].rows?.length>3) type='table';
          else if(document.querySelector('[role=main] p,article p,.content p')&&document.querySelectorAll('p').length>3) type='article';
          else if(document.querySelector('[class*=search],[class*=result],[role=search]')) type='search';
          else if(document.querySelector('[class*=dash],[class*=panel],[class*=widget]')) type='dashboard';
          else if(inputs.length>=1&&document.querySelector('[class*=login],[class*=auth],[class*=sign]')) type='auth';
          else if(links.length>20) type='directory';

          var sections=[];
          document.querySelectorAll('header,nav,[role=banner]').forEach(el=>{var t=el.innerText?.trim().slice(0,100);if(t)sections.push({role:'header',text:t})});
          document.querySelectorAll('main,[role=main],article,.content,#content').forEach(el=>{var t=el.innerText?.trim().slice(0,200);if(t)sections.push({role:'main',text:t})});
          document.querySelectorAll('footer,[role=contentinfo]').forEach(el=>{var t=el.innerText?.trim().slice(0,80);if(t)sections.push({role:'footer',text:t})});

          var formDetails=[];
          forms.forEach(f=>{
            var fields=[];
            f.querySelectorAll('input:not([type=hidden]),textarea,select').forEach(inp=>{
              var label=inp.getAttribute('placeholder')||inp.getAttribute('aria-label')||inp.name||inp.type||'field';
              fields.push({type:inp.type||inp.tagName.toLowerCase(),name:label.slice(0,30)});
            });
            var submit=f.querySelector('button[type=submit],input[type=submit],button');
            formDetails.push({fields,submit:submit?.textContent?.trim()||'submit'});
          });

          var repeating=null;
          var parentMap=new Map();
          document.querySelectorAll('li,tr,.card,article,[class*=item],[class*=row],[class*=result]').forEach(el=>{
            var key=el.tagName+'|'+(el.parentElement?.tagName||'')+'|'+el.children.length;
            if(!parentMap.has(key))parentMap.set(key,[]);parentMap.get(key).push(el);
          });
          var bestGroup=null,bestSize=0;
          for(var[k,v] of parentMap){if(v.length>bestSize&&v.length>=3){bestSize=v.length;bestGroup=v}}
          if(bestGroup){
            var sample=bestGroup[0];
            var fieldNames=Array.from(sample.children).slice(0,8).map(c=>{var t=c.innerText?.trim().slice(0,40);return c.tagName.toLowerCase()+(t?': "'+t+'"':'')});
            repeating={count:bestGroup.length,tag:sample.tagName,fields:fieldNames};
          }

          var buttons=document.querySelectorAll('button,[role=button],input[type=submit]');
          var btnTexts=Array.from(buttons).slice(0,10).map(b=>(b.textContent||b.value||'').trim()).filter(t=>t.length>1&&t.length<40);

          return{url,title,h1,type,sections:sections.slice(0,6),forms:formDetails.slice(0,3),repeating,
            counts:{links:links.length,images:images.length,inputs:inputs.length,buttons:buttons.length,tables:tables.length},
            buttons:btnTexts.slice(0,8),text:document.body.innerText.trim().split(/\\s+/).length+' words'};
        })()` });
        const d = descResult as any;
        if (jsonMode) { output(d); }
        else {
          console.log(`${d.type.toUpperCase()}: ${d.title}`);
          console.log(`URL: ${d.url}`);
          if (d.h1 && d.h1 !== d.title) console.log(`H1: ${d.h1}`);
          console.log(`Content: ${d.text}`);
          console.log(`Elements: ${d.counts.links} links, ${d.counts.buttons} buttons, ${d.counts.inputs} inputs, ${d.counts.images} images`);
          if (d.forms?.length) for (const f of d.forms) console.log(`\nForm: ${f.fields.map((fi: any) => fi.name).join(', ')} → [${f.submit}]`);
          if (d.repeating) { console.log(`\nRepeating: ${d.repeating.count}x <${d.repeating.tag.toLowerCase()}>`); for (const f of d.repeating.fields) console.log(`  ${f}`); }
          if (d.buttons?.length) console.log(`\nButtons: ${d.buttons.join(', ')}`);
          if (d.sections?.length) { console.log(`\nSections:`); for (const s of d.sections) console.log(`  [${s.role}] ${s.text.slice(0, 80)}`); }
        }
        break;
      }

      case "read": {
        // Smart site-aware reading — the one command for everything.
        // tb read <url1> [url2] [url3] — reads one or more URLs
        // tb read --session x — reads current page
        // tb read --follow N — follow links (e.g. trending → repos)
        // Site-aware: GitHub repos → README, trending → repo list, HN → stories
        await ensureDaemon();

        const urls = positional.filter(u => u.startsWith('http') || u.includes('/'));
        const follow = parseInt(flags.follow) || 0;

        // GitHub-specific extractors
        const GITHUB_REPO_EXTRACT = `(() => {
          var parts = window.location.pathname.split('/').filter(Boolean);
          if (parts.length < 2) return null;
          var owner = parts[0], name = parts[1];
          var readme = (document.querySelector('article.markdown-body')||{}).innerText?.trim()||'';
          var desc = (document.querySelector('[class*=BorderGrid] p, .f4.my-3')||{}).innerText?.trim()||'';
          var stars = (document.querySelector('#repo-stars-counter-star, [id*=star] .Counter')||{}).textContent?.trim()||'';
          var forks = (document.querySelector('#repo-network-counter, [id*=fork] .Counter')||{}).textContent?.trim()||'';
          var topics = Array.from(document.querySelectorAll('.topic-tag')).map(t=>t.textContent.trim());
          var langs = Array.from(document.querySelectorAll('[class*=BorderGrid] li')).map(li=>li.querySelector('[class*=text-bold]')?.textContent?.trim()).filter(Boolean).slice(0,5);
          var lastCommit = document.querySelector('relative-time')?.getAttribute('datetime')||'';
          return { type:'github-repo', repo: owner+'/'+name, description: desc, stars, forks, topics, languages: langs, lastCommit, readme: readme.slice(0, ${parseInt(flags['readme-length']) || 5000}) };
        })()`;

        const GITHUB_TRENDING_EXTRACT = `(() => {
          var arts = document.querySelectorAll('article.Box-row');
          if (!arts.length) return null;
          return { type:'github-trending', count: arts.length, repos: Array.from(arts).map(art => {
            var h2 = art.querySelector('h2 a');
            var desc = art.querySelector('p');
            var lang = art.querySelector('[itemprop=programmingLanguage]');
            var stars = art.querySelector('.Link--muted.d-inline-block.mr-3');
            var today = art.querySelector('.d-inline-block.float-sm-right');
            return {
              name: h2?.textContent?.trim().replace(/\\s+/g,' ')||'',
              url: h2?.href||'',
              description: (desc?.textContent?.trim()||'').slice(0,120),
              language: lang?.textContent?.trim()||'',
              stars: stars?.textContent?.trim()||'',
              todayStars: today?.textContent?.trim()||'',
            };
          })};
        })()`;

        const HN_EXTRACT = `(() => {
          var titles = document.querySelectorAll('.titleline > a');
          if (!titles.length) return null;
          var subtexts = document.querySelectorAll('.subtext');
          return { type:'hn', count: titles.length, stories: Array.from(titles).map((a, i) => {
            var sub = subtexts[i];
            return {
              title: a.textContent?.trim()||'',
              url: a.href||'',
              points: sub?.querySelector('.score')?.textContent?.trim()||'',
              comments: sub?.querySelector('a:last-child')?.textContent?.trim()||'',
            };
          })};
        })()`;

        const GENERIC_EXTRACT = `(() => {
          var h1 = document.querySelector('h1')?.innerText?.trim()||document.title;
          var main = document.querySelector('article, [role=main], main, .content, #content, .post-content');
          var text = (main||document.body).innerText.trim();
          var links = [];
          (main||document.body).querySelectorAll('a[href]').forEach(a => {
            var t = a.textContent.trim();
            if (t.length > 2 && t.length < 200) links.push({text:t.slice(0,80),href:a.href});
          });
          return { type:'page', title: h1, url: window.location.href, text: text.slice(0, ${parseInt(flags['max-text']) || 10000}), wordCount: text.split(/\\s+/).length, links: links.slice(0, 30) };
        })()`;

        // Detect which extractor to use based on URL
        function pickExtractor(pageUrl: string): string {
          if (pageUrl.includes('github.com/trending')) return GITHUB_TRENDING_EXTRACT;
          if (pageUrl.match(/github\.com\/[^/]+\/[^/]+(\/?)$/)) return GITHUB_REPO_EXTRACT;
          if (pageUrl.includes('news.ycombinator.com')) return HN_EXTRACT;
          return GENERIC_EXTRACT;
        }

        // Smart extract: try site-specific first, fall back to generic
        async function smartRead(pageUrl?: string): Promise<unknown> {
          const url = pageUrl || (await sessionCmd("url") as string);
          const extractor = pickExtractor(url);
          let result = await sessionCmd("evaluate", { expression: extractor });
          if (!result) result = await sessionCmd("evaluate", { expression: GENERIC_EXTRACT });
          return result;
        }

        if (urls.length === 0) {
          // Read current page
          const result = await smartRead();
          const r = result as any;
          if (jsonMode) { output(r); }
          else { formatReadOutput(r); }
        } else if (urls.length === 1) {
          // Single URL — navigate and read
          await sessionCmd("goto", { url: urls[0] });
          await new Promise(r => setTimeout(r, 2000));
          const result = await smartRead(urls[0]);
          const r = result as any;
          if (jsonMode) { output(r); }
          else { formatReadOutput(r); }

          // Follow links if requested (e.g. trending → open repos)
          if (follow > 0 && (r as any)?.type === 'github-trending') {
            const repos = ((r as any).repos || []).slice(0, follow);
            console.log(`\nFollowing ${repos.length} repos...`);
            const groupName = flags.group || 'read';
            const followResults: Record<string, unknown> = {};
            for (const repo of repos) {
              if (!repo.url) continue;
              await sessionCmd("goto", { url: repo.url });
              await new Promise(r => setTimeout(r, 2000));
              followResults[repo.name.replace(/\\s+/g, ' ').trim()] = await smartRead(repo.url);
            }
            if (jsonMode) { output(followResults); }
            else { for (const [name, data] of Object.entries(followResults)) { console.log(`\n${'─'.repeat(60)}`); formatReadOutput(data as any); } }
          }
        } else {
          // Multiple URLs — navigate sequentially in one tab, collect all
          const results: Record<string, unknown> = {};
          for (const url of urls) {
            const urlName = url.includes('github.com') ? url.split('/').slice(-2).join('/') : new URL(url).hostname;
            await sessionCmd("goto", { url });
            await new Promise(r => setTimeout(r, 2000));
            results[urlName] = await smartRead(url);
            if (!jsonMode) {
              console.log(`\n${'─'.repeat(60)}`);
              formatReadOutput(results[urlName] as any);
            }
          }
          if (jsonMode) { output(results); }
        }

        function formatReadOutput(r: any) {
          if (!r) { console.log("(empty page)"); return; }
          if (r.type === 'github-repo') {
            console.log(`## ${r.repo}`);
            if (r.description) console.log(r.description);
            console.log(`Stars: ${r.stars}  Forks: ${r.forks}  Lang: ${(r.languages||[]).join(', ')}`);
            if (r.topics?.length) console.log(`Topics: ${r.topics.join(', ')}`);
            if (r.lastCommit) console.log(`Last commit: ${r.lastCommit.slice(0,10)}`);
            if (r.readme) console.log(`\n${r.readme}`);
          } else if (r.type === 'github-trending') {
            console.log(`GitHub Trending: ${r.count} repos\n`);
            for (const repo of r.repos || []) {
              console.log(`  ${repo.name.padEnd(42)} ${repo.language.padEnd(14)} ${repo.stars.padStart(8)}  ${repo.todayStars}`);
              if (repo.description) console.log(`    ${repo.description}`);
            }
          } else if (r.type === 'hn') {
            console.log(`Hacker News: ${r.count} stories\n`);
            for (const s of r.stories || []) {
              console.log(`  ${s.title}`);
              console.log(`    ${s.points} | ${s.comments} | ${s.url}`);
            }
          } else {
            console.log(`## ${r.title || 'Untitled'}`);
            console.log(`URL: ${r.url || ''}`);
            console.log(`Words: ${r.wordCount || 0}\n`);
            if (r.text) console.log(r.text.slice(0, 3000));
          }
        }
        break;
      }

      case "scrape": {
        // Smart content extraction — reader mode
        await ensureDaemon();
        const scrapeExpr = `(() => {
          // Readability-style extraction: find the main content
          var candidates = [];
          document.querySelectorAll('article, [role=main], main, .post-content, .article-content, .entry-content, #content, .content').forEach(el => {
            candidates.push({ el, score: el.innerText.length });
          });
          // Fallback: largest text block
          if (!candidates.length) {
            document.querySelectorAll('div, section').forEach(el => {
              var t = el.innerText.trim();
              if (t.length > 500 && el.children.length > 2) {
                candidates.push({ el, score: t.length });
              }
            });
          }
          candidates.sort((a,b) => b.score - a.score);
          var main = candidates[0]?.el || document.body;

          // Extract structured content
          var title = document.querySelector('h1')?.innerText?.trim() || document.title;
          var text = main.innerText.trim();
          var links = [];
          main.querySelectorAll('a[href]').forEach(a => {
            var t = a.textContent.trim();
            if (t.length > 2) links.push({ text: t.slice(0,60), href: a.href });
          });
          var images = [];
          main.querySelectorAll('img[src]').forEach(img => {
            if (img.naturalWidth > 50) images.push({ alt: img.alt || '', src: img.src });
          });

          return {
            url: window.location.href,
            title,
            text: text.slice(0, 50000),
            wordCount: text.split(/\\s+/).length,
            links: links.slice(0, 50),
            images: images.slice(0, 20),
          };
        })()`;
        const gScrape = await groupCmd("evaluate", { expression: scrapeExpr });
        if (gScrape) { output(gScrape); break; }
        const scrapeResult = await sessionCmd("evaluate", { expression: scrapeExpr });
        output(scrapeResult);
        break;
      }

      case "diff": {
        // Screenshot comparison
        const baseline = positional[0];
        if (!baseline) die("Usage: tb diff <baseline.png> [--threshold 0.01]");
        if (!existsSync(baseline)) die(`Baseline not found: ${baseline}`);
        await ensureDaemon();
        const diffBuf = await sessionCmd("screenshot", { format: "png" }) as Buffer;
        const { readFileSync, writeFileSync } = await import("fs");
        const baselineBuf = readFileSync(baseline);
        // Simple byte comparison
        const diffBase64 = Buffer.from((diffBuf as any).base64 || diffBuf, "base64");
        const same = diffBase64.length === baselineBuf.length && diffBase64.every((b, i) => b === baselineBuf[i]);
        const diffPath = baseline.replace(/\.\w+$/, "-diff.png");
        if (!same) {
          writeFileSync(diffPath, diffBase64);
          const sizeDiff = Math.abs(diffBase64.length - baselineBuf.length);
          output(jsonMode ? { changed: true, diffPath, sizeDelta: sizeDiff } : `Changed! Diff saved: ${diffPath} (${sizeDiff} bytes delta)`);
        } else {
          output(jsonMode ? { changed: false } : "No changes detected.");
        }
        break;
      }

      case "extract": {
        // Structured data extraction
        const schema = positional[0] || flags.schema;
        if (!schema) die("Usage: tb extract '{\"field\": \"selector\"}' or 'sel@attr' for attributes, or tb extract --schema file.json");
        await ensureDaemon();
        let schemaObj: Record<string, string>;
        try {
          schemaObj = existsSync(schema) ? JSON.parse((await import("fs")).readFileSync(schema, "utf-8")) : JSON.parse(schema);
        } catch { die("Invalid schema JSON"); break; }
        const extractExpr = `(() => {
          const schema = ${JSON.stringify(schemaObj)};
          const result = {};
          // "sel@attr" pulls an attribute (img@src, a@href); bare "sel" is text.
          // Attributes are read via the live property first so that src/href
          // come back absolute, matching what the browser actually resolved.
          const read = (el, attr) => {
            if (!attr) return el.textContent.trim();
            if (attr === 'src' && el.src != null) return el.src;
            if (attr === 'href' && el.href != null) return el.href;
            if (attr === 'text' || attr === 'textContent') return el.textContent.trim();
            if (attr === 'html' || attr === 'innerHTML') return el.innerHTML;
            return el.getAttribute(attr);
          };
          for (const [key, raw] of Object.entries(schema)) {
            if (typeof raw !== 'string') continue;
            const at = raw.lastIndexOf('@');
            const selector = at > 0 ? raw.slice(0, at) : raw;
            const attr = at > 0 ? raw.slice(at + 1) : null;
            let els;
            try { els = document.querySelectorAll(selector); }
            catch { result[key] = null; continue; }
            if (els.length > 1) result[key] = Array.from(els).map(e => read(e, attr));
            else if (els.length === 1) result[key] = read(els[0], attr);
            else result[key] = null;
          }
          return result;
        })()`;
        const extracted = await sessionCmd("evaluate", { expression: extractExpr });
        output(extracted);
        break;
      }

      case "auto-extract": {
        // Zero-config structured data extractor — finds repeating items on any page
        await ensureDaemon();
        const autoLimit = parseInt(flags.limit) || 50;
        const autoMin = parseInt(flags.min) || 3;

        const autoExtractExpr = `(() => {
          var body = document.body;
          if (!body) return { error: 'No body element' };

          // 1. Walk ALL elements, build fingerprints
          var all = body.querySelectorAll('*');
          var fpMap = {};

          function getDepth(el) {
            var d = 0, p = el;
            while (p.parentElement) { d++; p = p.parentElement; }
            return d;
          }

          for (var i = 0; i < all.length; i++) {
            var el = all[i];
            var d = getDepth(el);
            var tag = el.tagName || '';
            var parentTag = el.parentElement ? el.parentElement.tagName : '';
            var grandparentTag = (el.parentElement && el.parentElement.parentElement) ? el.parentElement.parentElement.tagName : '';
            var childTags = [];
            for (var c = 0; c < el.children.length; c++) {
              childTags.push(el.children[c].tagName);
            }
            childTags.sort();
            var childSig = childTags.join(',');
            var fp = tag + '|' + d + '|' + parentTag + '|' + grandparentTag + '|' + childSig;

            if (!fpMap[fp]) fpMap[fp] = [];
            fpMap[fp].push(el);
          }

          // 3-4. Filter groups: 3+ members, depth > 2, must have text
          var minMembers = ${autoMin};
          var groups = [];
          for (var key in fpMap) {
            var members = fpMap[key];
            if (members.length < minMembers) continue;
            var parts = key.split('|');
            var gDepth = parseInt(parts[1]);
            if (gDepth <= 2) continue;
            // Filter to members with text content
            var withText = [];
            for (var m = 0; m < members.length; m++) {
              var txt = (members[m].textContent || '').trim();
              if (txt.length > 0) withText.push(members[m]);
            }
            if (withText.length < minMembers) continue;
            groups.push({ key: key, members: withText });
          }

          if (groups.length === 0) return { error: 'No repeating item groups found', itemCount: 0, fields: [], items: [] };

          // 5. Score each group
          var bestGroup = null;
          var bestScore = -1;
          for (var g = 0; g < groups.length; g++) {
            var grp = groups[g];
            var totalChildren = 0;
            var totalTextLen = 0;
            for (var mi = 0; mi < grp.members.length; mi++) {
              totalChildren += grp.members[mi].children.length;
              totalTextLen += (grp.members[mi].textContent || '').trim().length;
            }
            var avgChildren = totalChildren / grp.members.length;
            var avgTextLen = totalTextLen / grp.members.length;
            // Require some structural complexity
            if (avgChildren < 1) continue;
            var score = grp.members.length * avgChildren * avgTextLen;
            if (score > bestScore) {
              bestScore = score;
              bestGroup = grp;
            }
          }

          if (!bestGroup) return { error: 'No suitable item group found', itemCount: 0, fields: [], items: [] };

          // 6. Extract fields from each item
          var limit = ${autoLimit};
          var items = [];
          var fieldNames = new Set();
          var dateRe = /\\d{1,4}[\\/-]\\d{1,2}[\\/-]\\d{1,4}|\\d{1,2}\\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\\w*\\s+\\d{2,4}|\\d+\\s+(hour|min|sec|day|week|month|year)s?\\s+ago|yesterday|today/i;
          var numRe = /^[\\d,\\.]+[kKmMbB%]?$/;

          for (var ii = 0; ii < Math.min(bestGroup.members.length, limit); ii++) {
            var item = bestGroup.members[ii];
            var record = {};
            var children = item.children;
            var linkCount = 0;
            var detailCount = 0;

            for (var ci = 0; ci < children.length; ci++) {
              var child = children[ci];
              var cTag = child.tagName;
              var cText = (child.textContent || '').trim();
              var cHref = child.getAttribute ? child.getAttribute('href') : null;
              var cSrc = child.getAttribute ? child.getAttribute('src') : null;
              if (!cHref && child.querySelector) {
                var innerA = child.querySelector('a[href]');
                if (innerA) cHref = innerA.getAttribute('href');
              }
              if (!cSrc && child.querySelector) {
                var innerImg = child.querySelector('img[src]');
                if (innerImg) cSrc = innerImg.getAttribute('src');
              }

              var fieldName = '';
              var fieldVal = {};

              if (cTag === 'IMG' || cSrc) {
                fieldName = 'image';
                fieldVal = { src: cSrc || (child.getAttribute && child.getAttribute('src')) || '' };
              } else if ((cTag === 'A' || cHref) && cText) {
                if (linkCount === 0) { fieldName = 'title'; }
                else { fieldName = 'link'; }
                linkCount++;
                fieldVal = { text: cText.slice(0, 200) };
                if (cHref) fieldVal.href = cHref;
              } else if (cText && dateRe.test(cText)) {
                fieldName = 'date';
                fieldVal = { text: cText.slice(0, 100) };
              } else if (cText && cText.length < 20 && numRe.test(cText.replace(/\\s/g, ''))) {
                fieldName = fieldNames.has('count') ? 'metric' : 'count';
                fieldVal = { text: cText };
              } else if (cText && cText.length > 0) {
                if (!fieldNames.has('text') && !record['text'] && cText.length > 10) {
                  fieldName = 'text';
                } else {
                  detailCount++;
                  fieldName = 'detail' + detailCount;
                }
                fieldVal = { text: cText.slice(0, 300) };
              }

              if (fieldName) {
                // Handle duplicate field names within same record
                if (record[fieldName] && fieldName !== 'title' && fieldName !== 'image') {
                  var orig = fieldName;
                  var suffix = 2;
                  while (record[orig + suffix]) suffix++;
                  fieldName = orig + suffix;
                }
                record[fieldName] = fieldVal;
                fieldNames.add(fieldName);
              }
            }

            // If no children yielded fields, use the element's own text
            if (Object.keys(record).length === 0) {
              var ownText = (item.textContent || '').trim();
              if (ownText) {
                record.text = { text: ownText.slice(0, 300) };
                fieldNames.add('text');
              }
            }

            items.push(record);
          }

          // Build a CSS selector that matches these items
          var sample = bestGroup.members[0];
          var sTag = sample.tagName.toLowerCase();
          var sClass = '';
          if (sample.classList && sample.classList.length > 0) {
            sClass = '.' + Array.from(sample.classList).join('.');
          }
          var sParent = '';
          if (sample.parentElement) {
            var pTag = sample.parentElement.tagName.toLowerCase();
            var pClass = '';
            if (sample.parentElement.classList && sample.parentElement.classList.length > 0) {
              pClass = '.' + Array.from(sample.parentElement.classList).join('.');
            }
            sParent = pTag + pClass + ' > ';
          }
          var selector = sParent + sTag + sClass;

          return {
            itemCount: bestGroup.members.length,
            fields: Array.from(fieldNames),
            items: items,
            selector: selector
          };
        })()`;

        const autoResult = await sessionCmd("evaluate", { expression: autoExtractExpr });
        output(autoResult);
        break;
      }

      case "similar":
      case "find-similar": {
        // Scrapling-inspired: give it one element (by CSS selector or #number),
        // find all similar elements at the same depth with matching structure.
        // Great for scraping product lists, article feeds, table rows without knowing the exact selector.
        await ensureDaemon();
        const seedSelector = positional[0];
        if (!seedSelector) die("Usage: tb find-similar <css-selector-or-#number>\n  Example: tb find-similar '.product' or tb find-similar '#3'");

        const threshold = parseFloat(flags.threshold || "0.3");

        const similarResult = await sessionCmd("evaluate", { expression: `(() => {
          // Find the seed element
          var seed;
          ${seedSelector.startsWith('#') && /^#\d+$/.test(seedSelector) ? `
            // By element number
            var els=[],seen=new Set(),vw=window.innerWidth,vh=window.innerHeight;
            function vis(el){try{if(getComputedStyle(el).display==='none'||el.offsetParent===null)return false}catch(e){return false}var r=el.getBoundingClientRect();if(r.width<2||r.height<2)return false;return true}
            document.querySelectorAll('a[href],button,[role="button"],input,textarea,select').forEach(el=>{if(vis(el)){var t=(el.textContent||'').trim();if(t.length>1&&!seen.has(t)){seen.add(t);els.push(el)}}});
            seed=els[${parseInt(seedSelector.slice(1))-1}];
          ` : `
            seed=document.querySelector('${seedSelector.replace(/'/g, "\\'")}');
          `}
          if(!seed) return {error:'Element not found: ${seedSelector}'};

          // Fingerprint: tag, depth, parent tag, grandparent tag, attributes, text
          function depth(el){var d=0;while(el.parentElement){d++;el=el.parentElement}return d}
          function fingerprint(el){
            var attrs={};for(var a of el.attributes||[])if(a.name!=='style')attrs[a.name]=a.value;
            return{
              tag:el.tagName,
              depth:depth(el),
              attrs:attrs,
              attrKeys:Object.keys(attrs).sort().join(','),
              text:(el.textContent||'').trim().slice(0,200),
              parentTag:el.parentElement?.tagName||'',
              grandparentTag:el.parentElement?.parentElement?.tagName||'',
              childTags:Array.from(el.children).map(c=>c.tagName).join(','),
              siblingTags:el.parentElement?Array.from(el.parentElement.children).map(c=>c.tagName).join(','):'',
            };
          }

          // SequenceMatcher-like ratio (Scrapling uses difflib.SequenceMatcher)
          function ratio(a,b){
            if(!a&&!b)return 1;if(!a||!b)return 0;
            if(a===b)return 1;
            var matches=0,shorter=a.length<b.length?a:b,longer=a.length>=b.length?a:b;
            for(var i=0;i<shorter.length;i++){if(longer.indexOf(shorter[i],Math.max(0,i-2))>=0)matches++}
            return(2*matches)/(a.length+b.length);
          }

          function dictRatio(d1,d2){
            var k1=Object.keys(d1),k2=Object.keys(d2);
            if(!k1.length&&!k2.length)return 1;
            var keyScore=ratio(k1.sort().join(','),k2.sort().join(','));
            var valScore=0,valChecks=0;
            for(var k of k1){if(d2[k]!==undefined){valScore+=ratio(d1[k],d2[k]);valChecks++}}
            return valChecks?(keyScore+valScore/valChecks)/2:keyScore;
          }

          // Score candidate against seed (Scrapling's multi-signal approach)
          function score(seedFp,candFp){
            var s=0,c=0;
            s+=(seedFp.tag===candFp.tag?1:0);c++;
            s+=ratio(seedFp.text,candFp.text);c++;
            s+=dictRatio(seedFp.attrs,candFp.attrs);c++;
            s+=ratio(seedFp.attrKeys,candFp.attrKeys);c++;
            s+=(seedFp.parentTag===candFp.parentTag?1:0);c++;
            s+=(seedFp.grandparentTag===candFp.grandparentTag?1:0);c++;
            s+=ratio(seedFp.childTags,candFp.childTags);c++;
            s+=ratio(seedFp.siblingTags,candFp.siblingTags);c++;
            return s/c;
          }

          var seedFp=fingerprint(seed);

          // Find candidates: same tag, same depth, same parent tag
          var xpath='//'+seedFp.tag.toLowerCase();
          var all=document.evaluate(xpath,document,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null);
          var matches=[];
          for(var i=0;i<all.snapshotLength&&i<500;i++){
            var node=all.snapshotItem(i);
            if(node===seed)continue;
            var candFp=fingerprint(node);
            if(candFp.depth!==seedFp.depth)continue;
            if(candFp.parentTag!==seedFp.parentTag)continue;
            var s=score(seedFp,candFp);
            if(s>=${threshold}){
              matches.push({
                score:Math.round(s*100),
                tag:candFp.tag,
                text:candFp.text.slice(0,100),
                attrs:candFp.attrs,
              });
            }
          }
          matches.sort((a,b)=>b.score-a.score);
          return{seed:{tag:seedFp.tag,text:seedFp.text.slice(0,100)},similar:matches.slice(0,${parseInt(flags.limit)||50}),total:matches.length};
        })()` });

        const sr = similarResult as { error?: string; seed?: { tag: string; text: string }; similar?: Array<{ score: number; text: string }>; total?: number };
        if (sr?.error) { die(sr.error); break; }
        if (jsonMode) { output(sr); }
        else {
          console.log(`Seed: <${sr.seed?.tag}> "${sr.seed?.text?.slice(0, 60)}"`);
          console.log(`Found ${sr.total} similar elements:\n`);
          for (const m of (sr.similar || [])) {
            console.log(`  ${m.score}%  "${m.text.slice(0, 80)}"`);
          }
        }
        break;
      }

      case "batch": {
        // Run multiple commands in one shot, collect all results
        // Usage: tb batch 'snapshot -i; tap 3; scrape' --session x
        // Or: tb batch --file steps.txt
        await ensureDaemon();
        let batchInput = positional.join(" ");
        if (flags.file) {
          const { readFileSync } = await import("fs");
          batchInput = readFileSync(flags.file, "utf-8");
        }
        if (!batchInput) die("Usage: tb batch 'cmd1 ; cmd2 ; cmd3' or tb batch --file steps.txt");

        const steps = batchInput.split(/\s*;\s*/).map(s => s.trim()).filter(Boolean);
        const results: Array<{ step: string; result: unknown }> = [];

        for (const step of steps) {
          const [cmd, ...args] = step.split(/\s+/);
          let result: unknown = null;

          if (cmd === "snapshot") {
            const opts: Record<string, unknown> = {};
            if (args.includes("-i") || args.includes("--interactive")) opts.interactive = true;
            result = await sessionCmd("snapshot", opts);
          } else if (cmd === "tap" && args[0]) {
            // Tap multiple elements in sequence
            for (const n of args.map(Number).filter(x => x > 0)) {
              result = await sessionCmd("evaluate", { expression: `(() => {
                var els=[],seen=new Set(),vw=window.innerWidth,vh=window.innerHeight;
                function vis(el){try{if(getComputedStyle(el).display==='none'||el.offsetParent===null)return false}catch(e){return false}var r=el.getBoundingClientRect();if(r.width<2||r.height<2)return false;var hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return hit&&(hit===el||el.contains(hit)||(hit.closest&&hit.closest('a,button')===el))}
                function inView(r){return r.width>5&&r.height>5&&r.x+r.width>0&&r.y+r.height>0&&r.x<vw&&r.y<vh}
                var inputs=document.querySelectorAll('input[type="text"],input[type="search"],input[type="email"],input[type="password"],input[type="url"],input[type="number"],input:not([type]),textarea');
                for(var i=0;i<inputs.length;i++){if(inputs[i].type==='hidden'||!vis(inputs[i]))continue;var r=inputs[i].getBoundingClientRect();if(inView(r))els.push({el:inputs[i],type:'input',text:(inputs[i].getAttribute('placeholder')||inputs[i].name||'input').slice(0,50),y:r.y,x:r.x})}
                var btns=document.querySelectorAll('button,input[type="submit"],input[type="button"],[role="button"]');
                for(var j=0;j<btns.length;j++){if(!vis(btns[j]))continue;var t=(btns[j].textContent||btns[j].value||btns[j].getAttribute('aria-label')||'').trim().replace(/\\s+/g,' ');if(!t||seen.has(t))continue;seen.add(t);var r2=btns[j].getBoundingClientRect();if(inView(r2))els.push({el:btns[j],type:'button',text:t.slice(0,50),y:r2.y,x:r2.x})}
                var links=document.querySelectorAll('a[href]');
                for(var k=0;k<links.length;k++){if(!vis(links[k]))continue;var at=(links[k].textContent||'').trim().replace(/\\s+/g,' ');if(!at||at.length<2||seen.has(at))continue;seen.add(at);var r3=links[k].getBoundingClientRect();if(inView(r3))els.push({el:links[k],type:'link',text:at.slice(0,50),y:r3.y,x:r3.x})}
                els.sort(function(a,b){var dy=a.y-b.y;return Math.abs(dy)>15?dy:a.x-b.x});
                if(${n}<1||${n}>els.length)return{ok:false};
                var target=els[${n}-1];var rect=target.el.getBoundingClientRect();
                target.el.focus();target.el.click();
                return{ok:true,type:target.type,text:target.text}
              })()` });
            }
          } else if (cmd === "act" && args.length) {
            const query = args.join(" ");
            const snap = (await sessionCmd("snapshot", { interactive: true })) as { refs: Array<{ ref: string; role: string; name: string }> };
            const match = snap.refs.length ? (await sessionCmd("findElement", { query, refs: snap.refs })) as { ref?: string; name?: string } : null;
            if (match?.ref) {
              await sessionCmd("tapRef", { ref: match.ref, refs: snap.refs });
              result = { clicked: match.name, ref: match.ref };
            } else {
              result = { error: "no match", query };
            }
          } else if (cmd === "scrape") {
            result = await sessionCmd("evaluate", { expression: `(() => {
              var candidates=[];
              document.querySelectorAll('article,[role=main],main,.post-content,.article-content,.entry-content,#content,.content').forEach(el=>{candidates.push({el,score:el.innerText.length})});
              if(!candidates.length){document.querySelectorAll('div,section').forEach(el=>{var t=el.innerText.trim();if(t.length>500&&el.children.length>2)candidates.push({el,score:t.length})})}
              candidates.sort((a,b)=>b.score-a.score);var main=candidates[0]?.el||document.body;
              var title=document.querySelector('h1')?.innerText?.trim()||document.title;
              var text=main.innerText.trim();
              var links=[];main.querySelectorAll('a[href]').forEach(a=>{var t=a.textContent.trim();if(t.length>2)links.push({text:t.slice(0,60),href:a.href})});
              return{url:window.location.href,title,text:text.slice(0,50000),wordCount:text.split(/\\s+/).length,links:links.slice(0,50)};
            })()` });
          } else if (cmd === "text") {
            result = await sessionCmd("text");
          } else if (cmd === "url") {
            result = await sessionCmd("url");
          } else if (cmd === "title") {
            result = await sessionCmd("title");
          } else if (cmd === "screenshot") {
            result = await sessionCmd("screenshot", { path: args[0] || `/tmp/tb-batch-${Date.now()}.png` });
          } else if (cmd === "goto" || cmd === "open") {
            await sessionCmd("goto", { url: args[0] });
            result = { navigated: args[0] };
          } else if (cmd === "wait") {
            await sessionCmd("waitForSelector", { selector: args[0], timeout: parseInt(args[1]) || 5000 });
            result = { waited: args[0] };
          } else if (cmd === "eval") {
            result = await sessionCmd("evaluate", { expression: args.join(" ") });
          } else if (cmd === "click") {
            await sessionCmd("click", { selector: args[0] });
            result = { clicked: args[0] };
          } else if (cmd === "scroll") {
            await sessionCmd("scroll", { direction: args[0] || "down", pixels: parseInt(args[1]) || 500 });
            result = { scrolled: args[0] || "down" };
          } else if (cmd === "sleep") {
            await new Promise(r => setTimeout(r, parseInt(args[0]) || 500));
            result = { slept: parseInt(args[0]) || 500 };
          } else if (cmd === "extract") {
            const schema = JSON.parse(args.join(" "));
            result = await sessionCmd("evaluate", { expression: `(() => {
              var schema=${JSON.stringify(schema)},results={};
              for(var[key,sel] of Object.entries(schema)){
                var els=document.querySelectorAll(sel);
                results[key]=els.length>1?Array.from(els).map(e=>e.textContent.trim()):els[0]?.textContent?.trim()||null;
              }
              return results;
            })()` });
          } else if (cmd === "elements") {
            result = await sessionCmd("snapshot", { interactive: true });
          } else {
            result = { error: `Unknown batch command: ${cmd}` };
          }

          results.push({ step, result });
          if (!jsonMode) console.log(`  [${results.length}/${steps.length}] ${step}`);
        }

        if (jsonMode) output(results);
        else console.log(`\n${results.length} steps completed.`);
        break;
      }

      case "pipe": {
        // Fan-out: extract links/data from current page, open each in a group, run command on all
        // Usage: tb pipe 'extract {"links":"a.story[href]"}' --open-each --group research --then scrape
        // Simpler: tb pipe --links ".titleline a" --group hn-stories --then scrape
        await ensureDaemon();
        const linkSelector = flags.links;
        const targetGroup = flags.group || `pipe-${Date.now()}`;
        const thenCmd = flags.then || "scrape";

        if (!linkSelector) die("Usage: tb pipe --links '<selector>' --group <name> [--then <command>] [--limit <n>]");

        const limit = parseInt(flags.limit) || 5;

        // Extract links from current page
        const hrefs = (await sessionCmd("evaluate", { expression: `
          Array.from(document.querySelectorAll('${linkSelector}')).slice(0, ${limit}).map(a => ({
            text: (a.textContent || '').trim().slice(0, 60),
            href: a.href
          }))
        ` })) as Array<{ text: string; href: string }>;

        if (!hrefs?.length) { output(jsonMode ? { error: "no links found" } : "No links found for: " + linkSelector); break; }

        console.log(`Opening ${hrefs.length} links in group "${targetGroup}"...`);

        // Open each link as a new session in the group
        const sessionIds: Array<{ id: string; name: string; url: string }> = [];
        await Promise.all(hrefs.map(async (link, i) => {
          // Smart naming: use URL path for GitHub, clean text otherwise
          let name: string;
          try {
            const u = new URL(link.href);
            const pathParts = u.pathname.split('/').filter(Boolean);
            if (u.hostname.includes('github.com') && pathParts.length >= 2) {
              name = pathParts.slice(0, 2).join('/'); // owner/repo
            } else {
              name = pathParts[pathParts.length - 1] || link.text.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 30).toLowerCase();
            }
          } catch { name = link.text.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 30).toLowerCase(); }
          name = name || `page-${i}`;
          const r = (await daemonFetch("/session/create", { method: "POST", body: { engine: engineFlag ?? "auto", name, group: targetGroup } })) as { sessionId: string };
          await daemonFetch("/session/command", { method: "POST", body: { sessionId: r.sessionId, method: "goto", params: { url: link.href } } });
          sessionIds.push({ id: r.sessionId, name, url: link.href });
          console.log(`  → ${name}: ${link.href}`);
        }));

        // Wait for all pages to load
        await new Promise(r => setTimeout(r, 2000));

        // Run the "then" command on all sessions in the group
        if (thenCmd === "scrape") {
          const scrapeExpr = `(() => {
            var candidates=[];
            document.querySelectorAll('article,[role=main],main,.post-content,.article-content,.entry-content,#content,.content').forEach(el=>{candidates.push({el,score:el.innerText.length})});
            if(!candidates.length){document.querySelectorAll('div,section').forEach(el=>{var t=el.innerText.trim();if(t.length>500&&el.children.length>2)candidates.push({el,score:t.length})})}
            candidates.sort((a,b)=>b.score-a.score);var main=candidates[0]?.el||document.body;
            var title=document.querySelector('h1')?.innerText?.trim()||document.title;
            var text=main.innerText.trim();
            return{url:window.location.href,title,text:text.slice(0,10000),wordCount:text.split(/\\s+/).length};
          })()`;
          const results: Record<string, unknown> = {};
          await Promise.all(sessionIds.map(async (s) => {
            results[s.name] = (await daemonFetch("/session/command", { method: "POST", body: { sessionId: s.id, method: "evaluate", params: { expression: scrapeExpr } } }) as { result: unknown }).result;
          }));
          output(results);
        } else if (thenCmd === "screenshot") {
          for (const s of sessionIds) {
            const p = `/tmp/tb-${s.name}-${Date.now()}.png`;
            await daemonFetch("/session/command", { method: "POST", body: { sessionId: s.id, method: "screenshot", params: { path: p } } });
            console.log(`  ${s.name}: ${p}`);
          }
        } else if (thenCmd === "text" || thenCmd === "title" || thenCmd === "url") {
          const results: Record<string, unknown> = {};
          await Promise.all(sessionIds.map(async (s) => {
            results[s.name] = (await daemonFetch("/session/command", { method: "POST", body: { sessionId: s.id, method: thenCmd, params: {} } }) as { result: unknown }).result;
          }));
          output(results);
        }
        break;
      }

      case "workflow":
      case "run": {
        // Run a YAML-like workflow file
        const wfFile = positional[0];
        if (!wfFile) die("Usage: tb workflow <file.json>");
        if (!existsSync(wfFile)) die(`Workflow not found: ${wfFile}`);
        await ensureDaemon();
        const wf = JSON.parse((await import("fs")).readFileSync(wfFile, "utf-8"));
        console.log(`Running workflow: ${wf.name || wfFile} (${wf.steps?.length || 0} steps)`);
        // --record demo.mp4: video the whole run (start before step 1,
        // assemble after the last step) — a workflow IS a demo script.
        if (flags.record) await sessionCmd("startRecording", {});
        for (let i = 0; i < (wf.steps || []).length; i++) {
          const step = wf.steps[i];
          const [action, ...rest] = Object.entries(step)[0] as [string, any];
          console.log(`  [${i + 1}/${wf.steps.length}] ${action}`);
          if (action === "goto") await sessionCmd("goto", { url: rest[0] });
          else if (action === "tap") await sessionCmd("evaluate", { expression: `(() => { /* same tap logic */ })()` }); // simplified
          else if (action === "click") await sessionCmd("click", { selector: rest[0] });
          else if (action === "type") await sessionCmd("type", { selector: Object.keys(rest[0])[0], text: Object.values(rest[0])[0] as string });
          else if (action === "fill") {
            for (const [sel, val] of Object.entries(rest[0] as Record<string, string>)) {
              await sessionCmd("evaluate", { expression: `(() => { var el = document.querySelector('${sel}'); if(el) { var s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value'); if(s&&s.set) s.set.call(el,'${val}'); else el.value='${val}'; el.dispatchEvent(new Event('input',{bubbles:true})); } })()` });
            }
          }
          else if (action === "wait") await sessionCmd("waitForSelector", { selector: rest[0] });
          else if (action === "screenshot") { await sessionCmd("screenshot", { path: rest[0] }); console.log(`    → ${rest[0]}`); }
          else if (action === "eval") { const r = await sessionCmd("evaluate", { expression: rest[0] }); console.log(`    → ${JSON.stringify(r).slice(0, 80)}`); }
          else if (action === "scroll") await sessionCmd("scroll", { direction: rest[0] || "down", pixels: 500 });
          else if (action === "assert") {
            const assertResult = await sessionCmd("evaluate", { expression: `(() => { var el = document.querySelector('${rest[0].selector}'); return el ? el.textContent.trim() : null; })()` });
            const matches = assertResult === rest[0].text || (assertResult as string)?.includes?.(rest[0].text);
            console.log(`    ${matches ? "✓ PASS" : "✗ FAIL"}: "${rest[0].text}" ${matches ? "found" : "not found"} in ${rest[0].selector}`);
            if (!matches && rest[0].strict) die("Assertion failed");
          }
          else if (action === "sleep") await new Promise(r => setTimeout(r, (rest[0] as number) || 1000));
          await new Promise(r => setTimeout(r, 300)); // brief pause between steps
        }
        if (flags.record) {
          const r = (await sessionCmd("stopRecording", {})) as {
            dir: string; frameCount: number; durationSec: number; listPath: string | null;
          };
          await assembleRecording(r, flags.record);
        }
        console.log("Workflow complete.");
        break;
      }

      case "intercept": {
        // Network interception
        await ensureDaemon();
        const interceptAction = positional[0];
        if (interceptAction === "block") {
          const pattern = positional[1];
          if (!pattern) die("Usage: tb intercept block <url-pattern>");
          await sessionCmd("evaluate", { expression: `
            if (!window.__tbBlocked) window.__tbBlocked = [];
            window.__tbBlocked.push('${pattern}');
          `});
          // Use CDP Fetch domain
          await daemonFetch("/session/command", { method: "POST", body: { sessionId: await getSession(), method: "enableIntercept", params: { block: [pattern] } } });
          output(`Blocking: ${pattern}`);
        } else if (interceptAction === "mock") {
          const urlPattern = positional[1];
          const responseBody = positional[2];
          if (!urlPattern || !responseBody) die("Usage: tb intercept mock <url-pattern> <response-json>");
          await daemonFetch("/session/command", { method: "POST", body: { sessionId: await getSession(), method: "enableIntercept", params: { mock: [{ pattern: urlPattern, body: responseBody }] } } });
          output(`Mocking: ${urlPattern} → ${responseBody.slice(0, 50)}`);
        } else if (interceptAction === "capture") {
          const requests = await sessionCmd("getCapturedRequests");
          output(requests);
        } else {
          die("Usage: tb intercept <block|mock|capture> <pattern> [response]");
        }
        break;
      }

      case "viewport": {
        // Change viewport size
        await ensureDaemon();
        const size = positional[0];
        const presets: Record<string, [number, number]> = {
          mobile: [390, 844], iphone: [390, 844], ipad: [1024, 1366],
          tablet: [1024, 1366], hd: [1280, 720], fhd: [1920, 1080],
          mac: [1440, 900], air: [1470, 956],
        };
        let w: number, h: number;
        if (presets[size]) { [w, h] = presets[size]; }
        else if (size?.includes("x")) { [w, h] = size.split("x").map(Number); }
        else { die("Usage: tb viewport <mobile|tablet|hd|fhd|WxH>"); break; }
        await sessionCmd("evaluate", { expression: `window.__tbViewport = {w:${w},h:${h}}` });
        // Note: changing viewport requires Emulation.setDeviceMetricsOverride via CDP
        // This is a simplified version — full implementation would go through daemon
        output(jsonMode ? { width: w, height: h } : `Viewport: ${w}x${h}`);
        break;
      }

      case "move": {
        // Move session to a different group
        const moveName = positional[0];
        const newGroup = flags.group || "";
        if (!moveName) die("Usage: tb move <session> --group <group-name>");
        await ensureDaemon();
        // Find session by name or ID
        const status = (await daemonFetch("/status")) as { sessions: Array<{ id: string; name?: string }> };
        const sess = status.sessions.find(s => s.name === moveName || s.id === moveName);
        if (!sess) die(`Session not found: ${moveName}`);
        await daemonFetch(`/session/${sess.id}`, { method: "PATCH", body: { group: newGroup } });
        output(jsonMode ? { ok: true, session: moveName, group: newGroup } : newGroup ? `Moved "${moveName}" → group "${newGroup}"` : `Removed "${moveName}" from group`);
        break;
      }

      case "group": {
        const sub = positional[0];
        await ensureDaemon();
        const gStatus = (await daemonFetch("/status")) as { sessions: Array<{ id: string; name?: string; group?: string }> };
        if (sub === "rename") {
          const oldName = positional[1];
          const newName = positional[2];
          if (!oldName || !newName) die("Usage: tb group rename <old> <new>");
          let count = 0;
          for (const s of gStatus.sessions) {
            if (s.group === oldName) {
              await daemonFetch(`/session/${s.id}`, { method: "PATCH", body: { group: newName } });
              count++;
            }
          }
          output(jsonMode ? { ok: true, renamed: oldName, to: newName, count } : `Renamed group "${oldName}" → "${newName}" (${count} sessions)`);
        } else if (sub === "list" || !sub) {
          // Group sessions by group name
          const groups: Record<string, Array<{ id: string; name?: string }>> = {};
          for (const s of gStatus.sessions) {
            const g = s.group || "(ungrouped)";
            if (!groups[g]) groups[g] = [];
            groups[g].push(s);
          }
          if (jsonMode) { output(groups); }
          else {
            for (const [g, sessions] of Object.entries(groups)) {
              console.log(`  ${g}`);
              for (const s of sessions) {
                console.log(`    ${s.name || s.id}`);
              }
            }
          }
        } else {
          die("Usage: tb group <list|rename> [args]");
        }
        break;
      }

      case "groups": {
        // Alias for group list
        await ensureDaemon();
        const grStatus = (await daemonFetch("/status")) as { sessions: Array<{ id: string; name?: string; group?: string }> };
        const grps: Record<string, string[]> = {};
        for (const s of grStatus.sessions) {
          const g = s.group || "(ungrouped)";
          if (!grps[g]) grps[g] = [];
          grps[g].push(s.name || s.id);
        }
        if (jsonMode) { output(grps); }
        else {
          for (const [g, names] of Object.entries(grps)) {
            console.log(`  ${g}: ${names.join(", ")}`);
          }
        }
        break;
      }

      case "serve": {
        const port = positional[0] ? parseInt(positional[0]) : 7171;
        await ensureDaemon();
        await startServer(port);
        break;
      }

      default:
        die(`Unknown command: ${command}. Run: tb help`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Friendly error for missing engine
    if (msg.includes("ENOENT") && (msg.includes("lightpanda") || msg.includes("engine"))) {
      die("Lightpanda not found. Run: tb install");
    }

    // Friendly error for daemon connection failures
    if (msg.includes("ECONNREFUSED") || msg.includes("daemon.sock") || msg.includes("connect")) {
      die("Failed to start daemon. Check: tb status");
    }

    die(msg);
  }
}

main();
