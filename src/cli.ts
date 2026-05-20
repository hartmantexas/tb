#!/usr/bin/env bun

import { ensureDaemon, daemonFetch, stopDaemon } from "./daemon.js";
import { detectEngines, getEngine } from "./engines/index.js";
import { loadConfig, saveConfig } from "./config.js";
import { startServer } from "./server.js";
import { viewPage, liveSession } from "./view.js";
import { timeAgo, formatBytes } from "./utils.js";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const VERSION = "0.1.0";
const TB_HOME = join(homedir(), ".tb");

/** Extract interactive elements — returns numbered list without touching DOM */
const EXTRACT_ELEMENTS_JS = `(() => {
  var results = [];
  var seen = new Set();
  var idx = 1;
  var inputs = document.querySelectorAll('input[type="text"], input[type="search"], input[type="email"], input[type="password"], input[type="url"], input[type="number"], input:not([type]), textarea');
  for (var i = 0; i < inputs.length; i++) {
    var inp = inputs[i];
    try { if (getComputedStyle(inp).display === 'none' || inp.type === 'hidden' || inp.offsetParent === null) continue; } catch(e) { continue; }
    var label = inp.getAttribute('aria-label') || inp.getAttribute('placeholder') || inp.name || inp.id || 'input';
    var val = inp.value || '';
    var sel = inp.id ? '#' + inp.id : (inp.name ? '[name="' + inp.name + '"]' : 'input:nth-of-type(' + (i+1) + ')');
    results.push({ index: idx++, type: 'input', text: label.trim().slice(0,50), value: val, selector: sel });
  }
  var btns = document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]');
  for (var j = 0; j < btns.length; j++) {
    var btn = btns[j];
    try { if (getComputedStyle(btn).display === 'none' || btn.offsetParent === null) continue; } catch(e) { continue; }
    var btnText = (btn.textContent || btn.value || btn.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ');
    if (!btnText || seen.has(btnText)) continue;
    seen.add(btnText);
    var btnSel = btn.id ? '#' + btn.id : (btn.getAttribute('data-testid') ? '[data-testid="' + btn.getAttribute('data-testid') + '"]' : null);
    if (!btnSel) {
      // Build a unique selector using :nth-child path from parent
      var parent = btn.parentElement;
      if (parent) {
        var siblings = Array.from(parent.children);
        var nth = siblings.indexOf(btn) + 1;
        var parentSel = parent.id ? '#' + parent.id : parent.tagName.toLowerCase();
        btnSel = parentSel + ' > :nth-child(' + nth + ')';
      } else {
        btnSel = btn.tagName.toLowerCase();
      }
    }
    results.push({ index: idx++, type: 'button', text: btnText.slice(0,50), selector: btnSel });
  }
  var links = document.querySelectorAll('a[href]');
  var lc = 0;
  for (var k = 0; k < links.length && lc < 25; k++) {
    var a = links[k];
    try { if (getComputedStyle(a).display === 'none' || a.offsetParent === null) continue; } catch(e) { continue; }
    var aText = (a.textContent || '').trim().replace(/\\s+/g, ' ');
    if (!aText || aText.length < 2 || seen.has(aText)) continue;
    seen.add(aText);
    var aSel = a.id ? '#' + a.id : 'a[href="' + (a.getAttribute('href') || '').replace(/"/g, '\\\\\\"') + '"]';
    results.push({ index: idx++, type: 'link', text: aText.slice(0,50), selector: aSel });
    lc++;
  }
  return results;
})()`;

