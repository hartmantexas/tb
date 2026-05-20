import { CDPClient } from "./cdp.js";
import type { EngineType } from "./engines/types.js";
import { existsSync } from "fs";
import { join } from "path";

/**
 * Render HTML to PNG using Blitz (Rust-based renderer with Firefox's Stylo CSS engine).
 * Falls back to Takumi if Blitz binary isn't available.
 */
async function renderHTML(html: string, width = 1280, height = 720): Promise<Buffer> {
  // Try Blitz first (full CSS rendering)
  const blitzPath = join(new URL(".", import.meta.url).pathname, "..", "render-engine", "target", "release", "tb-render");

  if (existsSync(blitzPath)) {
    try {
      const proc = Bun.spawn([blitzPath, String(width), String(height)], {
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
  constructor(
    private cdp: CDPClient,
    private engineType: "lightpanda" | "chromium",
  ) {}

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

  // --- Navigation ---

  async goto(url: string): Promise<{ status: number; url: string }> {
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

      const buffer = await renderHTML(fullHTML, options.width ?? 1280, options.height ?? 720);

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

  async scroll(direction: "down" | "up" = "down", pixels = 500): Promise<void> {
    const amount = direction === "down" ? pixels : -pixels;
    await this.cdp.send("Runtime.evaluate", {
      expression: `window.scrollBy(0, ${amount})`,
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

  // --- Cleanup ---

  async close(): Promise<void> {
    await this.cdp.close();
  }
}
