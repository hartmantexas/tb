import { CDPClient } from "./cdp.js";
import type { EngineType } from "./engines/types.js";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { renderWithTakumi } from "./takumi-renderer.js";

/**
 * Render HTML to PNG using Blitz (Rust-based renderer with Firefox's Stylo CSS engine).
 * Falls back to Takumi if Blitz binary isn't available.
 */
async function renderHTML(html: string, width = 1280, height = 720, baseUrl = "https://localhost/", fullPage = false): Promise<Buffer> {
  // Try Blitz first (full CSS rendering)
  const blitzPath = join(new URL(".", import.meta.url).pathname, "..", "render-engine", "target", "release", "tb-render");

  if (existsSync(blitzPath)) {
    try {
      // argv: width height scale base_url [full] — base_url lets relative resource
      // URLs resolve (and prevents a panic on protocol-relative URLs); "full"
      // renders the entire document height instead of just the viewport.
      const proc = Bun.spawn([blitzPath, String(width), String(height), "2", baseUrl, fullPage ? "full" : ""], {
        stdin: new Blob([html]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(proc.stdout).arrayBuffer();
      const exitCode = await proc.exited;
      if (exitCode === 0 && output.byteLength > 100) {
        // Strip any non-PNG bytes (Blitz CSS parser may print warnings to stdout)
        const buf = Buffer.from(output);
        const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // \x89PNG
        const pngStart = buf.indexOf(pngMagic);
        if (pngStart > 0) {
          return buf.subarray(pngStart); // skip junk before PNG header
        }
        return buf;
      }
      const stderr = await new Response(proc.stderr).text();
      console.error("[tb] Blitz error:", stderr.slice(0, 200));
    } catch (err) {
      console.error("[tb] Blitz failed:", (err as Error).message);
    }
  }

  // Fallback to Takumi
  try {
    const { renderWithTakumi } = await import("./takumi-renderer.js");
    // For Takumi we need a styled tree, not raw HTML — this is a degraded path
    // Just render a simple message since Takumi can't parse HTML
    return await renderWithTakumi(null, { width, height });
  } catch {
    return Buffer.alloc(0);
  }
}

/**
 * JS to inject into lightpanda that walks the DOM and extracts
 * a satori-compatible element tree with computed styles inlined.
 * This is the key innovation: lightpanda computes CSS (CSSOM),
 * it just can't paint. We extract the computed styles and let satori paint.
 */
// The old 900-line extraction is replaced by this clean version.
// CSS class→style map is pre-injected at window.__tbClassMap by our Bun process.
const EXTRACT_STYLED_TREE_JS = `(async () => {
  // Clean extraction: uses pre-injected window.__tbClassMap for CSS resolution.
  // Max 500 nodes, max depth 12, per-element error handling.
  var map = window.__tbClassMap || {};
  var count = 0;
  var MAX = 500;
  var SKIP = {script:1,style:1,link:1,meta:1,noscript:1,svg:1,iframe:1,template:1,path:1,circle:1,rect:1,line:1,polygon:1,defs:1,clipPath:1,mask:1,g:1};

  function getS(el) {
    var s = {};
    // Computed styles (whatever lightpanda gives us)
    try {
      var cs = window.getComputedStyle(el);
      if (cs.color && cs.color !== 'rgb(0, 0, 0)') s.color = cs.color;
      if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)') s.backgroundColor = cs.backgroundColor;
      if (cs.fontSize && cs.fontSize !== '16px' && cs.fontSize !== '') s.fontSize = cs.fontSize;
      if (cs.fontWeight && cs.fontWeight !== '400' && cs.fontWeight !== '' && cs.fontWeight !== 'normal') s.fontWeight = cs.fontWeight;
      if (cs.display === 'none') s.display = 'none';
      if (cs.visibility === 'hidden') s.display = 'none';
    } catch(e) {}
    // Class-based styles from pre-built map
    var classes = (el.className || '').toString().split(/\\s+/);
    for (var i = 0; i < classes.length; i++) {
      var c = classes[i];
      if (!c) continue;
      if (map[c]) { for (var k in map[c]) s[k] = map[c][k]; }
      // Tailwind bracket syntax: bg-[#020617], text-[14px], p-[20px], etc.
      var m = c.match(/^([a-z]+-?[a-z]*)-\\[(.+)\\]$/);
      if (m) {
        var p = m[1], v = m[2];
        if (p==='bg') s.backgroundColor=v;
        else if (p==='text'&&(v.startsWith('#')||v.startsWith('rgb'))) s.color=v;
        else if (p==='text'&&(v.endsWith('px')||v.endsWith('rem')||v.endsWith('em'))) s.fontSize=v;
        else if (p==='p') { s.paddingTop=v;s.paddingRight=v;s.paddingBottom=v;s.paddingLeft=v; }
        else if (p==='px') { s.paddingLeft=v;s.paddingRight=v; }
        else if (p==='py') { s.paddingTop=v;s.paddingBottom=v; }
        else if (p==='pt') s.paddingTop=v; else if (p==='pb') s.paddingBottom=v;
        else if (p==='pl') s.paddingLeft=v; else if (p==='pr') s.paddingRight=v;
        else if (p==='m') { s.marginTop=v;s.marginRight=v;s.marginBottom=v;s.marginLeft=v; }
        else if (p==='mx') { s.marginLeft=v;s.marginRight=v; }
        else if (p==='my') { s.marginTop=v;s.marginBottom=v; }
        else if (p==='mt') s.marginTop=v; else if (p==='mb') s.marginBottom=v;
        else if (p==='ml') s.marginLeft=v; else if (p==='mr') s.marginRight=v;
        else if (p==='w') s.width=v; else if (p==='h') s.height=v;
        else if (p==='max-w') s.maxWidth=v; else if (p==='min-h') s.minHeight=v;
        else if (p==='gap') s.gap=v; else if (p==='rounded') s.borderRadius=v;
        else if (p==='z') s.zIndex=v;
        else if (p==='top') s.top=v; else if (p==='left') s.left=v;
        else if (p==='right') s.right=v; else if (p==='bottom') s.bottom=v;
        else if (p==='opacity') s.opacity=v;
        else if (p==='border') s.borderWidth=v;
      }
      // Common Tailwind utilities
      if (c==='text-white') s.color='#fff';
      else if (c==='text-black') s.color='#000';
      else if (c==='bg-white') s.backgroundColor='#fff';
      else if (c==='bg-black') s.backgroundColor='#000';
      else if (c==='hidden') s.display='none';
      else if (c==='flex') s.display='flex';
      else if (c==='block') s.display='block';
      else if (c==='grid') s.display='grid';
      else if (c==='inline-flex') s.display='inline-flex';
      else if (c==='flex-col') s.flexDirection='column';
      else if (c==='flex-row') s.flexDirection='row';
      else if (c==='flex-1') s.flex='1';
      else if (c==='flex-shrink-0') s.flexShrink='0';
      else if (c==='flex-wrap') s.flexWrap='wrap';
      else if (c==='items-center') s.alignItems='center';
      else if (c==='items-start') s.alignItems='flex-start';
      else if (c==='items-end') s.alignItems='flex-end';
      else if (c==='justify-center') s.justifyContent='center';
      else if (c==='justify-between') s.justifyContent='space-between';
      else if (c==='justify-end') s.justifyContent='flex-end';
      else if (c==='text-center') s.textAlign='center';
      else if (c==='text-left') s.textAlign='left';
      else if (c==='text-right') s.textAlign='right';
      else if (c==='font-bold') s.fontWeight='700';
      else if (c==='font-semibold') s.fontWeight='600';
      else if (c==='font-medium') s.fontWeight='500';
      else if (c==='font-light') s.fontWeight='300';
      else if (c==='font-normal') s.fontWeight='400';
      else if (c==='text-xs') s.fontSize='12px';
      else if (c==='text-sm') s.fontSize='14px';
      else if (c==='text-base') s.fontSize='16px';
      else if (c==='text-lg') s.fontSize='18px';
      else if (c==='text-xl') s.fontSize='20px';
      else if (c==='text-2xl') s.fontSize='24px';
      else if (c==='text-3xl') s.fontSize='30px';
      else if (c==='text-4xl') s.fontSize='36px';
      else if (c==='text-5xl') s.fontSize='48px';
      else if (c==='text-6xl') s.fontSize='60px';
      else if (c==='w-full') s.width='100%';
      else if (c==='h-full') s.height='100%';
      else if (c==='min-h-screen') s.minHeight='100vh';
      else if (c==='overflow-hidden') s.overflow='hidden';
      else if (c==='overflow-x-hidden') s.overflowX='hidden';
      else if (c==='relative') s.position='relative';
      else if (c==='absolute') s.position='absolute';
      else if (c==='fixed') s.position='fixed';
      else if (c==='inset-0') { s.top='0';s.right='0';s.bottom='0';s.left='0'; }
      else if (c==='rounded-full') s.borderRadius='9999px';
      else if (c==='rounded-lg') s.borderRadius='.5rem';
      else if (c==='rounded-xl') s.borderRadius='.75rem';
      else if (c==='rounded-2xl') s.borderRadius='1rem';
      else if (c==='underline') s.textDecoration='underline';
      else if (c==='uppercase') s.textTransform='uppercase';
      else if (c==='lowercase') s.textTransform='lowercase';
      else if (c==='capitalize') s.textTransform='capitalize';
      else if (c==='truncate') s.overflow='hidden';
      else if (c==='cursor-pointer') s.cursor='pointer';
    }
    // HTML attributes
    var bg = el.getAttribute('bgcolor');
    if (bg) s.backgroundColor = bg;
    var w = el.getAttribute('width');
    if (w) s.width = w.indexOf('%')!==-1 ? w : parseInt(w)?w+'px':w;
    return s;
  }

  function build(el, depth) {
    if (count > MAX || depth > 12) return null;
    if (el.nodeType === 3) {
      var t = (el.textContent||'').replace(/\\s+/g,' ').trim();
      return t ? t : null;
    }
    if (el.nodeType !== 1) return null;
    var tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (SKIP[tag]) return null;
    count++;
    try {
      var s = getS(el);
      if (s.display === 'none') return null;
      // Skip ALL fixed elements (they overlap in static render and waste space)
      if (s.position === 'fixed') return null;
      // Skip absolute overlays with no meaningful text (decorative backgrounds)
      if (s.position === 'absolute' && !(el.textContent || '').trim()) return null;
      // Skip pointer-events:none overlays
      if (s.pointerEvents === 'none' && !(el.textContent || '').trim()) return null;

      var kids = [];
      var cn = el.childNodes;
      for (var i = 0; i < cn.length; i++) {
        var k = build(cn[i], depth+1);
        if (k) kids.push(k);
      }
      // Skip empty containers with no text
      if (kids.length === 0 && !(el.textContent||'').trim()) return null;

      // Table elements → flex
      if (tag==='table'||tag==='thead'||tag==='tbody'||tag==='tfoot') {
        s.display='flex'; s.flexDirection='column';
        if (tag==='table'&&!s.width) s.width='100%';
      } else if (tag==='tr') {
        s.display='flex'; s.flexDirection='row'; if(!s.width) s.width='100%';
      } else if (tag==='td'||tag==='th') {
        s.display='flex'; s.flexDirection='column';
        // Smart column sizing: narrow cells get fixed width, wide cells flex
        var cellText = (el.textContent||'').trim();
        var cellW = el.getAttribute('width');
        if (cellW) {
          s.width = cellW.indexOf('%')!==-1 ? cellW : parseInt(cellW)+'px';
          s.flexShrink='0'; s.flexGrow='0';
        } else if (cellText.length <= 5) {
          s.width = Math.max(cellText.length * 12, 20) + 'px';
          s.flexShrink='0'; s.flexGrow='0';
        } else if (!s.flex && !s.width) {
          s.flex='1';
        }
        if (tag==='th' && (!s.fontWeight||s.fontWeight==='400')) s.fontWeight='700';
      }

      return { type: 'div', props: { style: s, children: kids.length===1 ? kids[0] : kids } };
    } catch(e) { return null; }
  }

  var wrapper = document.querySelector('[class*="min-h-screen"]') || document.body;
  var ws = getS(wrapper);
  var tree = build(wrapper, 0);
  if (!tree) return null;
  // Ensure root wrapper has proper styles
  tree.props.style = { ...ws, ...tree.props.style };
  if (!tree.props.style.display || tree.props.style.display === 'block') {
    tree.props.style.display = 'flex';
    tree.props.style.flexDirection = 'column';
  }
  return tree;
})()`;

export class Session {
  private screencastFrame: { base64: string; ts: number } | null = null;
  private screencastActive = false;
  private onScreencastFrame: ((base64: string) => void) | null = null;

  private viewport: { width: number; height: number };

  constructor(
    private cdp: CDPClient,
    private engineType: "lightpanda" | "chromium",
    viewport?: { width: number; height: number },
  ) {
    this.viewport = viewport ?? { width: 1280, height: 720 };
  }

  async init(): Promise<void> {
    if (this.engineType === "lightpanda") {
      // Lightpanda CDP handshake:
      // 1. setAutoAttach → fires Target.attachedToTarget with sessionId
      // 2. createBrowserContext → returns browserContextId
      // 3. createTarget → fires attachedToTarget with real sessionId
      // 4. Enable domains using the real sessionId

      // Step 1: Set up auto-attach and capture the session ID
      const attachPromise = new Promise<string>((resolve) => {
        this.cdp.on("Target.attachedToTarget", (params) => {
          const sid = params.sessionId as string;
          // Skip the initial STARTUP session, take the real one
          if (sid && sid !== "STARTUP") {
            resolve(sid);
          }
        });
      });

      await this.cdp.send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });

      // Step 2: Create browser context
      let browserContextId: string;
      try {
        const ctx = (await this.cdp.send("Target.createBrowserContext", {
          disposeOnDetach: true,
        })) as { browserContextId: string };
        browserContextId = ctx.browserContextId;
      } catch {
        browserContextId = "";
      }

      // Step 3: Create target page
      const targetParams: Record<string, unknown> = { url: "about:blank" };
      if (browserContextId) targetParams.browserContextId = browserContextId;
      await this.cdp.send("Target.createTarget", targetParams);

      // Wait for the real session ID (with timeout)
      const sessionId = await Promise.race([
        attachPromise,
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("Timeout waiting for session")), 5000),
        ),
      ]);

      this.cdp.sessionId = sessionId;

      // Step 4: Enable domains with the session ID
      try {
        await this.cdp.send("Runtime.runIfWaitingForDebugger");
      } catch {}
      await Promise.allSettled([
        this.cdp.send("Page.enable"),
        this.cdp.send("Runtime.enable"),
        this.cdp.send("Network.enable"),
        this.cdp.send("Page.setLifecycleEventsEnabled", { enabled: true }),
      ]);
    } else {
      // Chromium: enable domains + inject stealth patches
      await Promise.allSettled([
        this.cdp.send("Page.enable"),
        this.cdp.send("Runtime.enable"),
        this.cdp.send("Network.enable"),
        this.cdp.send("DOM.enable"),
      ]);

      // Override user-agent to remove "HeadlessChrome" — the #1 detection signal
      await this.cdp.send("Network.setUserAgentOverride", {
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
        platform: "MacIntel",
      }).catch(() => {});

      // Stealth: inject anti-detection patches before any page JS runs
      await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `
          // Remove webdriver flag (primary headless detection signal)
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

          // Add chrome runtime object
          if (!window.chrome) window.chrome = {};
          if (!window.chrome.runtime) window.chrome.runtime = {};

          // Fix permissions API
          const origQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
          window.navigator.permissions.query = (params) =>
            params.name === 'notifications'
              ? Promise.resolve({ state: Notification.permission })
              : origQuery(params);

          // Fix plugins (headless has 0, real browsers have some)
          Object.defineProperty(navigator, 'plugins', {
            get: () => {
              const arr = [
                { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
                { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
              ];
              arr.item = (i) => arr[i];
              arr.namedItem = (n) => arr.find(p => p.name === n);
              arr.refresh = () => {};
              return arr;
            },
          });

          // Fix languages
          Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

          // Fix WebGL vendor/renderer (headless returns Google SwiftShader)
          const getParam = WebGLRenderingContext.prototype.getParameter;
          WebGLRenderingContext.prototype.getParameter = function(param) {
            if (param === 37445) return 'Intel Inc.';
            if (param === 37446) return 'Intel Iris OpenGL Engine';
            return getParam.call(this, param);
          };

          // Fix iframe contentWindow access
          const origAttachShadow = Element.prototype.attachShadow;
          Element.prototype.attachShadow = function() {
            return origAttachShadow.call(this, ...arguments);
          };

          // Fix toString on patched functions
          const origToString = Function.prototype.toString;
          const customFns = new Set();
          Function.prototype.toString = function() {
            if (customFns.has(this)) return 'function () { [native code] }';
            return origToString.call(this);
          };
        `,
      });
    }
  }

  // --- Accessibility Tree ---

  /** Get semantic snapshot — uses DOM + ARIA for reliability, AX tree as enhancement */
  async snapshot(options: { interactive?: boolean; compact?: boolean; depth?: number } = {}): Promise<{
    tree: string;
    refs: Array<{ ref: string; role: string; name: string; selector: string; description?: string; value?: string }>;
  }> {
    // DOM-based approach with ARIA enrichment — works on all pages, no CDP domain dependencies
    const result = (await this.cdp.send("Runtime.evaluate", {
      expression: `(() => {
        var refs = [], lines = [], seen = new Set();
        var idx = 1;

        function getRole(el) {
          var r = el.getAttribute('role');
          if (r) return r;
          var tag = el.tagName;
          if (tag === 'A') return 'link';
          if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
          if (tag === 'INPUT') {
            var t = el.type || 'text';
            if (t === 'checkbox') return 'checkbox';
            if (t === 'radio') return 'radio';
            if (t === 'submit' || t === 'button') return 'button';
            if (t === 'search') return 'searchbox';
            return 'textbox';
          }
          if (tag === 'TEXTAREA') return 'textbox';
          if (tag === 'SELECT') return 'combobox';
          if (tag === 'NAV') return 'navigation';
          if (tag === 'MAIN') return 'main';
          if (tag === 'H1' || tag === 'H2' || tag === 'H3') return 'heading';
          return '';
        }

        function getName(el) {
          return el.getAttribute('aria-label')
            || el.getAttribute('title')
            || el.getAttribute('placeholder')
            || el.getAttribute('alt')
            || (el.tagName === 'INPUT' ? (el.labels?.[0]?.textContent?.trim() || '') : '')
            || el.textContent?.trim()?.replace(/\\s+/g, ' ')?.slice(0, 60)
            || '';
        }

        function getSel(el) {
          if (el.id) return '#' + el.id;
          if (el.name) return '[name="' + el.name + '"]';
          if (el.getAttribute('data-testid')) return '[data-testid="' + el.getAttribute('data-testid') + '"]';
          return el.tagName.toLowerCase();
        }

        function vis(el) {
          try { if (getComputedStyle(el).display === 'none' || el.offsetParent === null) return false; } catch(e) { return false; }
          var r = el.getBoundingClientRect();
          return r.width > 2 && r.height > 2;
        }

        var interactive = ${options.interactive ? 'true' : 'false'};

        // Walk semantic elements
        var selectors = 'button, a[href], input, textarea, select, [role=button], [role=tab], [role=link], [role=menuitem], [contenteditable=true], summary, h1, h2, h3, [onclick]';
        if (!interactive) selectors += ', nav, main, section, article, form';

        document.querySelectorAll(selectors).forEach(el => {
          if (!vis(el)) return;
          var role = getRole(el);
          if (!role) return;
          var name = getName(el);
          if (seen.has(role + ':' + name) && name) return;
          if (name) seen.add(role + ':' + name);

          var isInteractive = /^(button|link|textbox|searchbox|combobox|checkbox|radio|tab|menuitem|switch)$/.test(role);
          var ref = '';
          if (isInteractive) {
            ref = '@e' + idx;
            var r = el.getBoundingClientRect();
            refs.push({
              ref: ref,
              role: role,
              name: name.slice(0, 80),
              selector: getSel(el),
              value: el.value || '',
              x: Math.round(r.x), y: Math.round(r.y),
            });
            idx++;
          }

          if (!interactive || isInteractive) {
            var line = role + (ref ? ' ' + ref : '') + (name ? ' "' + name.slice(0,50) + '"' : '');
            lines.push(line);
          }
        });

        // Sort refs by visual position
        refs.sort(function(a,b) { var dy = a.y - b.y; return Math.abs(dy) > 15 ? dy : a.x - b.x; });
        for (var i = 0; i < refs.length; i++) refs[i].ref = '@e' + (i + 1);

        return { tree: lines.join('\\n'), refs: refs };
      })()`,
      returnByValue: true,
    })) as { result: { value: any } };

    return result.result.value;
  }

  /** Click an element by ref (@e1) — uses selector from snapshot */
  async tapRef(ref: string, refs: Array<{ ref: string; selector: string; role?: string; name?: string }>): Promise<{ ok: boolean; role?: string; name?: string }> {
    const entry = refs.find(r => r.ref === ref);
    if (!entry) return { ok: false };
    this.logDVR("tapRef", { ref, name: entry.name });

    await this.cdp.send("Runtime.evaluate", {
      expression: `(() => {
        var el = document.querySelector('${entry.selector.replace(/'/g, "\\'")}');
        if (!el) return false;
        el.scrollIntoViewIfNeeded?.();
        el.focus();
        el.click();
        return true;
      })()`,
    });

    return { ok: true, role: entry.role, name: entry.name };
  }

  /** Find element by semantic match — no LLM, instant string matching */
  findElement(query: string, refs: Array<{ ref: string; role: string; name: string }>): string | null {
    const q = query.toLowerCase().trim();

    // 1. Exact name
    let match = refs.find(r => r.name.toLowerCase() === q);
    if (match) return match.ref;

    // 2. Name contains query
    match = refs.find(r => r.name.toLowerCase().includes(q));
    if (match) return match.ref;

    // 3. Query contains name (for short element names like "OK", "Go")
    match = refs.find(r => r.name.length > 1 && q.includes(r.name.toLowerCase()));
    if (match) return match.ref;

    // 4. Role-aware: "sign in button" → button with "sign in"
    for (const rw of ['button', 'link', 'textbox', 'input', 'checkbox', 'tab', 'search']) {
      if (q.includes(rw)) {
        const nameQ = q.replace(new RegExp(rw, 'g'), '').replace(/\b(the|a|an|click|tap|press)\b/g, '').trim();
        if (nameQ.length > 1) {
          match = refs.find(r => r.role.includes(rw === 'input' ? 'textbox' : rw) && r.name.toLowerCase().includes(nameQ));
          if (match) return match.ref;
        }
      }
    }

    // 5. Fuzzy: best substring overlap
    let best = 0, bestRef: string | null = null;
    for (const r of refs) {
      const name = r.name.toLowerCase();
      if (!name) continue;
      // Simple: count matching words
      const qWords = q.split(/\s+/);
      const nWords = name.split(/\s+/);
      let hits = 0;
      for (const qw of qWords) { if (nWords.some(nw => nw.includes(qw) || qw.includes(nw))) hits++; }
      const score = hits / Math.max(qWords.length, 1);
      if (score > 0.4 && score > best) { best = score; bestRef = r.ref; }
    }

    return bestRef;
  }

  /** Wait for content to settle — polls for stable text length */
  async waitForSettled(timeout = 15000): Promise<void> {
    const start = Date.now();
    let lastLen = 0;
    let stableCount = 0;
    while (Date.now() - start < timeout) {
      const result = (await this.cdp.send("Runtime.evaluate", {
        expression: "document.body.innerText.length",
        returnByValue: true,
      })) as { result: { value: number } };
      const len = result.result.value;
      if (len === lastLen) {
        stableCount++;
        if (stableCount >= 3) return; // 3 stable checks = settled
      } else {
        stableCount = 0;
        lastLen = len;
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // --- Navigation ---

  async goto(url: string): Promise<{ status: number; url: string }> {
    this.logDVR("goto", { url });
    const loadPromise = this.cdp.once("Page.loadEventFired");
    const result = (await this.cdp.send("Page.navigate", { url })) as {
      frameId?: string;
      errorText?: string;
    };
    if (result.errorText) {
      throw new Error(`Navigation failed: ${result.errorText}`);
    }
    await Promise.race([
      loadPromise,
      new Promise((r) => setTimeout(r, 15000)),
    ]);
    const currentUrl = await this.url();
    return { status: 200, url: currentUrl };
  }

  async reload(): Promise<void> {
    const loadPromise = this.cdp.once("Page.loadEventFired");
    await this.cdp.send("Page.reload");
    await Promise.race([
      loadPromise,
      new Promise((r) => setTimeout(r, 15000)),
    ]);
  }

  async back(): Promise<void> {
    const history = (await this.cdp.send(
      "Page.getNavigationHistory",
    )) as { currentIndex: number; entries: Array<{ id: number }> };
    if (history.currentIndex > 0) {
      await this.cdp.send("Page.navigateToHistoryEntry", {
        entryId: history.entries[history.currentIndex - 1].id,
      });
    }
  }

  async forward(): Promise<void> {
    const history = (await this.cdp.send(
      "Page.getNavigationHistory",
    )) as { currentIndex: number; entries: Array<{ id: number }> };
    if (history.currentIndex < history.entries.length - 1) {
      await this.cdp.send("Page.navigateToHistoryEntry", {
        entryId: history.entries[history.currentIndex + 1].id,
      });
    }
  }

  // --- Content extraction ---

  async content(): Promise<string> {
    const result = (await this.cdp.send("Runtime.evaluate", {
      expression: "document.documentElement.outerHTML",
      returnByValue: true,
    })) as { result: { value: string } };
    return result.result.value;
  }

  async text(): Promise<string> {
    const result = (await this.cdp.send("Runtime.evaluate", {
      expression: "document.body.innerText",
      returnByValue: true,
    })) as { result: { value: string } };
    return result.result.value;
  }

  async title(): Promise<string> {
    const result = (await this.cdp.send("Runtime.evaluate", {
      expression: "document.title",
      returnByValue: true,
    })) as { result: { value: string } };
    return result.result.value;
  }

  async url(): Promise<string> {
    const result = (await this.cdp.send("Runtime.evaluate", {
      expression: "window.location.href",
      returnByValue: true,
    })) as { result: { value: string } };
    return result.result.value;
  }

  // --- Interaction ---

  async click(selector: string): Promise<void> {
    // Use JS to find element and get its position, then dispatch click
    const result = (await this.cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`,
      returnByValue: true,
    })) as { result: { value: { x: number; y: number } | null } };

    const pos = result.result.value;
    if (!pos) throw new Error(`Element not found: ${selector}`);

    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: pos.x,
      y: pos.y,
      button: "left",
      clickCount: 1,
    });
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: pos.x,
      y: pos.y,
      button: "left",
      clickCount: 1,
    });
  }

  async clickAt(x: number, y: number): Promise<void> {
    this.logDVR("clickAt", { x, y });
    // JS-based click (works for SPAs, watch coordinate mapping, etc.)
    await this.cdp.send("Runtime.evaluate", {
      expression: `(() => {
        var el = document.elementFromPoint(${x}, ${y});
        if (!el) return;
        var target = el.closest('a, button, [onclick], [role="button"], input, select, textarea, label, summary, details') || el;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') target.focus();
        target.click();
      })()`,
    });
  }

  /** Real CDP mouse click — for Turnstile/captcha that detect JS clicks */
  async realClick(x: number, y: number): Promise<void> {
    this.logDVR("realClick", { x, y });
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await new Promise(r => setTimeout(r, 50));
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await new Promise(r => setTimeout(r, 50));
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  async typeText(text: string): Promise<void> {
    for (const char of text) {
      await this.cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        text: char,
        key: char,
        unmodifiedText: char,
      });
      await this.cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        text: char,
        key: char,
      });
    }
  }

  async keyPress(key: string): Promise<void> {
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code: key,
      windowsVirtualKeyCode: key === "Enter" ? 13 : key === "Backspace" ? 8 : key === "Tab" ? 9 : key === "Escape" ? 27 : 0,
    });
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code: key,
    });
  }

  async type(selector: string, text: string): Promise<void> {
    // Focus the element first
    await this.cdp.send("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(selector)})?.focus()`,
    });

    // Type each character
    for (const char of text) {
      await this.cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        text: char,
        key: char,
        unmodifiedText: char,
      });
      await this.cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        text: char,
        key: char,
      });
    }
  }

  async select(selector: string, value: string): Promise<void> {
    await this.cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el) { el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); }
      })()`,
    });
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = (await this.cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result: { value: T }; exceptionDetails?: { text: string } };

    if (result.exceptionDetails) {
      throw new Error(`JS error: ${result.exceptionDetails.text}`);
    }
    return result.result.value;
  }

  // --- Screenshots ---

  /**
   * Run the in-page CSS-cascade resolver (extract-resolved.js) and return the
   * styled tree for Takumi. Lightpanda parses CSS + matches selectors but never
   * folds the cascade into getComputedStyle, so we compute it ourselves.
   */
  private async extractResolvedTree(): Promise<unknown> {
    const jsPath = join(new URL(".", import.meta.url).pathname, "extract-resolved.js");
    if (!existsSync(jsPath)) return null;
    const script = readFileSync(jsPath, "utf-8");
    try {
      const res = (await this.cdp.send("Runtime.evaluate", {
        expression: script,
        returnByValue: true,
      })) as { result?: { value?: unknown } };
      return res.result?.value ?? null;
    } catch {
      return null;
    }
  }

  async screenshot(options: {
    path?: string;
    fullPage?: boolean;
    format?: "png" | "jpeg";
    quality?: number;
    width?: number;
    height?: number;
  } = {}): Promise<Buffer> {
    // Lightpanda: get full HTML → render with Blitz (real CSS engine)
    if (this.engineType === "lightpanda") {
      // Force all elements visible (animations may not have run in lightpanda)
      // and capture video frames while we can still access the DOM
      await this.cdp.send("Runtime.evaluate", {
        expression: `(() => {
          // Force opacity:0 → 1 (animation initial states)
          document.querySelectorAll('[style]').forEach(el => {
            if (el.style.opacity === '0') el.style.opacity = '1';
            if (el.style.visibility === 'hidden') el.style.visibility = 'visible';
          });
          // Collect video sources for frame extraction
          window.__tbVideoSrcs = [];
          document.querySelectorAll('video').forEach((v, i) => {
            var src = v.src || (v.querySelector('source') || {}).src || '';
            if (src) {
              var parent = v.parentElement;
              // Mark parent with a data attribute so we can set background-image later
              if (parent) parent.setAttribute('data-tb-video', String(i));
              window.__tbVideoSrcs.push({ index: i, src: src });
            }
            // Remove video element (Blitz can't render it)
            v.remove();
          });
        })()`,
      }).catch(() => {});

      // Get HTML after DOM modifications
      const htmlContent = await this.content();

      // Fetch external CSS and inline it for Blitz
      let fullHTML = htmlContent;
      // Blitz (real engine) gets a near-original HTML: inlined CSS + a root pinned
      // to the viewport so the page fills it (Blitz otherwise shrink-wraps the body).
      let blitzHTML = htmlContent;
      try {
        const linksResult = (await this.cdp.send("Runtime.evaluate", {
          expression: `Array.from(document.querySelectorAll('link[rel=stylesheet]')).map(l => l.href).filter(Boolean)`,
          returnByValue: true,
        })) as { result: { value: string[] } };
        const cssUrls = linksResult.result.value || [];

        let allCSS = "";
        for (const url of cssUrls) {
          try {
            const resp = await fetch(url);
            if (resp.ok) allCSS += await resp.text();
          } catch {}
        }

        // Make external CSS visible to the in-page resolver: inject it as a
        // <style> into the LIVE DOM so document.styleSheets includes it.
        if (allCSS) {
          await this.cdp.send("Runtime.evaluate", {
            expression: `(()=>{try{var s=document.createElement('style');s.textContent=${JSON.stringify(allCSS)};(document.head||document.documentElement).appendChild(s);}catch(e){}})()`,
          }).catch(() => {});
        }

        // Build the Blitz HTML: original markup, external CSS inlined, scripts and
        // un-fetchable stylesheet links dropped, and a root sized to the viewport.
        {
          const W = options.width ?? this.viewport.width;
          const H = options.height ?? this.viewport.height;
          const normalize = `<style>html{width:${W}px;min-height:${H}px;display:flex}body{width:100%;margin:0}</style>`;
          const cssTag = allCSS ? `<style>${allCSS}</style>` : "";
          let bh = blitzHTML
            .replace(/<link[^>]*rel=["']?stylesheet["']?[^>]*>/gi, "")
            .replace(/<script[\s\S]*?<\/script>/gi, "");
          blitzHTML = bh.includes("</head>")
            ? bh.replace("</head>", `${cssTag}${normalize}</head>`)
            : `${cssTag}${normalize}${bh}`;
        }

        // Inject CSS into HTML, remove external refs Blitz can't fetch,
        // and patch viewport-height units that push content below fold
        if (allCSS) {
          // Patch viewport heights to auto so content packs tightly
          allCSS = allCSS.replace(/min-height\s*:\s*100[dls]?vh/g, "min-height:auto");
          allCSS = allCSS.replace(/height\s*:\s*100[dls]?vh/g, "height:auto");

          const styleTag = `<style>${allCSS}</style>`;
          fullHTML = fullHTML.replace(/<link[^>]*>/gi, "");
          fullHTML = fullHTML.replace(/<img[^>]*>/gi, "");
          // Grab video frames and inject as background-image on parent containers
          const grabFramePath = join(new URL(".", import.meta.url).pathname, "..", "tools", "grab-frame");
          if (existsSync(grabFramePath)) {
            // Get video sources that were collected during DOM prep
            const videoSrcsResult = (await this.cdp.send("Runtime.evaluate", {
              expression: `JSON.stringify(window.__tbVideoSrcs || [])`,
              returnByValue: true,
            }).catch(() => ({ result: { value: "[]" } }))) as { result: { value: string } };
            const videoSrcs = JSON.parse(videoSrcsResult.result.value || "[]") as Array<{ index: number; src: string }>;

            for (const vs of videoSrcs) {
              try {
                const proc = Bun.spawn([grabFramePath, vs.src, "0.5"], {
                  stdout: "pipe", stderr: "pipe",
                });
                const frameData = await new Response(proc.stdout).arrayBuffer();
                const exitCode = await proc.exited;
                if (exitCode === 0 && frameData.byteLength > 100) {
                  // Convert PNG to smaller JPEG using sharp-like approach or just use PNG
                  // but keep it reasonable size by scaling down
                  const buf = Buffer.from(frameData);
                  const b64 = buf.toString("base64");

                  // Replace the marked parent's content with an img tag
                  const marker = `data-tb-video="${vs.index}"`;
                  // Insert an <img> as first child of the marked element
                  fullHTML = fullHTML.replace(
                    new RegExp(`(${marker}[^>]*>)`),
                    `$1<img src="data:image/png;base64,${b64}" style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;z-index:0" />`
                  );
                }
              } catch {}
            }
          }
          fullHTML = fullHTML.replace(/<script[\s\S]*?<\/script>/gi, "");
          // Patch viewport heights in inline styles too
          fullHTML = fullHTML.replace(/min-height:\s*100[dls]?vh/g, "min-height:auto");
          fullHTML = fullHTML.replace(/height:\s*100[dls]?vh/g, "height:auto");
          // Opacity already forced to 1 via JS on the live DOM above
          if (fullHTML.includes("</head>")) {
            fullHTML = fullHTML.replace("</head>", `${styleTag}</head>`);
          } else {
            fullHTML = styleTag + fullHTML;
          }
        }
      } catch {}

      const width = options.width ?? this.viewport.width;
      const height = options.height ?? this.viewport.height;

      // Prefer Blitz (Rust/Stylo) when its binary is built. Otherwise resolve the
      // CSS cascade in-page and paint with Takumi — far better than the old
      // renderHTML→renderWithTakumi(null) fallback, which produced a blank page.
      const blitzPath = join(new URL(".", import.meta.url).pathname, "..", "render-engine", "target", "release", "tb-render");
      const pageUrl = await this.url().catch(() => "https://localhost/");
      let buffer: Buffer;
      if (existsSync(blitzPath)) {
        // Pixel-perfect: real Stylo/Taffy/Vello rendering of near-original HTML.
        buffer = await renderHTML(blitzHTML, width, height, pageUrl, !!options.fullPage);
      } else {
        // No Blitz binary: in-page cascade resolver → Takumi approximation.
        const tree = await this.extractResolvedTree();
        buffer = tree
          ? await renderWithTakumi(tree, { width, height })
          : await renderHTML(fullHTML, width, height);
      }

      if (options.path) {
        const { writeFileSync } = await import("fs");
        writeFileSync(options.path, buffer);
      }
      return buffer;
    }

    // Chromium: use native CDP screenshot
    const params: Record<string, unknown> = {
      format: options.format ?? "png",
    };
    if (options.format === "jpeg" && options.quality) {
      params.quality = options.quality;
    }
    if (options.fullPage) {
      const metrics = (await this.cdp.send("Page.getLayoutMetrics")) as {
        contentSize: { width: number; height: number };
      };
      params.clip = {
        x: 0,
        y: 0,
        width: metrics.contentSize.width,
        height: metrics.contentSize.height,
        scale: 1,
      };
      params.captureBeyondViewport = true;
    }

    const result = (await this.cdp.send(
      "Page.captureScreenshot",
      params,
    )) as { data: string };

    const buffer = Buffer.from(result.data, "base64");

    if (options.path) {
      const { writeFileSync } = await import("fs");
      writeFileSync(options.path, buffer);
    }

    return buffer;
  }

  // --- Element queries ---

  async querySelector(selector: string): Promise<string | null> {
    const result = (await this.cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const tag = el.tagName.toLowerCase();
        const id = el.id ? '#' + el.id : '';
        const cls = el.className ? '.' + el.className.split(' ').join('.') : '';
        const text = el.textContent?.slice(0, 100) ?? '';
        return \`<\${tag}\${id}\${cls}> \${text.trim()}\`;
      })()`,
      returnByValue: true,
    })) as { result: { value: string | null } };
    return result.result.value;
  }

  async querySelectorAll(selector: string): Promise<string[]> {
    const result = (await this.cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const els = document.querySelectorAll(${JSON.stringify(selector)});
        return Array.from(els).map(el => {
          const tag = el.tagName.toLowerCase();
          const id = el.id ? '#' + el.id : '';
          const cls = el.className ? '.' + el.className.split(' ').join('.') : '';
          const text = el.textContent?.slice(0, 80) ?? '';
          return \`<\${tag}\${id}\${cls}> \${text.trim()}\`;
        });
      })()`,
      returnByValue: true,
    })) as { result: { value: string[] } };
    return result.result.value;
  }

  // --- Wait ---

  async scroll(direction: "down" | "up" = "down", pixels = 500, x?: number, y?: number): Promise<void> {
    const amount = direction === "down" ? pixels : -pixels;
    const cx = x ?? 640;
    const cy = y ?? 360;
    // CDP native wheel event — smooth, respects the scrollable container under cursor
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: cx,
      y: cy,
      deltaX: 0,
      deltaY: amount,
    });
  }

  async waitForSelector(selector: string, timeout = 10000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const found = (await this.cdp.send("Runtime.evaluate", {
        expression: `!!document.querySelector(${JSON.stringify(selector)})`,
        returnByValue: true,
      })) as { result: { value: boolean } };
      if (found.result.value) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Timeout waiting for selector: ${selector}`);
  }

  async waitForNavigation(timeout = 15000): Promise<void> {
    await Promise.race([
      this.cdp.once("Page.loadEventFired"),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Navigation timeout")), timeout),
      ),
    ]);
  }

  // --- Cookies ---

  async cookies(): Promise<
    Array<{ name: string; value: string; domain: string; path: string }>
  > {
    const result = (await this.cdp.send("Network.getCookies")) as {
      cookies: Array<{
        name: string;
        value: string;
        domain: string;
        path: string;
      }>;
    };
    return result.cookies;
  }

  async setCookie(cookie: {
    name: string;
    value: string;
    domain?: string;
    path?: string;
    url?: string;
  }): Promise<void> {
    await this.cdp.send("Network.setCookie", {
      ...cookie,
      url: cookie.url ?? (await this.url()),
    });
  }

  async clearCookies(): Promise<void> {
    await this.cdp.send("Network.clearBrowserCookies");
  }

  // --- Network Interception ---

  private interceptEnabled = false;
  private blockPatterns: string[] = [];
  private mockRules: Array<{ pattern: string; status: number; body: string; headers?: Record<string, string> }> = [];
  private capturedRequests: Array<{ url: string; method: string; status?: number; body?: string; ts: number }> = [];

  async enableIntercept(options?: { block?: string[]; mock?: Array<{ pattern: string; status?: number; body: string }> }): Promise<void> {
    if (options?.block) this.blockPatterns.push(...options.block);
    if (options?.mock) {
      for (const m of options.mock) {
        this.mockRules.push({ pattern: m.pattern, status: m.status || 200, body: m.body });
      }
    }

    if (!this.interceptEnabled) {
      this.interceptEnabled = true;
      await this.cdp.send("Fetch.enable", {
        patterns: [{ urlPattern: "*", requestStage: "Request" }],
      });

      this.cdp.on("Fetch.requestPaused", async (params: any) => {
        const url = params.request.url as string;

        // Check blocks
        for (const pattern of this.blockPatterns) {
          if (url.includes(pattern) || new RegExp(pattern.replace(/\*/g, '.*')).test(url)) {
            await this.cdp.send("Fetch.failRequest", { requestId: params.requestId, reason: "BlockedByClient" }).catch(() => {});
            return;
          }
        }

        // Check mocks
        for (const mock of this.mockRules) {
          if (url.includes(mock.pattern) || new RegExp(mock.pattern.replace(/\*/g, '.*')).test(url)) {
            const body = Buffer.from(mock.body).toString("base64");
            await this.cdp.send("Fetch.fulfillRequest", {
              requestId: params.requestId,
              responseCode: mock.status,
              responseHeaders: [{ name: "Content-Type", value: "application/json" }],
              body,
            }).catch(() => {});
            return;
          }
        }

        // Capture XHR/fetch responses for extraction
        if (url.includes('/api/') || url.includes('/graphql')) {
          this.capturedRequests.push({ url, method: params.request.method, ts: Date.now() });
          if (this.capturedRequests.length > 200) this.capturedRequests.shift();
        }

        // Continue normally
        await this.cdp.send("Fetch.continueRequest", { requestId: params.requestId }).catch(() => {});
      });
    }
  }

  getCapturedRequests(): typeof this.capturedRequests {
    return this.capturedRequests.splice(0);
  }

  async setViewport(width: number, height: number): Promise<void> {
    this.viewport = { width, height };
    await this.cdp.send("Emulation.setDeviceMetricsOverride", {
      width, height,
      deviceScaleFactor: 1,
      mobile: width < 768,
    });
  }

  /** Get full auth state: cookies + localStorage + sessionStorage */
  async getAuthState(): Promise<{
    url: string;
    cookies: Array<Record<string, unknown>>;
    localStorage: Record<string, string>;
    sessionStorage: Record<string, string>;
  }> {
    const [url, cookiesResult, storageResult] = await Promise.all([
      this.url(),
      this.cdp.send("Network.getAllCookies") as Promise<{ cookies: Array<Record<string, unknown>> }>,
      this.cdp.send("Runtime.evaluate", {
        expression: `({
          localStorage: Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])),
          sessionStorage: Object.fromEntries(Object.keys(sessionStorage).map(k => [k, sessionStorage.getItem(k)])),
        })`,
        returnByValue: true,
      }) as Promise<{ result: { value: { localStorage: Record<string, string>; sessionStorage: Record<string, string> } } }>,
    ]);
    return {
      url,
      cookies: cookiesResult.cookies,
      localStorage: storageResult.result.value.localStorage,
      sessionStorage: storageResult.result.value.sessionStorage,
    };
  }

  /** Restore auth state: set cookies + localStorage + sessionStorage */
  // --- DVR (compressed action log) ---

  private dvr: Array<{ ts: number; type: string; data: Record<string, unknown> }> = [];
  private dvrEnabled = false;
  private lastKnownUrl = "";
  private lastKnownTitle = "";

  enableDVR(): void {
    if (this.dvrEnabled) return;
    this.dvrEnabled = true;
  }

  logDVR(type: string, data: Record<string, unknown>): void {
    if (!this.dvrEnabled) return;
    // Enrich with page context — URL comes from goto(), title updated lazily
    if (type === "goto" && data.url) this.lastKnownUrl = data.url as string;
    const enriched = { ...data, pageUrl: this.lastKnownUrl };
    this.dvr.push({ ts: Date.now(), type, data: enriched });
    if (this.dvr.length > 2000) this.dvr.shift();
    // Update title lazily (non-blocking)
    this.cdp.send("Runtime.evaluate", { expression: "document.title", returnByValue: true })
      .then((r: any) => { if (r?.result?.value) this.lastKnownTitle = r.result.value; })
      .catch(() => {});
    // Auto-snapshot on navigations and interactions (fire-and-forget)
    if (type === "goto" || type === "tapRef" || type === "clickAt") {
      // Delay slightly so the page has time to react
      setTimeout(() => { this.takeDomSnapshot().catch(() => {}); }, 500);
    }
  }

  getDVR(since?: number): typeof this.dvr {
    if (since) return this.dvr.filter(e => e.ts >= since);
    return [...this.dvr];
  }

  // --- DOM Snapshots (structural fingerprinting) ---

  private domSnapshots: Array<{ ts: number; url: string; snapshot: unknown }> = [];

  async takeDomSnapshot(): Promise<unknown> {
    const result = (await this.cdp.send("Runtime.evaluate", {
      expression: `(() => {
        var MAX = 500;
        var elements = [];
        var interactiveCount = 0;
        var textLength = 0;
        var count = 0;
        var interactiveTags = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA']);
        var interactiveRoles = new Set(['button','link','textbox','checkbox','radio','combobox','searchbox','menuitem','tab','switch']);

        function walk(node, depth) {
          if (count >= MAX) return;
          if (node.nodeType !== 1) return;
          var el = node;
          var tag = el.tagName.toLowerCase();
          if (tag === 'script' || tag === 'style' || tag === 'noscript') return;
          var id = el.id || '';
          var classes = el.className && typeof el.className === 'string' ? el.className.trim() : '';
          var role = el.getAttribute('role') || '';
          var visible = true;
          try {
            var cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') visible = false;
          } catch(e) { visible = false; }
          var text = '';
          for (var i = 0; i < el.childNodes.length; i++) {
            if (el.childNodes[i].nodeType === 3) text += el.childNodes[i].textContent || '';
          }
          text = text.trim().slice(0, 100);
          if (visible && text.length > 0) textLength += text.length;
          var isInteractive = interactiveTags.has(el.tagName) || interactiveRoles.has(role) || el.getAttribute('contenteditable') === 'true' || el.hasAttribute('onclick');
          if (isInteractive && visible) interactiveCount++;
          elements.push({ tag: tag, id: id, classes: classes, text: text, depth: depth, childCount: el.children.length, role: role, visible: visible });
          count++;
          for (var c = 0; c < el.children.length; c++) {
            walk(el.children[c], depth + 1);
          }
        }
        walk(document.body || document.documentElement, 0);

        var hashVal = 0;
        for (var i = 0; i < elements.length; i++) {
          var e = elements[i];
          var s = e.tag + ':' + e.id + ':' + e.depth + ':' + e.childCount;
          for (var j = 0; j < s.length; j++) {
            hashVal = ((hashVal << 5) - hashVal + s.charCodeAt(j)) | 0;
          }
        }

        return {
          url: window.location.href,
          title: document.title,
          ts: Date.now(),
          elements: elements,
          interactiveCount: interactiveCount,
          textLength: textLength,
          hash: 'dom-' + Math.abs(hashVal).toString(36)
        };
      })()`,
      returnByValue: true,
    })) as { result: { value: any } };

    const snapshot = result.result.value;
    this.domSnapshots.push({ ts: snapshot.ts, url: snapshot.url, snapshot });
    if (this.domSnapshots.length > 20) this.domSnapshots.shift();
    return snapshot;
  }

  diffDomSnapshots(since?: number): { added: object[]; removed: object[]; changed: object[]; summary: string } {
    if (this.domSnapshots.length < 2) {
      return { added: [], removed: [], changed: [], summary: "Not enough snapshots to diff (need at least 2)" };
    }

    const latest = this.domSnapshots[this.domSnapshots.length - 1].snapshot as any;
    let baseline: any;

    if (since) {
      // Find the snapshot closest to the `since` timestamp
      let closest = this.domSnapshots[0];
      let closestDist = Math.abs(closest.ts - since);
      for (const s of this.domSnapshots) {
        const dist = Math.abs(s.ts - since);
        if (dist < closestDist) { closest = s; closestDist = dist; }
      }
      baseline = closest.snapshot;
    } else {
      baseline = this.domSnapshots[this.domSnapshots.length - 2].snapshot;
    }

    const oldEls: any[] = baseline.elements || [];
    const newEls: any[] = latest.elements || [];

    // Build fingerprint maps keyed by tag+id+depth
    function fingerprint(el: any): string {
      return `${el.tag}|${el.id}|${el.depth}`;
    }
    function contentKey(el: any): string {
      return `${el.tag}|${el.id}|${el.depth}|${el.classes}|${el.text}|${el.childCount}|${el.role}|${el.visible}`;
    }

    // Build multi-maps (same fingerprint can appear multiple times)
    const oldMap = new Map<string, any[]>();
    for (const el of oldEls) {
      const fp = fingerprint(el);
      if (!oldMap.has(fp)) oldMap.set(fp, []);
      oldMap.get(fp)!.push(el);
    }
    const newMap = new Map<string, any[]>();
    for (const el of newEls) {
      const fp = fingerprint(el);
      if (!newMap.has(fp)) newMap.set(fp, []);
      newMap.get(fp)!.push(el);
    }

    const added: object[] = [];
    const removed: object[] = [];
    const changed: object[] = [];

    // Track consumed old elements
    const oldConsumed = new Map<string, number>(); // fp -> count consumed

    for (const [fp, newList] of newMap) {
      const oldList = oldMap.get(fp) || [];
      const consumed = oldConsumed.get(fp) || 0;
      for (let i = 0; i < newList.length; i++) {
        const newEl = newList[i];
        if (i < oldList.length) {
          // Matched — check for content changes
          const oldEl = oldList[i];
          if (contentKey(oldEl) !== contentKey(newEl)) {
            const changes: Record<string, { from: any; to: any }> = {};
            if (oldEl.text !== newEl.text) changes.text = { from: oldEl.text, to: newEl.text };
            if (oldEl.classes !== newEl.classes) changes.classes = { from: oldEl.classes, to: newEl.classes };
            if (oldEl.childCount !== newEl.childCount) changes.childCount = { from: oldEl.childCount, to: newEl.childCount };
            if (oldEl.visible !== newEl.visible) changes.visible = { from: oldEl.visible, to: newEl.visible };
            if (oldEl.role !== newEl.role) changes.role = { from: oldEl.role, to: newEl.role };
            changed.push({ tag: newEl.tag, id: newEl.id, depth: newEl.depth, changes });
          }
        } else {
          // New element
          added.push(newEl);
        }
      }
      oldConsumed.set(fp, newList.length);
    }

    // Find removed elements (in old but not matched by new)
    for (const [fp, oldList] of oldMap) {
      const newList = newMap.get(fp) || [];
      for (let i = newList.length; i < oldList.length; i++) {
        removed.push(oldList[i]);
      }
    }

    // Build summary
    function elLabel(el: any): string {
      let label = el.tag;
      if (el.id) label += '#' + el.id;
      else if (el.classes) label += '.' + el.classes.split(/\s+/)[0];
      return label;
    }

    const parts: string[] = [];
    if (added.length > 0) {
      const labels = added.slice(0, 5).map(elLabel);
      parts.push(`+${added.length} elements added (${labels.join(', ')}${added.length > 5 ? ', ...' : ''})`);
    }
    if (removed.length > 0) {
      const labels = removed.slice(0, 5).map(elLabel);
      parts.push(`-${removed.length} elements removed (${labels.join(', ')}${removed.length > 5 ? ', ...' : ''})`);
    }
    if (changed.length > 0) {
      const labels = changed.slice(0, 5).map((c: any) => {
        let label = elLabel(c);
        const textChange = c.changes?.text;
        if (textChange) label += `: "${textChange.from}" -> "${textChange.to}"`;
        return label;
      });
      parts.push(`~${changed.length} elements changed (${labels.join(', ')}${changed.length > 5 ? ', ...' : ''})`);
    }
    if (parts.length === 0) parts.push("No structural changes detected");

    return { added, removed, changed, summary: parts.join('\n  ') };
  }

  /** Persistent event buffer — always collecting once enabled */
  private eventBuffer: Array<{ type: string; data: Record<string, unknown>; ts: number }> = [];
  private eventsEnabled = false;

  /** Enable event collection (idempotent) */
  async enableEvents(): Promise<void> {
    if (this.eventsEnabled) return;
    this.eventsEnabled = true;
    await this.cdp.send("Log.enable").catch(() => {});

    this.cdp.on("Runtime.consoleAPICalled", (params: any) => {
      this.eventBuffer.push({ type: "console", data: { level: params.type, text: params.args?.map((a: any) => a.value ?? a.description ?? "").join(" ") }, ts: Date.now() });
      if (this.eventBuffer.length > 500) this.eventBuffer.shift();
    });

    this.cdp.on("Page.frameNavigated", (params: any) => {
      this.eventBuffer.push({ type: "navigation", data: { url: params.frame?.url }, ts: Date.now() });
    });

    this.cdp.on("Network.responseReceived", (params: any) => {
      const status = params.response?.status;
      if (status >= 400) {
        this.eventBuffer.push({ type: "network_error", data: { url: params.response?.url, status }, ts: Date.now() });
      }
    });

    this.cdp.on("Runtime.exceptionThrown", (params: any) => {
      this.eventBuffer.push({ type: "error", data: { text: params.exceptionDetails?.text || "Unknown error" }, ts: Date.now() });
    });
  }

  /** Drain buffered events */
  getEvents(): Array<{ type: string; data: Record<string, unknown>; ts: number }> {
    const events = this.eventBuffer.splice(0);
    return events;
  }

  async setAuthState(state: {
    cookies: Array<Record<string, unknown>>;
    localStorage?: Record<string, string>;
    sessionStorage?: Record<string, string>;
  }): Promise<void> {
    // Set cookies
    for (const cookie of state.cookies) {
      await this.cdp.send("Network.setCookie", cookie).catch(() => {});
    }
    // Set storage
    if (state.localStorage || state.sessionStorage) {
      const ls = JSON.stringify(state.localStorage || {});
      const ss = JSON.stringify(state.sessionStorage || {});
      await this.cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const ls = ${ls};
          const ss = ${ss};
          for (const [k,v] of Object.entries(ls)) localStorage.setItem(k, v);
          for (const [k,v] of Object.entries(ss)) sessionStorage.setItem(k, v);
        })()`,
      });
    }
  }

  // --- Screencast (push-based frame streaming) ---

  async startScreencast(opts?: { quality?: number; maxWidth?: number; maxHeight?: number }): Promise<void> {
    if (this.screencastActive) return;
    this.screencastActive = true;

    this.cdp.on("Page.screencastFrame", (params) => {
      this.screencastFrame = { base64: params.data as string, ts: Date.now() };
      // Ack immediately to keep frames flowing
      this.cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
      this.onScreencastFrame?.(params.data as string);
    });

    await this.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: opts?.quality ?? 60,
      maxWidth: opts?.maxWidth ?? 1920,
      maxHeight: opts?.maxHeight ?? 1080,
      everyNthFrame: 1,
    });
  }

  async stopScreencast(): Promise<void> {
    if (!this.screencastActive) return;
    this.screencastActive = false;
    this.onScreencastFrame = null;
    await this.cdp.send("Page.stopScreencast").catch(() => {});
  }

  /** Get the latest cached screencast frame (instant, no new capture) */
  getLatestFrame(): { base64: string; ts: number } | null {
    return this.screencastFrame;
  }

  /** Subscribe to screencast frame updates */
  setFrameListener(cb: ((base64: string) => void) | null): void {
    this.onScreencastFrame = cb;
  }

  // --- Cleanup ---

  async close(): Promise<void> {
    await this.stopScreencast();
    await this.cdp.close();
  }
}
