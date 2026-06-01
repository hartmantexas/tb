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

/** Shared visibility check JS — same as cli.ts */
const VIS_JS = `
  function vis(el){try{if(getComputedStyle(el).display==='none'||el.offsetParent===null)return false}catch(e){return false}var r=el.getBoundingClientRect();if(r.width<2||r.height<2)return false;var hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return hit&&(hit===el||el.contains(hit)||(hit.closest&&hit.closest('a,button')===el))}
  function inView(r){return r.width>5&&r.height>5&&r.x+r.width>0&&r.y+r.height>0&&r.x<window.innerWidth&&r.y<window.innerHeight}
`;

/** Shared collection JS — collects all visible elements, sorts by position */
const COLLECT_JS = `
  var els=[],seen=new Set();
  ${VIS_JS}
  var inputs=document.querySelectorAll('input[type="text"],input[type="search"],input[type="email"],input[type="password"],input[type="url"],input[type="number"],input:not([type]),textarea');
  for(var i=0;i<inputs.length;i++){if(inputs[i].type==='hidden'||!vis(inputs[i]))continue;var r=inputs[i].getBoundingClientRect();if(inView(r))els.push({el:inputs[i],type:'input',text:(inputs[i].getAttribute('placeholder')||inputs[i].name||'input').slice(0,50),y:r.y,x:r.x})}
  var btns=document.querySelectorAll('button,input[type="submit"],input[type="button"],[role="button"]');
  for(var j=0;j<btns.length;j++){if(!vis(btns[j]))continue;var t=(btns[j].textContent||btns[j].value||btns[j].getAttribute('aria-label')||'').trim().replace(/\\s+/g,' ');if(!t||seen.has(t))continue;seen.add(t);var r2=btns[j].getBoundingClientRect();if(inView(r2))els.push({el:btns[j],type:'button',text:t.slice(0,50),y:r2.y,x:r2.x})}
  var links=document.querySelectorAll('a[href]');
  for(var k=0;k<links.length;k++){if(!vis(links[k]))continue;var at=(links[k].textContent||'').trim().replace(/\\s+/g,' ');if(!at||at.length<2||seen.has(at))continue;seen.add(at);var r3=links[k].getBoundingClientRect();if(inView(r3))els.push({el:links[k],type:'link',text:at.slice(0,50),y:r3.y,x:r3.x})}
  els.sort(function(a,b){var dy=a.y-b.y;return Math.abs(dy)>15?dy:a.x-b.x});
`;

/** Build JS to collect, sort, then clear+focus the nth element */
function buildClearFocusJS(num: number): string {
  return `(() => {
    ${COLLECT_JS}
    if(${num}<1||${num}>els.length)return{ok:false};
    var target=els[${num}-1];
    if(target.type!=='input')return{ok:false};
    var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');
    if(setter&&setter.set)setter.set.call(target.el,'');else target.el.value='';
    target.el.dispatchEvent(new Event('input',{bubbles:true}));
    target.el.focus();
    return{ok:true,selector:target.el.id?'#'+target.el.id:(target.el.name?'[name="'+target.el.name+'"]':null)};
  })()`;
}

/** Build JS to collect, sort, then click the nth element — full mouse event sequence */
function buildTapJS(num: number): string {
  return `(() => {
    ${COLLECT_JS}
    if(${num}<1||${num}>els.length)return{ok:false};
    var target=els[${num}-1];
    var rect=target.el.getBoundingClientRect();
    var cx=rect.x+rect.width/2, cy=rect.y+rect.height/2;
    target.el.focus();
    target.el.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,clientX:cx,clientY:cy}));
    target.el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,clientX:cx,clientY:cy,button:0}));
    target.el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,clientX:cx,clientY:cy,button:0}));
    target.el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:cx,clientY:cy,button:0}));
    return{ok:true,type:target.type,text:target.text,x:cx,y:cy};
  })()`;
}

/** Extract elements — same logic as cli.ts, visually sorted, elementFromPoint filtered */
const EXTRACT_ELEMENTS_JS = `(() => {
  ${COLLECT_JS}
  var results = [];
  for (var i = 0; i < els.length; i++) {
    var e = els[i];
    var sel = e.el.id ? '#' + e.el.id : (e.el.name ? '[name="' + e.el.name + '"]' : e.el.tagName.toLowerCase());
    results.push({ index: i+1, type: e.type, text: e.text, value: e.el.value || '', selector: sel });
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
      // Number(s) → click/focus elements using DOM re-enumeration (same walk as tb tap)
      // Supports single "3" or multi "8 10 15"
      const nums = input.split(/\s+/).map(Number).filter(n => n > 0);
      if (nums.length > 0 && input.match(/^[\d\s]+$/)) {
        // Multi-tap: tap all non-input elements, then render once
        if (nums.length > 1) {
          for (const n of nums) {
            const tapR = await cmd("evaluate", { expression: buildTapJS(n) }) as { ok: boolean; text?: string } | null;
            if (tapR?.ok) console.log(dim(`Tapped #${n}: ${tapR.text}`));
            else console.log(dim(`#${n} not found`));
          }
          await new Promise(r => setTimeout(r, 800));
          await renderPage();
          rl.prompt();
          return;
        }
        // Single number
        const num = nums[0];
        const el = lastElements.find(e => e.index === num);
        if (el && el.type === "input") {
          // For inputs, use re-enumeration to focus, then prompt for text
          const tapResult = await cmd("evaluate", { expression: buildTapJS(num) }) as { ok: boolean } | null;
          if (!tapResult?.ok) { console.log(dim(`Element #${num} not found.`)); rl.prompt(); return; }
          console.log(`Focused: ${el.text}`);
          rl.question(`  Type: `, async (text) => {
            if (text.trim()) {
              // Clear and focus via re-enumeration, then type using returned selector
              const cfResult = await cmd("evaluate", { expression: buildClearFocusJS(num) }) as { ok: boolean; selector?: string } | null;
              if (cfResult?.ok && cfResult.selector) {
                await cmd("type", { selector: cfResult.selector, text: text.trim() });
              } else {
                // Fallback: type into the active element
                await cmd("evaluate", { expression: `document.activeElement && (document.activeElement.value = ${JSON.stringify(text.trim())}, document.activeElement.dispatchEvent(new Event('input', {bubbles:true})), true)` });
              }
              console.log(dim(`  Typed "${text.trim()}" into ${el.text}`));
            }
            await new Promise(r => setTimeout(r, 300));
            await renderPage();
            rl.prompt();
          });
          return;
        } else {
          // For buttons/links, use tap JS with full mouse event sequence
          const tapResult = await cmd("evaluate", { expression: buildTapJS(num) }) as { ok: boolean; type?: string; text?: string } | null;
          if (tapResult?.ok) {
            console.log(dim(`Clicked: ${tapResult.text} (${tapResult.type})`));
            await new Promise(r => setTimeout(r, 1200));
            await renderPage();
          } else {
            console.log(dim(`No element #${num}. Type "links" to see all.`));
          }
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
            // Clear and focus via re-enumeration (element #1 is always the first input)
            const cfResult = await cmd("evaluate", { expression: buildClearFocusJS(firstInput.index) }) as { ok: boolean; selector?: string } | null;
            if (cfResult?.ok && cfResult.selector) {
              await cmd("type", { selector: cfResult.selector, text });
            } else {
              await cmd("evaluate", { expression: `document.activeElement && (document.activeElement.value = ${JSON.stringify(text)}, document.activeElement.dispatchEvent(new Event('input', {bubbles:true})), true)` });
            }
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
