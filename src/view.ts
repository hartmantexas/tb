/**
 * Interactive terminal browser.
 * Renders page with numbered badges on interactive elements.
 * Type a number to click, type a URL to go, or just type text to search.
 */

import { ensureDaemon, daemonFetch } from "./daemon.js";
import { createInterface } from "readline";

// Colors
const dim = (s: string) => `\x1b[90m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

function displayImage(pngBuffer: Buffer): void {
  const b64 = pngBuffer.toString("base64");
  // iTerm2 inline image protocol (also works in many modern terminals)
  process.stdout.write(`\x1b]1337;File=inline=1;width=auto;preserveAspectRatio=1:${b64}\x07\n`);
}

function clear(): void {
  process.stdout.write("\x1b[2J\x1b[H");
}

// Session
let sessionId: string | null = null;
let currentEngine = "auto";
let lastElements: Array<{ index: number; type: string; text: string; selector: string }> = [];

async function getSession(): Promise<string> {
  if (sessionId) return sessionId;
  const status = (await daemonFetch("/status")) as { sessions: Array<{ id: string }> };
  if (status.sessions.length > 0) {
    sessionId = status.sessions[status.sessions.length - 1].id;
    return sessionId;
  }
  const result = (await daemonFetch("/session/create", {
    method: "POST",
    body: { engine: currentEngine },
  })) as { sessionId: string };
  sessionId = result.sessionId;
  return sessionId;
}

async function cmd(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const sid = await getSession();
  const r = (await daemonFetch("/session/command", {
    method: "POST",
    body: { sessionId: sid, method, params },
  })) as { result: unknown };
  return r.result;
}

/**
 * Inject numbered badges onto interactive elements in the page DOM.
 * Returns the element list. Badges are visible in the screenshot.
 */
const INJECT_BADGES_JS = `(() => {
  // Remove old badges first
  document.querySelectorAll('.tb-badge').forEach(function(b) { b.remove(); });

  var results = [];
  var seen = new Set();
  var idx = 1;

  function addBadge(el, num, type) {
    var badge = document.createElement('span');
    badge.className = 'tb-badge';
    badge.textContent = String(num);
    badge.setAttribute('style',
      'display:inline-block !important;' +
      'background:' + (type === 'input' ? '#e8b931' : type === 'button' ? '#34a853' : '#4285f4') + ' !important;' +
      'color:#fff !important;font-size:9px !important;font-weight:bold !important;' +
      'padding:0px 3px !important;border-radius:3px !important;margin-right:2px !important;' +
      'line-height:14px !important;vertical-align:middle !important;font-family:monospace !important;'
    );

    // For inputs, add before the element
    if (type === 'input') {
      if (el.parentElement) el.parentElement.insertBefore(badge, el);
    } else {
      // For links/buttons, prepend inside
      el.insertBefore(badge, el.firstChild);
    }
  }

  // Inputs first (most important)
  var inputs = document.querySelectorAll('input[type="text"], input[type="search"], input[type="email"], input[type="password"], input[type="url"], input:not([type]), textarea');
  for (var i = 0; i < inputs.length; i++) {
    var inp = inputs[i];
    // Skip hidden inputs
    try { if (getComputedStyle(inp).display === 'none' || inp.type === 'hidden') continue; } catch(e) { continue; }
    var label = inp.getAttribute('placeholder') || inp.getAttribute('aria-label') || inp.name || 'input';
    var val = inp.value || '';
    var sel = inp.id ? '#' + inp.id : (inp.name ? '[name="' + inp.name + '"]' : 'input');
    addBadge(inp, idx, 'input');
    results.push({ index: idx, type: 'input', text: label.slice(0,40), value: val, selector: sel });
    idx++;
  }

  // Buttons
  var btns = document.querySelectorAll('button, input[type="submit"], input[type="button"]');
  for (var j = 0; j < btns.length; j++) {
    var btn = btns[j];
    try { if (getComputedStyle(btn).display === 'none') continue; } catch(e) { continue; }
    var btnText = (btn.textContent || btn.value || btn.getAttribute('aria-label') || '').trim();
    if (!btnText || seen.has(btnText)) continue;
    seen.add(btnText);
    var btnSel = btn.id ? '#' + btn.id : (btn.name ? '[name="' + btn.name + '"]' : 'button');
    addBadge(btn, idx, 'button');
    results.push({ index: idx, type: 'button', text: btnText.slice(0,40), selector: btnSel });
    idx++;
  }

  // Links (limit to first 20 visible)
  var links = document.querySelectorAll('a[href]');
  var linkCount = 0;
  for (var k = 0; k < links.length && linkCount < 20; k++) {
    var a = links[k];
    try { if (getComputedStyle(a).display === 'none') continue; } catch(e) { continue; }
    var aText = (a.textContent || '').trim();
    if (!aText || aText.length < 2 || seen.has(aText)) continue;
    seen.add(aText);
    var aSel = a.id ? '#' + a.id : 'a[href="' + (a.getAttribute('href') || '').replace(/"/g, '\\\\"') + '"]';
    addBadge(a, idx, 'link');
    results.push({ index: idx, type: 'link', text: aText.slice(0,40), selector: aSel });
    idx++;
    linkCount++;
  }

  return results;
})()`;

/** Extract elements WITHOUT injecting badges — just returns the list */
const EXTRACT_ELEMENTS_JS = `(() => {
  var results = [];
  var seen = new Set();
  var idx = 1;

  var inputs = document.querySelectorAll('input[type="text"], input[type="search"], input[type="email"], input[type="password"], input[type="url"], input:not([type]), textarea');
  for (var i = 0; i < inputs.length; i++) {
    var inp = inputs[i];
    try { if (getComputedStyle(inp).display === 'none' || inp.type === 'hidden') continue; } catch(e) { continue; }
    var label = inp.getAttribute('aria-label') || inp.getAttribute('title') || inp.getAttribute('placeholder') || inp.name || 'input';
    var val = inp.value || '';
    var sel = inp.id ? '#' + inp.id : (inp.name ? '[name="' + inp.name + '"]' : 'input');
    results.push({ index: idx++, type: 'input', text: label.trim().slice(0,40), value: val, selector: sel });
  }

  var btns = document.querySelectorAll('button, input[type="submit"], input[type="button"]');
  for (var j = 0; j < btns.length; j++) {
    var btn = btns[j];
    try { if (getComputedStyle(btn).display === 'none') continue; } catch(e) { continue; }
    var btnText = (btn.textContent || btn.value || btn.getAttribute('aria-label') || '').trim();
    if (!btnText || seen.has(btnText)) continue;
    seen.add(btnText);
    var btnSel = btn.id ? '#' + btn.id : (btn.name ? '[name="' + btn.name + '"]' : 'button');
    results.push({ index: idx++, type: 'button', text: btnText.slice(0,40), selector: btnSel });
  }

  var links = document.querySelectorAll('a[href]');
  var lc = 0;
  for (var k = 0; k < links.length && lc < 20; k++) {
    var a = links[k];
    try { if (getComputedStyle(a).display === 'none') continue; } catch(e) { continue; }
    var aText = (a.textContent || '').trim();
    if (!aText || aText.length < 2 || seen.has(aText)) continue;
    seen.add(aText);
    var aSel = a.id ? '#' + a.id : 'a[href="' + (a.getAttribute('href') || '').replace(/"/g, '\\\\"') + '"]';
    results.push({ index: idx++, type: 'link', text: aText.slice(0,40), selector: aSel });
    lc++;
  }

  return results;
})()`;


/**
 * Render page: inject badges → screenshot → remove badges → display
 */
async function renderPage(showHelp = false): Promise<void> {
  const title = (await cmd("title")) as string;
  const url = (await cmd("url")) as string;

  // Clean screenshot first (no badge injection)
  const result = (await cmd("screenshot", {})) as { base64?: string; size: number };

  // Extract interactive elements for the list below
  const elResult = await cmd("evaluate", { expression: EXTRACT_ELEMENTS_JS });
  lastElements = (elResult as typeof lastElements) || [];

  // Display
  clear();
  console.log(`${bold(title)}  ${dim(url)}`);

  if (result.base64) {
    displayImage(Buffer.from(result.base64, "base64"));
  }

  // Show element list — horizontal flow
  showElements();
  console.log(dim(`# click/focus  |  enter submit  |  url go  |  ? help`));
}

function printHelp(): void {
  console.log(`
${bold("Commands")}
  ${cyan("#")}               Click/focus element by badge number
  ${cyan("url")}             Type a URL to navigate (e.g. google.com)
  ${cyan("text")}            Type any text to find & click matching element
  ${cyan("type <text>")}     Type text into the focused/first input
  ${cyan("enter")}           Submit / press Enter
  ${cyan("back")}            Go back        ${cyan("forward")}  Go forward
  ${cyan("reload")}          Reload page    ${cyan("view")}     Re-render
  ${cyan("links")}           List all elements with numbers
  ${cyan("text")}            Show page text content
  ${cyan("js <code>")}       Run JavaScript
  ${cyan("save [path]")}     Save screenshot to file
  ${cyan("quit")}            Exit
`);
}

function showElements(): void {
  if (lastElements.length === 0) return;

  const cols = process.stdout.columns || 100;
  let line = "  ";
  let lineLen = 2;

  for (const el of lastElements) {
    const num = String(el.index);
    const color = el.type === "input" ? "\x1b[33m" : el.type === "button" ? "\x1b[32m" : "\x1b[34m";
    const val = (el as any).value ? `"${(el as any).value}"` : "";
    const label = el.type === "input" ? (val ? `[${el.text}=${val}]` : `[${el.text}]`) : el.text;
    const tag = `${color}${num}\x1b[0m${dim(":")}${label}`;
    const plainLen = num.length + 1 + label.length;

    if (lineLen + plainLen + 3 > cols && lineLen > 2) {
      console.log(line);
      line = "  ";
      lineLen = 2;
    }
    line += tag + "  ";
    lineLen += plainLen + 2;
  }
  if (lineLen > 2) console.log(line);
}

function printElements(): void {
  for (const el of lastElements) {
    const color = el.type === "input" ? "\x1b[33m" : el.type === "button" ? "\x1b[32m" : "\x1b[34m";
    const label = el.type === "input" ? `[${el.text}]` : el.text;
    console.log(`  ${color}${String(el.index).padStart(2)}\x1b[0m ${label} ${dim(el.type)}`);
  }
}

/** Click by text content (fuzzy match) */
async function clickByText(text: string): Promise<boolean> {
  const lower = text.toLowerCase();
  const match = lastElements.find(
    e => e.text.toLowerCase() === lower || e.text.toLowerCase().includes(lower),
  );
  if (match) {
    await cmd("click", { selector: match.selector });
    return true;
  }
  // Try JS click
  return (await cmd("evaluate", {
    expression: `(() => {
      var els = document.querySelectorAll('a, button, input[type=submit]');
      for (var el of els) {
        if ((el.textContent || el.value || '').trim().toLowerCase().includes(${JSON.stringify(lower)})) {
          el.click(); return true;
        }
      }
      return false;
    })()`,
  })) as boolean;
}

/** One-shot view: screenshot → display inline → exit. For agents. */
export async function viewPage(targetSessionId?: string): Promise<void> {
  await ensureDaemon();

  if (targetSessionId) {
    sessionId = targetSessionId;
  } else {
    // Pick session if multiple exist
    const status = (await daemonFetch("/status")) as {
      sessions: Array<{ id: string; engine: string; lastUsedAt: string }>;
    };

    if (status.sessions.length === 0) {
      console.log(dim("No active sessions. Use: tb open <url>"));
      return;
    } else if (status.sessions.length === 1) {
      sessionId = status.sessions[0].id;
    } else {
      // Show picker
      console.log(bold("Active sessions:\n"));
      for (let i = 0; i < status.sessions.length; i++) {
        const s = status.sessions[i];
        console.log(`  ${cyan(String(i + 1))} ${s.id} ${dim(s.engine)}  ${dim("last used " + new Date(s.lastUsedAt).toLocaleTimeString())}`);
      }
      console.log();
      const rl0 = createInterface({ input: process.stdin, output: process.stdout });
      const pick = await new Promise<string>((resolve) => {
        rl0.question(`${cyan("View session (1-" + status.sessions.length + ", or Enter for latest):")} `, (answer) => {
          rl0.close();
          resolve(answer.trim());
        });
      });
      const idx = pick ? parseInt(pick) - 1 : status.sessions.length - 1;
      sessionId = status.sessions[Math.max(0, Math.min(idx, status.sessions.length - 1))].id;
    }
  }

  const title = (await cmd("title")) as string;
  const pageUrl = (await cmd("url")) as string;

  // Smart screenshot: if current session is lightpanda, use a temp chromium session for the render
  // so the output looks pixel-perfect regardless of which engine does the DOM ops
  const status = (await daemonFetch("/status")) as {
    sessions: Array<{ id: string; engine: string }>;
  };
  const currentSession = status.sessions.find(s => s.id === sessionId);
  let result: { base64?: string };

  result = (await cmd("screenshot", {})) as { base64?: string };

  console.log(`${bold(title)}  ${dim(pageUrl)}`);
  if (result.base64) {
    displayImage(Buffer.from(result.base64, "base64"));
  }
}

/** Interactive session */
export async function liveSession(initialUrl?: string, engine?: string, forceNew = false): Promise<void> {
  await ensureDaemon();
  // Default to lightpanda — Blitz gives real CSS rendering now
  // Use --engine chromium for bot-blocked sites (Google, Bing)
  currentEngine = engine ?? "auto";

  if (forceNew || initialUrl) {
    // Force new session or URL provided
    sessionId = null; // clear so getSession creates a new one
    await getSession();
    if (initialUrl) {
      const fullUrl = initialUrl.startsWith("http") ? initialUrl : `https://${initialUrl}`;
      await cmd("goto", { url: fullUrl });
    }
  } else {
    // No URL — check existing sessions
    const status = (await daemonFetch("/status")) as {
      sessions: Array<{ id: string; engine: string; createdAt: string; lastUsedAt: string }>;
    };

    if (status.sessions.length === 0) {
      // No sessions at all — prompt for URL
      const rl0 = createInterface({ input: process.stdin, output: process.stdout });
      const url = await new Promise<string>((resolve) => {
        rl0.question(`${cyan("URL to open:")} `, (answer) => {
          rl0.close();
          resolve(answer.trim());
        });
      });
      if (!url) { console.log("No URL. Bye!"); return; }
      await getSession();
      const fullUrl = url.startsWith("http") ? url : `https://${url}`;
      await cmd("goto", { url: fullUrl });
    } else if (status.sessions.length === 1) {
      // One session — use it
      sessionId = status.sessions[0].id;
    } else {
      // Multiple sessions — let user pick
      console.log(bold("Active sessions:\n"));
      for (let i = 0; i < status.sessions.length; i++) {
        const s = status.sessions[i];
        console.log(`  ${cyan(String(i + 1))} ${s.id} ${dim(s.engine)}  ${dim("last used " + new Date(s.lastUsedAt).toLocaleTimeString())}`);
      }
      console.log();
      const rl0 = createInterface({ input: process.stdin, output: process.stdout });
      const pick = await new Promise<string>((resolve) => {
        rl0.question(`${cyan("Pick session (1-" + status.sessions.length + "):")} `, (answer) => {
          rl0.close();
          resolve(answer.trim());
        });
      });
      const idx = parseInt(pick) - 1;
      if (idx >= 0 && idx < status.sessions.length) {
        sessionId = status.sessions[idx].id;
      } else {
        sessionId = status.sessions[status.sessions.length - 1].id;
        console.log(dim(`Using most recent session`));
      }
    }
  }

  await renderPage();

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: `${cyan("tb")}${dim(">")} ` });
  rl.prompt();

  rl.on("line", async (line: string) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    try {
      // Number → click/focus that element
      const num = parseInt(input);
      if (!isNaN(num) && num > 0 && input.match(/^\d+$/)) {
        const el = lastElements.find(e => e.index === num);
        if (el) {
          if (el.type === "input") {
            await cmd("click", { selector: el.selector });
            console.log(`Focused: ${el.text}`);
            rl.question(`  Type: `, async (text) => {
              if (text.trim()) {
                // Clear existing value first, then type
                await cmd("evaluate", {
                  expression: `(() => { var el = document.querySelector('${el.selector.replace(/'/g, "\\'")}'); if(el) { el.value = ''; el.focus(); } })()`,
                });
                await cmd("type", { selector: el.selector, text: text.trim() });
                console.log(dim(`  Typed "${text.trim()}" into ${el.text}`));
              }
              await new Promise(r => setTimeout(r, 300));
              await renderPage();
              rl.prompt();
            });
            return;
          } else {
            console.log(dim(`Clicking: ${el.text}`));
            if (el.type === "button") {
              // Build form URL manually and navigate (lightpanda form.submit doesn't navigate)
              const formUrl = (await cmd("evaluate", {
                expression: `(() => {
                  var el = document.querySelector('${el.selector.replace(/'/g, "\\'")}');
                  if (!el) return null;
                  var form = el.closest ? el.closest('form') : el.form;
                  if (!form) { el.click(); return null; }
                  var action = form.action || window.location.href;
                  var method = (form.method || 'get').toLowerCase();
                  if (method === 'get') {
                    var params = [];
                    var inputs = form.querySelectorAll('input[name], select[name], textarea[name]');
                    for (var inp of inputs) {
                      if (inp.type === 'submit' || inp.type === 'button' || inp.type === 'image') continue;
                      if (inp.type === 'checkbox' && !inp.checked) continue;
                      if (inp.type === 'radio' && !inp.checked) continue;
                      params.push(encodeURIComponent(inp.name) + '=' + encodeURIComponent(inp.value || ''));
                    }
                    return action.split('?')[0] + '?' + params.join('&');
                  }
                  form.submit();
                  return null;
                })()`,
              })) as string | null;
              if (formUrl) {
                await cmd("goto", { url: formUrl });
              }
            } else {
              await cmd("click", { selector: el.selector });
            }
            await new Promise(r => setTimeout(r, 1200));
            await renderPage();
          }
        } else {
          console.log(dim(`No element #${num}. Type "links" to see all.`));
        }
        rl.prompt();
        return;
      }

      const parts = input.split(/\s+/);
      const command = parts[0].toLowerCase();

      switch (command) {
        case "type":
        case "t": {
          const text = parts.slice(1).join(" ");
          if (!text) { console.log("Usage: type <text>"); break; }
          const firstInput = lastElements.find(e => e.type === "input");
          if (firstInput) {
            await cmd("evaluate", {
              expression: `(() => { var el = document.querySelector('${firstInput.selector.replace(/'/g, "\\'")}'); if(el) { el.value = ''; el.focus(); } })()`,
            });
            await cmd("type", { selector: firstInput.selector, text });
            console.log(dim(`Typed "${text}" into ${firstInput.text}`));
            await new Promise(r => setTimeout(r, 300));
            await renderPage();
          } else {
            console.log(dim("No input fields found"));
          }
          break;
        }

        case "go": case "open": case "nav": {
          const url = parts.slice(1).join(" ");
          if (!url) { console.log("Usage: go <url>"); break; }
          const fullUrl = url.startsWith("http") ? url : `https://${url}`;
          console.log(dim(`→ ${fullUrl}`));
          await cmd("goto", { url: fullUrl });
          await new Promise(r => setTimeout(r, 500));
          await renderPage();
          break;
        }

        case "back": case "b":
          await cmd("back"); await new Promise(r => setTimeout(r, 500)); await renderPage(); break;
        case "forward": case "f":
          await cmd("forward"); await new Promise(r => setTimeout(r, 500)); await renderPage(); break;
        case "enter": case "submit": {
          // Submit the focused form by building the URL and navigating
          const submitUrl = (await cmd("evaluate", {
            expression: `(() => {
              var focused = document.activeElement;
              if (!focused) return null;
              var form = focused.closest ? focused.closest('form') : focused.form;
              if (!form) return null;
              var action = form.action || window.location.href;
              var method = (form.method || 'get').toLowerCase();
              if (method === 'get') {
                var params = [];
                var inputs = form.querySelectorAll('input[name], select[name], textarea[name]');
                for (var inp of inputs) {
                  if (inp.type === 'submit' || inp.type === 'button' || inp.type === 'image') continue;
                  if (inp.type === 'checkbox' && !inp.checked) continue;
                  if (inp.type === 'radio' && !inp.checked) continue;
                  params.push(encodeURIComponent(inp.name) + '=' + encodeURIComponent(inp.value || ''));
                }
                return action.split('?')[0] + '?' + params.join('&');
              }
              return null;
            })()`,
          })) as string | null;
          if (submitUrl) {
            await cmd("goto", { url: submitUrl });
            await new Promise(r => setTimeout(r, 1200));
            await renderPage();
          } else {
            console.log(dim("No form focused to submit"));
          }
          break;
        }

        case "reload": case "r":
          await cmd("reload"); await new Promise(r => setTimeout(r, 500)); await renderPage(); break;
        case "view": case "refresh":
          await renderPage(); break;

        case "text":
          console.log(await cmd("text")); break;

        case "links": case "els": case "elements":
          printElements(); break;

        case "js": case "eval":
          console.log(await cmd("evaluate", { expression: parts.slice(1).join(" ") })); break;

        case "save": case "ss": case "screenshot": {
          const path = parts[1] ?? `/tmp/tb-${Date.now()}.png`;
          await cmd("screenshot", { path });
          console.log(`Saved: ${path}`);
          break;
        }

        case "help": case "?": case "h":
          printHelp(); break;

        case "quit": case "q": case "exit":
          rl.close(); return;

        default:
          // URL? (has dot, no spaces)
          if (input.includes(".") && !input.includes(" ")) {
            const url = input.startsWith("http") ? input : `https://${input}`;
            console.log(dim(`→ ${url}`));
            await cmd("goto", { url });
            await new Promise(r => setTimeout(r, 500));
            await renderPage();
          } else {
            // Try click by text
            console.log(dim(`Looking for "${input}"...`));
            const found = await clickByText(input);
            if (found) {
              await new Promise(r => setTimeout(r, 800));
              await renderPage();
            } else {
              console.log(dim(`Not found. Type ? for help.`));
            }
          }
      }
    } catch (err) {
      console.log(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
    }

    rl.prompt();
  });

  rl.on("close", () => { console.log("\nBye!"); process.exit(0); });
}