/** Inject floating overlay number badges — positioned absolute over elements, not inline */
const INJECT_OVERLAY_BADGES_JS = `(() => {
  document.querySelectorAll('.tb-overlay-badge').forEach(function(b) { b.remove(); });
  var idx = 1;
  var seen = new Set();
  function badge(el, num, color) {
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    var b = document.createElement('div');
    b.className = 'tb-overlay-badge';
    b.textContent = String(num);
    b.setAttribute('style',
      'position:fixed !important;z-index:999999 !important;' +
      'top:' + Math.max(0, rect.top - 6) + 'px !important;' +
      'left:' + Math.max(0, rect.left - 6) + 'px !important;' +
      'background:' + color + ' !important;color:#fff !important;' +
      'font-size:10px !important;font-weight:bold !important;font-family:monospace !important;' +
      'min-width:16px !important;height:16px !important;line-height:16px !important;' +
      'text-align:center !important;border-radius:8px !important;' +
      'padding:0 3px !important;pointer-events:none !important;' +
      'box-shadow:0 1px 3px rgba(0,0,0,0.5) !important;'
    );
    document.body.appendChild(b);
  }
  var inputs = document.querySelectorAll('input[type="text"], input[type="search"], input[type="email"], input[type="password"], input[type="url"], input[type="number"], input:not([type]), textarea');
  for (var i = 0; i < inputs.length; i++) {
    try { if (getComputedStyle(inputs[i]).display === 'none' || inputs[i].type === 'hidden' || inputs[i].offsetParent === null) continue; } catch(e) { continue; }
    badge(inputs[i], idx++, '#e8b931');
  }
  var btns = document.querySelectorAll('button, input[type="submit"], [role="button"]');
  for (var j = 0; j < btns.length; j++) {
    try { if (getComputedStyle(btns[j]).display === 'none' || btns[j].offsetParent === null) continue; } catch(e) { continue; }
    var t = (btns[j].textContent || '').trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    badge(btns[j], idx++, '#34a853');
  }
  var links = document.querySelectorAll('a[href]');
  var lc = 0;
  for (var k = 0; k < links.length && lc < 25; k++) {
    try { if (getComputedStyle(links[k]).display === 'none' || links[k].offsetParent === null) continue; } catch(e) { continue; }
    var at = (links[k].textContent || '').trim();
    if (!at || at.length < 2 || seen.has(at)) continue;
    seen.add(at);
    badge(links[k], idx++, '#4285f4');
    lc++;
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
      const booleanFlags = ["json", "help", "version", "new", "full-page"];
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
    },
  })) as { sessionId: string; engine: string; name?: string };

  currentSessionId = result.sessionId;
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

  ps                      List all active sessions
  kill <session-id>       Kill a specific session
  kill-all                Kill all sessions
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

      case "click": {
        const selector = positional[0];
        if (!selector) die("Usage: tb click <selector>");
        await ensureDaemon();
        await sessionCmd("click", { selector });
        output(jsonMode ? { ok: true, selector } : `Clicked ${selector}`);
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
        const text = await sessionCmd("text");
        output(jsonMode ? { text } : text);
        break;
      }

      case "title": {
        await ensureDaemon();
        const title = await sessionCmd("title");
        output(jsonMode ? { title } : title);
        break;
      }

      case "url": {
        await ensureDaemon();
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
        if (!selector) die("Usage: tb wait <selector>");
        await ensureDaemon();
        const timeout = flags.timeout ? parseInt(flags.timeout) : 10000;
        await sessionCmd("waitForSelector", { selector, timeout });
        output(
          jsonMode ? { ok: true, selector } : `Found ${selector}`,
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
        const engine = positional[0] as
          | "lightpanda"
          | "chromium"
          | "all"
          | undefined;
        if (engine && !["lightpanda", "chromium", "all"].includes(engine)) {
          die("Usage: tb install [lightpanda|chromium|all]");
        }
        await installEngine(engine);
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
                `  ${s.id} [${s.engine}] last used ${timeAgo(new Date(s.lastUsedAt))}`,
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
        const num = parseInt(positional[0]);
        if (!num || num < 1) die("Usage: tb tap <number> (from tb elements)");
        await ensureDaemon();
        // Click by re-enumerating and clicking the nth element directly in-page
        // This avoids selector ambiguity — the JS walks the same order as `elements`
        const tapResult = await sessionCmd("evaluate", {
          expression: `(() => {
            var idx = 1;
            var seen = new Set();
            function tryClick(el) {
              if (idx === ${num}) {
                var rect = el.getBoundingClientRect();
                el.focus();
                el.click();
                el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: rect.x + rect.width/2, clientY: rect.y + rect.height/2 }));
                return true;
              }
              idx++;
              return false;
            }
            var inputs = document.querySelectorAll('input[type="text"], input[type="search"], input[type="email"], input[type="password"], input[type="url"], input[type="number"], input:not([type]), textarea');
            for (var i = 0; i < inputs.length; i++) {
              try { if (getComputedStyle(inputs[i]).display === 'none' || inputs[i].type === 'hidden' || inputs[i].offsetParent === null) continue; } catch(e) { continue; }
              if (tryClick(inputs[i])) return { ok: true, type: 'input', text: (inputs[i].getAttribute('placeholder') || inputs[i].name || 'input').slice(0,50) };
            }
            var btns = document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]');
            for (var j = 0; j < btns.length; j++) {
              try { if (getComputedStyle(btns[j]).display === 'none' || btns[j].offsetParent === null) continue; } catch(e) { continue; }
              var t = (btns[j].textContent || btns[j].value || btns[j].getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ');
              if (!t || seen.has(t)) continue;
              seen.add(t);
              if (tryClick(btns[j])) return { ok: true, type: 'button', text: t.slice(0,50) };
            }
            var links = document.querySelectorAll('a[href]');
            var lc = 0;
            for (var k = 0; k < links.length && lc < 25; k++) {
              try { if (getComputedStyle(links[k]).display === 'none' || links[k].offsetParent === null) continue; } catch(e) { continue; }
              var at = (links[k].textContent || '').trim().replace(/\\s+/g, ' ');
              if (!at || at.length < 2 || seen.has(at)) continue;
              seen.add(at);
              if (tryClick(links[k])) return { ok: true, type: 'link', text: at.slice(0,50) };
              lc++;
            }
            return { ok: false };
          })()`,
        }) as { ok: boolean; type?: string; text?: string } | null;
        const tr = tapResult || { ok: false };
        if (!tr.ok) die(`Element #${num} not found. Run: tb elements`);
        output(jsonMode ? { ok: true, index: num, type: tr.type, text: tr.text } : `Tapped #${num}: ${tr.text} (${tr.type})`);
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
