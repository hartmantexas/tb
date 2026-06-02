/**
 * tb watch / tb cc — live session viewers.
 * Standalone app windows. Streams frames via CDP screencast.
 */

import { ensureDaemon, daemonFetch } from "./daemon.js";
import { loadConfig } from "./config.js";
import { exec } from "child_process";
import { existsSync } from "fs";

interface SessionInfo { id: string; name?: string; group?: string; engine: string; createdAt: string; lastUsedAt: string; }

async function sessionCmd(sid: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return ((await daemonFetch("/session/command", { method: "POST", body: { sessionId: sid, method, params } })) as { result: unknown }).result;
}

async function getSessions(): Promise<SessionInfo[]> {
  return ((await daemonFetch("/status")) as { sessions: SessionInfo[] }).sessions;
}

function openAppWindow(url: string): void {
  const browsers = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Arc.app/Contents/MacOS/Arc",
  ];
  const browser = browsers.find(b => existsSync(b));
  if (browser) exec(`"${browser}" --app="${url}"`);
  else exec(`open "${url}"`);
}

const config = loadConfig();
const screencastStarted = new Set<string>();

// ─── API ─────────────────────────────────────────────────────────────────────

async function handleAPI(req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;

  if (path === "/api/sessions") return Response.json(await getSessions());

  if (path === "/api/frame") {
    const sid = url.searchParams.get("session");
    const quality = parseInt(url.searchParams.get("quality") || "55");
    if (!sid) return Response.json({ error: "need session" }, { status: 400 });
    const [ss, pageUrl, title, vp] = await Promise.all([
      sessionCmd(sid, "screenshot", { format: "jpeg", quality }),
      sessionCmd(sid, "url"),
      sessionCmd(sid, "title"),
      sessionCmd(sid, "evaluate", { expression: "({w:window.innerWidth,h:window.innerHeight})" }),
    ]);
    const dims = (vp as any) || { w: config.viewport.width, h: config.viewport.height };
    return Response.json({
      base64: (ss as any).base64,
      url: pageUrl, title,
      w: dims.w, h: dims.h,
    });
  }

  // SSE screencast — push frames in real-time instead of polling
  if (path === "/api/screencast") {
    const sid = url.searchParams.get("session");
    const quality = parseInt(url.searchParams.get("quality") || "70");
    if (!sid) return Response.json({ error: "need session" }, { status: 400 });

    // Start screencast if not already started
    if (!screencastStarted.has(sid)) {
      screencastStarted.add(sid);
      await sessionCmd(sid, "startScreencast", { quality, maxWidth: config.viewport.width, maxHeight: config.viewport.height });
    }

    let alive = true;
    const stream = new ReadableStream({
      start(controller) {
        const send = (data: string) => {
          try { controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`)); } catch {}
        };

        const tick = async () => {
          if (!alive) return;
          try {
            const [cached, pageUrl, title] = await Promise.all([
              sessionCmd(sid, "getLatestFrame"),
              sessionCmd(sid, "url"),
              sessionCmd(sid, "title"),
            ]);
            const frame = cached as { base64: string; ts: number } | null;
            if (frame?.base64) {
              send(JSON.stringify({ base64: frame.base64, url: pageUrl, title, w: config.viewport.width, h: config.viewport.height }));
            }
          } catch {}
          if (alive) setTimeout(tick, 33);
        };
        tick();
      },
      cancel() {
        alive = false;
      },
    });

    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
    });
  }

  // Real input — forward mouse/keyboard via CDP (not JS .click())
  if (path === "/api/input" && req.method === "POST") {
    const body = (await req.json()) as { sessionId: string; type: string; params: Record<string, unknown> };
    const { sessionId: sid, type, params } = body;
    if (type === "mousedown") {
      await sessionCmd(sid, "realClick", { x: params.x, y: params.y });
    } else if (type === "scroll") {
      await sessionCmd(sid, "scroll", params);
    } else if (type === "keydown") {
      await sessionCmd(sid, "keyPress", params);
    } else if (type === "type") {
      await sessionCmd(sid, "typeText", params);
    }
    return Response.json({ ok: true });
  }

  if (path === "/api/cmd" && req.method === "POST") {
    const body = (await req.json()) as { sessionId: string; method: string; params: Record<string, unknown> };
    return Response.json({ result: await sessionCmd(body.sessionId, body.method, body.params) });
  }

  if (path === "/api/viewport" && req.method === "POST") {
    const body = (await req.json()) as { sessionId: string; width: number; height: number };
    // Use Emulation.setDeviceMetricsOverride via the session
    await sessionCmd(body.sessionId, "evaluate", { expression: `window.__tbViewport={w:${body.width},h:${body.height}}` });
    // The real viewport change needs CDP Emulation domain — send via daemon
    try {
      await daemonFetch("/session/command", { method: "POST", body: { sessionId: body.sessionId, method: "setViewport", params: { width: body.width, height: body.height } } });
    } catch {}
    return Response.json({ ok: true });
  }

  if (path === "/api/close" && req.method === "POST") {
    const body = (await req.json()) as { sessionId: string };
    await daemonFetch(`/session/${body.sessionId}`, { method: "DELETE" });
    return Response.json({ ok: true });
  }

  if (path === "/api/rename" && req.method === "POST") {
    const body = (await req.json()) as { sessionId: string; name: string };
    await daemonFetch(`/session/${body.sessionId}`, { method: "PATCH", body: { name: body.name } });
    return Response.json({ ok: true });
  }

  if (path === "/api/recording" && req.method === "POST") {
    const body = (await req.json()) as { name: string; actions: unknown[] };
    const { writeFileSync, mkdirSync, existsSync } = await import("fs");
    const { join } = await import("path");
    const { homedir } = await import("os");
    const filePath = join(homedir(), ".tb", "recordings", `${body.name}.json`);
    const fileDir = filePath.substring(0, filePath.lastIndexOf("/"));
    if (!existsSync(fileDir)) mkdirSync(fileDir, { recursive: true });
    writeFileSync(filePath, JSON.stringify({ name: body.name, recordedAt: new Date().toISOString(), actions: body.actions }, null, 2));
    return Response.json({ ok: true });
  }

  if (path === "/api/recording" && req.method === "GET") {
    const name = url.searchParams.get("name");
    if (!name) return Response.json({ error: "need name" }, { status: 400 });
    const { readFileSync, existsSync } = await import("fs");
    const { join } = await import("path");
    const { homedir } = await import("os");
    const p = join(homedir(), ".tb", "recordings", `${name}.json`);
    if (!existsSync(p)) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(JSON.parse(readFileSync(p, "utf-8")));
  }

  if (path === "/api/recording" && req.method === "DELETE") {
    const name = url.searchParams.get("name");
    if (!name) return Response.json({ error: "need name" }, { status: 400 });
    const { unlinkSync, existsSync } = await import("fs");
    const { join } = await import("path");
    const { homedir } = await import("os");
    const p = join(homedir(), ".tb", "recordings", `${name}.json`);
    if (existsSync(p)) unlinkSync(p);
    return Response.json({ ok: true });
  }

  if (path === "/api/recordings" && req.method === "GET") {
    const { readdirSync, existsSync, statSync } = await import("fs");
    const { join } = await import("path");
    const { homedir } = await import("os");
    const dir = join(homedir(), ".tb", "recordings");
    const results: string[] = [];
    function walk(d: string, prefix: string) {
      if (!existsSync(d)) return;
      for (const f of readdirSync(d)) {
        const full = join(d, f);
        if (statSync(full).isDirectory()) walk(full, prefix ? prefix + "/" + f : f);
        else if (f.endsWith(".json")) results.push(prefix ? prefix + "/" + f.replace(".json", "") : f.replace(".json", ""));
      }
    }
    walk(dir, "");
    return Response.json(results);
  }

  if (path === "/api/move" && req.method === "POST") {
    const body = (await req.json()) as { sessionId: string; group: string };
    await daemonFetch(`/session/${body.sessionId}`, { method: "PATCH", body: { group: body.group } });
    return Response.json({ ok: true });
  }

  if (path === "/api/new" && req.method === "POST") {
    const body = (await req.json()) as { url?: string; group?: string };
    const result = (await daemonFetch("/session/create", {
      method: "POST",
      body: { engine: "chromium" },
    })) as { sessionId: string };
    if (body.url) await sessionCmd(result.sessionId, "goto", { url: body.url });
    // Auto-assign to group if specified
    if (body.group) {
      await daemonFetch(`/session/${result.sessionId}`, { method: "PATCH", body: { group: body.group } });
    }
    return Response.json(result);
  }

  return null;
}

// ─── Watch HTML ──────────────────────────────────────────────────────────────

function watchHTML(sid: string, name: string, firstFrame?: string, firstUrl?: string, groupFilter?: string): string {
  const pre = firstFrame ? `data:image/jpeg;base64,${firstFrame}` : '';
  const windowTitle = groupFilter ? `tb — ${groupFilter}` : `tb — ${name}`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${windowTitle}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d0d0d;font-family:-apple-system,BlinkMacSystemFont,sans-serif;overflow:hidden;height:100vh;display:flex;flex-direction:column}
#tabs{height:30px;background:#0f0f0f;display:flex;align-items:stretch;padding:4px 4px 0;gap:2px;flex-shrink:0;overflow-x:auto}
.tab{height:26px;background:#1a1a1a;border:1px solid #252525;border-bottom:none;border-radius:6px 6px 0 0;color:#777;font-size:10px;padding:0 12px;cursor:pointer;display:flex;align-items:center;gap:5px;white-space:nowrap;max-width:180px;flex-shrink:0}
.tab:hover{background:#222;color:#aaa}
.tab.active{background:#161616;color:#fff;border-color:#333}
.tab .td{width:4px;height:4px;border-radius:50%;background:#34a853;flex-shrink:0}
.tab .tl{overflow:hidden;text-overflow:ellipsis}
.tab-new{height:26px;background:none;border:1px solid #252525;border-bottom:none;border-radius:6px 6px 0 0;color:#555;font-size:14px;padding:0 10px;cursor:pointer;flex-shrink:0}
.tab-new:hover{background:#1a1a1a;color:#aaa}
#bar{height:34px;background:#161616;border-bottom:1px solid #252525;display:flex;align-items:center;padding:0 8px;gap:4px;flex-shrink:0}
.b{width:26px;height:26px;background:none;border:none;border-radius:5px;color:#666;font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center}
.b:hover{background:#222;color:#ccc}
#url{flex:1;height:24px;background:#1c1c1c;border:1px solid #2a2a2a;border-radius:5px;color:#999;font-size:11px;padding:0 8px;outline:none;font-family:'SF Mono',Menlo,monospace;min-width:0}
#url:focus{border-color:#4285f4;color:#fff}
.dot{width:6px;height:6px;border-radius:50%;background:#34a853;flex-shrink:0;margin:0 4px}
.dot.x{background:#e8b931}
#vp{flex:1;position:relative;overflow:hidden;background:#080808;display:flex;align-items:center;justify-content:center}
#s{display:block;max-width:100%;max-height:100%;object-fit:contain;-webkit-user-drag:none;user-select:none}
#bm{height:24px;background:#111;border-bottom:1px solid #1e1e1e;display:flex;align-items:center;padding:0 8px;gap:2px;flex-shrink:0;overflow-x:auto}
.bk{height:18px;background:none;border:none;color:#888;font-size:10px;padding:0 8px;cursor:pointer;border-radius:3px;white-space:nowrap;display:flex;align-items:center;gap:4px}
.bk:hover{background:#1e1e1e;color:#ccc}
.bk.add{color:#555;font-size:12px}
.tab .tx,.tab .te{display:none;margin-left:2px;font-size:9px;color:#555;cursor:pointer;padding:0 2px;border-radius:2px}
.tab .tx:hover,.tab .te:hover{color:#fff;background:#333}
.tab:hover .tx,.tab:hover .te{display:inline}
.tab.drag-over{border-left:2px solid #4285f4}
#tip{position:fixed;background:#1a1a1a;border:1px solid #333;border-radius:5px;padding:4px 8px;font-size:9px;color:#aaa;pointer-events:none;opacity:0;transition:opacity .15s;z-index:300;white-space:nowrap;font-family:'SF Mono',Menlo,monospace}
#tip.show{opacity:1;pointer-events:auto}
.trow{display:flex;align-items:center;gap:6px;line-height:16px}
.tlbl{color:#555;font-size:8px;text-transform:uppercase;width:28px;flex-shrink:0}
.tid{color:#999;cursor:pointer}.tid:hover{color:#4285f4}
.tsep{height:1px;background:#2a2a2a;margin:3px 0}
.tcmd{color:#666;cursor:pointer;padding:2px 0;font-size:9px;display:flex;align-items:center}
.tcmd:hover{color:#ccc}
.tdesc{color:#444;font-size:8px;width:110px;flex-shrink:0;font-family:-apple-system,sans-serif}
.tcmd:hover .tdesc{color:#777}
#vp{position:relative}
#overlay{position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;display:none}
#overlay.on{display:block}
.badge{position:absolute;background:rgba(66,133,244,.85);color:#fff;font-size:8px;font-weight:700;font-family:'SF Mono',monospace;
  min-width:14px;height:14px;line-height:14px;text-align:center;border-radius:7px;padding:0 2px;
  cursor:pointer;pointer-events:auto;box-shadow:0 1px 3px rgba(0,0,0,.4);transform:translate(-4px,-4px);z-index:10;transition:transform .1s}
.badge:hover{background:#fff;color:#4285f4;transform:translate(-4px,-4px) scale(1.3)}
.badge.input{background:rgba(232,185,49,.85)}
.badge.button{background:rgba(52,168,83,.85)}
#cmd{height:28px;background:#111;border-top:1px solid #1e1e1e;display:none;align-items:center;padding:0 8px;gap:6px;flex-shrink:0}
#cmd.on{display:flex}
#cmd-label{font-size:9px;color:#555;flex-shrink:0}
#cmd-input{flex:1;height:20px;background:#1a1a1a;border:1px solid #252525;border-radius:4px;color:#ccc;font-size:10px;padding:0 6px;outline:none;font-family:'SF Mono',Menlo,monospace}
#cmd-input:focus{border-color:#4285f4}
#cmd-input::placeholder{color:#444}
.b.active{color:#4285f4}
.b.rec{color:#ea4335;animation:recpulse 1s infinite}
@keyframes recpulse{50%{opacity:.4}}
#recbar{height:24px;background:#1a0000;border-top:1px solid #331111;display:none;align-items:center;padding:0 8px;gap:6px;flex-shrink:0;font-size:10px;color:#ea4335}
#recbar.on{display:flex}
#recbar .rdot{width:6px;height:6px;border-radius:50%;background:#ea4335;animation:recpulse 1s infinite}
#save-dialog{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#1a1a1a;border:1px solid #333;border-radius:10px;padding:16px 20px;z-index:500;display:none;width:300px;box-shadow:0 8px 32px rgba(0,0,0,.6)}
#save-dialog.show{display:block}
#save-dialog h3{font-size:12px;color:#fff;margin-bottom:10px;font-weight:600}
#save-dialog input,#save-dialog select{width:100%;height:28px;background:#111;border:1px solid #2a2a2a;border-radius:5px;color:#ccc;font-size:11px;padding:0 8px;outline:none;margin-bottom:8px;font-family:'SF Mono',Menlo,monospace}
#save-dialog input:focus,#save-dialog select:focus{border-color:#4285f4}
#save-dialog .sd-row{display:flex;gap:8px;margin-top:4px}
#save-dialog .sd-btn{flex:1;height:28px;border:none;border-radius:5px;font-size:11px;cursor:pointer}
#save-dialog .sd-save{background:#4285f4;color:#fff}
#save-dialog .sd-save:hover{background:#5a95f5}
#save-dialog .sd-cancel{background:#222;color:#888;border:1px solid #333}
#save-dialog .sd-cancel:hover{color:#ccc}
#save-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:499;display:none}
#save-overlay.show{display:block}
#replay-list{position:fixed;background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:4px 0;z-index:400;display:none;min-width:160px;box-shadow:0 4px 16px rgba(0,0,0,.5);max-height:300px;overflow-y:auto}
#replay-list.show{display:block}
#replay-list .rl-item{padding:5px 12px;font-size:10px;color:#ccc;cursor:pointer;display:flex;align-items:center;gap:6px}
#replay-list .rl-item:hover{background:#252525;color:#fff}
#replay-list .rl-item .rl-icon{color:#34a853;font-size:8px}
#replay-list .rl-item .rl-del{margin-left:auto;color:#444;font-size:9px;cursor:pointer;padding:0 2px}
#replay-list .rl-item .rl-del:hover{color:#ea4335}
#replay-list .rl-empty{padding:8px 12px;font-size:10px;color:#555}
#replay-list .rl-title{padding:4px 12px;font-size:8px;color:#555;text-transform:uppercase;letter-spacing:.5px}
#console{height:0;background:#0e0e0e;border-top:1px solid #1e1e1e;overflow-y:auto;flex-shrink:0;font-family:'SF Mono',Menlo,monospace;font-size:10px;transition:height .15s}
#console.on{height:140px}
#console .cline{padding:2px 8px;border-bottom:1px solid #141414;display:flex;gap:6px;align-items:flex-start;cursor:pointer;position:relative}
#console .cline:hover{background:#151515}
#console .cline.error{color:#ea4335;background:#1a0000}
#console .cline.error:hover{background:#1f0000}
#console .cline.warn{color:#e8b931}
#console .cline.info{color:#8ab4f8}
#console .cline.nav{color:#34a853}
#console .cline.net{color:#ea4335;background:#1a0000}
#console .cts{color:#333;flex-shrink:0;width:50px;font-size:9px;line-height:16px}
#console .ctx{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:16px;min-width:0}
#console .cline.expanded .ctx{white-space:pre-wrap;word-break:break-word;overflow:visible;max-height:none}
#console .ccopy{display:none;flex-shrink:0;color:#444;font-size:8px;padding:1px 5px;border:1px solid #2a2a2a;border-radius:3px;cursor:pointer;line-height:14px}
#console .cline:hover .ccopy{display:block}
#console .ccopy:hover{color:#4285f4;border-color:#4285f4}
</style></head><body>
<div id="tabs"></div>
<div id="bar">
 <button class="b" onclick="nav('back')">&#8592;</button>
 <button class="b" onclick="nav('forward')">&#8594;</button>
 <button class="b" onclick="nav('reload')">&#8635;</button>
 <input id="url" type="text" spellcheck="false" value="${firstUrl || ''}">
 <button class="b" id="btn-els" onclick="toggleEls()" title="Show elements"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg></button>
 <button class="b" id="btn-cmd" onclick="toggleCmd()" title="Command bar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg></button>
 <button class="b" id="btn-con" onclick="toggleConsole()" title="Console"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="18" rx="2"/><line x1="6" y1="9" x2="6" y2="9"/><line x1="10" y1="9" x2="18" y2="9"/><line x1="6" y1="13" x2="6" y2="13"/><line x1="10" y1="13" x2="18" y2="13"/></svg></button>
 <button class="b" id="btn-rec" onclick="toggleRec()" title="Record"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4" fill="currentColor"/></svg></button>
 <button class="b" id="btn-play" onclick="showReplayList()" title="Replay"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5,3 19,12 5,21"/></svg></button>
 <button class="b" id="btn-vp" onclick="cycleViewport()" title="Viewport"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18"/></svg></button>
 <button class="b" onclick="ss()" title="Screenshot"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg></button>
 <div class="dot" id="dot"></div>
</div>
<div id="bm"></div>
<div id="vp">
  <img id="s" src="${pre}" draggable="false">
  <div id="overlay"></div>
</div>
<div id="cmd">
  <span id="cmd-label">&gt;</span>
  <input id="cmd-input" type="text" placeholder="tap 3 ; type hello ; tap 5 — chain with ;" spellcheck="false">
</div>
<div id="recbar"><div class="rdot"></div><span id="rec-label">Recording...</span><span id="rec-count">0 actions</span></div>
<div id="save-overlay"></div>
<div id="save-dialog">
  <h3>Save Recording</h3>
  <input id="save-name" type="text" placeholder="Name (e.g. login-flow)" spellcheck="false">
  <select id="save-cat">
    <option value="">No category</option>
    <option value="auth">Auth / Login</option>
    <option value="scrape">Scrape / Extract</option>
    <option value="test">Test / QA</option>
    <option value="nav">Navigation</option>
    <option value="auto">Automation</option>
  </select>
  <div class="sd-row">
    <button class="sd-btn sd-cancel" onclick="cancelSave()">Cancel</button>
    <button class="sd-btn sd-save" onclick="confirmSave()">Save</button>
  </div>
</div>
<div id="console"></div>
<div id="tip"></div>
<div id="replay-list"></div>
<script>
const I=document.getElementById('s'),U=document.getElementById('url'),D=document.getElementById('dot'),TB=document.getElementById('tabs'),TIP=document.getElementById('tip');
let S='${sid}';
let W=${config.viewport.width},H=${config.viewport.height},busy=0,act=0;
const GROUP_FILTER=${groupFilter ? `'${groupFilter}'` : 'null'};

// Dot: click copies session name, hover shows ID in tooltip (clickable)
D.style.cursor='pointer';
D.onclick=()=>{
  const name=activeTabName();
  navigator.clipboard.writeText(name);
  // Flash "copied!" next to dot
  let lbl=document.getElementById('dotlbl');
  if(!lbl){lbl=document.createElement('span');lbl.id='dotlbl';lbl.style.cssText='font-size:9px;color:#4285f4;margin-left:4px;transition:opacity .2s';D.parentElement.insertBefore(lbl,D.nextSibling)}
  lbl.textContent='copied!';lbl.style.opacity='1';
  setTimeout(()=>{lbl.style.opacity='0';setTimeout(()=>{lbl.textContent=''},200)},600);
};
D.addEventListener('mouseenter',()=>{
  const r=D.getBoundingClientRect();
  const name=activeTabName();
  const hasName=allSessions.find(s=>s.id===S)?.name;
  const sn=hasName?name:S;
  TIP.innerHTML=(hasName?'<div class="trow"><span class="tlbl">name</span><span class="tid" data-v="'+name+'">'+name+'</span></div>':'')+
    '<div class="trow"><span class="tlbl">id</span><span class="tid" data-v="'+S+'">'+S+'</span></div>'+
    '<div class="tsep"></div>'+
    '<div class="tcmd" data-v="tb --session '+sn+' elements"><span class="tdesc">list clickable elements</span>tb elements</div>'+
    '<div class="tcmd" data-v="tb --session '+sn+' screenshot"><span class="tdesc">capture page as PNG</span>tb screenshot</div>'+
    '<div class="tcmd" data-v="tb --session '+sn+' text"><span class="tdesc">extract visible text</span>tb text</div>'+
    '<div class="tcmd" data-v="tb --session '+sn+' url"><span class="tdesc">get current URL</span>tb url</div>'+
    '<div class="tcmd" data-v="tb --session '+sn+' eval &quot;...&quot;"><span class="tdesc">run JavaScript</span>tb eval</div>'+
    '<div class="tcmd" data-v="tb --session '+sn+' tap "><span class="tdesc">click element by #</span>tb tap</div>'+
    '<div class="tcmd" data-v="tb --session '+sn+' click &quot;...&quot;"><span class="tdesc">click by CSS selector</span>tb click</div>'+
    '<div class="tsep"></div>'+
    '<div class="tcmd" data-v="tb auth save '+sn+' --session '+sn+'"><span class="tdesc">save login state</span>tb auth save</div>'+
    '<div class="tcmd" data-v="tb auth load '+sn+' --session '+sn+'"><span class="tdesc">restore login state</span>tb auth load</div>'+
    '<div class="tcmd" data-v="tb record '+sn+' --session '+sn+'"><span class="tdesc">record actions</span>tb record</div>'+
    '<div class="tcmd" data-v="tb replay '+sn+' --session '+sn+'"><span class="tdesc">replay recording</span>tb replay</div>'+
    '<div class="tcmd" data-v="tb events --session '+sn+'"><span class="tdesc">stream page events</span>tb events</div>';
  TIP.style.right=(window.innerWidth-r.right)+'px';
  TIP.style.left='auto';
  TIP.style.top=(r.bottom+6)+'px';
  TIP.className='show';
  TIP.querySelectorAll('.tid,.tcmd').forEach(el=>{
    el.onclick=()=>{navigator.clipboard.writeText(el.dataset.v);const orig=el.textContent;el.textContent='copied!';el.style.color='#4285f4';setTimeout(()=>{el.textContent=orig;el.style.color=''},500)};
  });
});
D.addEventListener('mouseleave',()=>{setTimeout(()=>{if(!TIP.matches(':hover'))TIP.className=''},200)});
TIP.addEventListener('mouseleave',()=>{TIP.className=''});

// ─── Tabs with drag reorder ───
let allSessions=[];
let tabOrder=JSON.parse(localStorage.getItem('tb-tab-order')||'[]');
let dragId=null;

function orderedSessions(){
  // Sort allSessions by tabOrder, append any new ones at the end
  const byId=Object.fromEntries(allSessions.map(s=>[s.id,s]));
  const ordered=[];
  for(const id of tabOrder){if(byId[id]){ordered.push(byId[id]);delete byId[id]}}
  for(const s of Object.values(byId))ordered.push(s);
  tabOrder=ordered.map(s=>s.id);
  return ordered;
}

function saveOrder(){localStorage.setItem('tb-tab-order',JSON.stringify(tabOrder))}

async function refreshTabs(){
  try{
    let raw=await(await fetch('/api/sessions')).json();
    allSessions=GROUP_FILTER?raw.filter(s=>s.group===GROUP_FILTER):raw;
    const sorted=orderedSessions();
    TB.innerHTML='';
    for(const s of sorted){
      const t=document.createElement('div');
      t.className='tab'+(s.id===S?' active':'');
      t.draggable=true;
      t.dataset.id=s.id;
      const label=s.name||s.id.slice(0,8);
      t.innerHTML='<div class="td"></div><span class="tl">'+label+'</span><span class="te" title="Rename">&#9998;</span><span class="tx" title="Close">&#215;</span>';

      // Drag
      t.ondragstart=(e)=>{dragId=s.id;t.style.opacity='.4';e.dataTransfer.effectAllowed='move'};
      t.ondragend=()=>{dragId=null;t.style.opacity='';document.querySelectorAll('.tab').forEach(x=>x.classList.remove('drag-over'))};
      t.ondragover=(e)=>{e.preventDefault();e.dataTransfer.dropEffect='move';t.classList.add('drag-over')};
      t.ondragleave=()=>t.classList.remove('drag-over');
      t.ondrop=(e)=>{
        e.preventDefault();t.classList.remove('drag-over');
        if(!dragId||dragId===s.id)return;
        const from=tabOrder.indexOf(dragId),to=tabOrder.indexOf(s.id);
        if(from<0||to<0)return;
        tabOrder.splice(from,1);tabOrder.splice(to,0,dragId);
        saveOrder();refreshTabs();
      };

      // Click → switch
      t.onclick=()=>switchTab(s.id);
      // Click label on active tab → copy
      t.querySelector('.tl').onclick=(e)=>{
        if(s.id===S){e.stopPropagation();navigator.clipboard.writeText(s.name||s.id);
          t.querySelector('.tl').textContent='copied!';setTimeout(()=>{t.querySelector('.tl').textContent=label},500)}
      };
      // Pencil → rename
      t.querySelector('.te').onclick=(e)=>{
        e.stopPropagation();
        const n=prompt('Rename:',s.name||'');
        if(n!==null)fetch('/api/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:s.id,name:n})}).then(()=>refreshTabs());
      };
      // X → close
      t.querySelector('.tx').onclick=async(e)=>{
        e.stopPropagation();
        await fetch('/api/close',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:s.id})}).catch(()=>{});
        tabOrder=tabOrder.filter(x=>x!==s.id);saveOrder();
        if(S===s.id){const rest=orderedSessions().filter(x=>x.id!==s.id);if(rest.length)switchTab(rest[0].id)}
        refreshTabs();
      };
      TB.appendChild(t);
    }
    const nt=document.createElement('button');
    nt.className='tab-new';nt.textContent='+';nt.title='New tab';
    nt.onclick=async()=>{
      const url=prompt('URL:','https://');if(!url)return;
      const body={url};if(GROUP_FILTER)body.group=GROUP_FILTER;
      const d=await(await fetch('/api/new',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
      if(d.sessionId){switchTab(d.sessionId);refreshTabs()}
    };
    TB.appendChild(nt);
  }catch{}
}
function switchTab(id){
  S=id;act=1;busy=0;
  refreshTabs();frame();
}
refreshTabs();
setInterval(refreshTabs,4000);

function api(m,p={}){D.className='dot x';return fetch('/api/cmd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:S,method:m,params:p})}).then(r=>r.json()).catch(()=>{})}

function activeTabName(){const s=allSessions.find(s=>s.id===S);return s?.name||S.slice(0,8)}

// Fire-and-forget nav — burst 20 frames at 40ms for instant feel
function nav(cmd){
  fetch('/api/cmd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:S,method:cmd,params:{}})});
  D.className='dot x';act=1;clearTimeout(bmp.t);bmp.t=setTimeout(()=>act=0,5000);
  let n=0;(function burst(){if(n++<20){busy=0;frame().then(()=>setTimeout(burst,40))}})();
}

// ─── Bookmarks ───
const BM=document.getElementById('bm');
let bookmarks=JSON.parse(localStorage.getItem('tb-bookmarks')||'[]');
if(!bookmarks.length) bookmarks=[
  {name:'GitHub',url:'https://github.com'},
  {name:'Google',url:'https://google.com'},
  {name:'HN',url:'https://news.ycombinator.com'},
  {name:'localhost:3000',url:'http://localhost:3000'},
];

function renderBookmarks(){
  BM.innerHTML='';
  for(const b of bookmarks){
    const el=document.createElement('button');el.className='bk';
    el.textContent=b.name;
    el.onclick=()=>{api('goto',{url:b.url});bmp()};
    el.oncontextmenu=e=>{e.preventDefault();if(confirm('Remove "'+b.name+'"?')){bookmarks=bookmarks.filter(x=>x!==b);localStorage.setItem('tb-bookmarks',JSON.stringify(bookmarks));renderBookmarks()}};
    BM.appendChild(el);
  }
  const add=document.createElement('button');add.className='bk add';add.textContent='+';
  add.title='Bookmark this page';
  add.onclick=()=>{
    const u=U.value.trim();if(!u)return;
    const name=prompt('Bookmark name:',new URL(u).hostname)||new URL(u).hostname;
    bookmarks.push({name,url:u});
    localStorage.setItem('tb-bookmarks',JSON.stringify(bookmarks));
    renderBookmarks();
  };
  BM.appendChild(add);
}
renderBookmarks();

// Fast adaptive polling — 150ms active, 500ms idle
async function frame(){
 if(busy)return;busy=1;
 try{
  const q=act?80:70;
  const d=await(await fetch('/api/frame?session='+S+'&quality='+q)).json();
  if(d.base64){I.src='data:image/jpeg;base64,'+d.base64;W=d.w||W;H=d.h||H}
  if(d.url&&document.activeElement!==U)U.value=d.url;
  if(d.title)document.title='tb — '+activeTabName()+' — '+d.title;
  D.className='dot';
 }catch{D.className='dot x'}
 busy=0;
}

function bmp(){act=1;clearTimeout(bmp.t);bmp.t=setTimeout(()=>act=0,3000);setTimeout(frame,50)}

// Adaptive poll loop — fast when active, slow when idle
(function poll(){frame().then(()=>setTimeout(poll,act?150:500))})();

function s2p(ox,oy){
 const ew=I.clientWidth,eh=I.clientHeight;
 const nw=I.naturalWidth||W,nh=I.naturalHeight||H;
 const imgAspect=nw/nh, boxAspect=ew/eh;
 let iw,ih,ix,iy;
 if(imgAspect>boxAspect){iw=ew;ih=ew/imgAspect;ix=0;iy=(eh-ih)/2}
 else{ih=eh;iw=eh*imgAspect;iy=0;ix=(ew-iw)/2}
 const rx=(ox-ix)/iw, ry=(oy-iy)/ih;
 return{x:Math.round(Math.max(0,Math.min(W,rx*W))),y:Math.round(Math.max(0,Math.min(H,ry*H)))};
}

I.addEventListener('click',e=>{
 e.preventDefault();
 const{x,y}=s2p(e.offsetX,e.offsetY);
 api('clickAt',{x,y}).then(()=>bmp());
});
I.addEventListener('mousedown',e=>e.preventDefault());

let ct;
I.addEventListener('mousemove',e=>{
 clearTimeout(ct);
 ct=setTimeout(()=>{
  const{x,y}=s2p(e.offsetX,e.offsetY);
  api('evaluate',{expression:'(()=>{var e=document.elementFromPoint('+x+','+y+');if(!e)return"default";var c=getComputedStyle(e).cursor;if(c==="auto"){var t=e.closest("a,button,[role=button],label,summary");if(t)return"pointer";if(e.closest("input,textarea,select"))return"text"}return c})()'})
   .then(r=>{if(r&&r.result)I.style.cursor=r.result});
 },80);
});

I.addEventListener('wheel',e=>{e.preventDefault();const{x,y}=s2p(e.offsetX,e.offsetY);api('scroll',{direction:e.deltaY>0?'down':'up',pixels:Math.min(Math.abs(Math.round(e.deltaY))*2,800),x,y});bmp()},{passive:false});

document.addEventListener('keydown',e=>{
 if(document.activeElement===U||document.activeElement===CI)return;
 if({Enter:1,Backspace:1,Tab:1,Escape:1,ArrowDown:1,ArrowUp:1,ArrowLeft:1,ArrowRight:1}[e.key]){e.preventDefault();api('keyPress',{key:e.key});bmp();return}
 if(e.key.length===1&&!e.metaKey&&!e.ctrlKey){e.preventDefault();api('typeText',{text:e.key});bmp()}
});

U.addEventListener('keydown',e=>{
 if(e.key==='Enter'){e.preventDefault();let u=U.value.trim();if(!u)return;if(!/^http/.test(u))u='https://'+u;U.blur();api('goto',{url:u}).then(()=>bmp())}
 if(e.key==='Escape')U.blur();
});

function ss(){fetch('/api/frame?session='+S+'&quality=100').then(r=>r.json()).then(d=>{
 if(d.base64){const a=document.createElement('a');a.href='data:image/jpeg;base64,'+d.base64;a.download='tb-'+Date.now()+'.jpg';a.click()}
})}

// ─── Element overlay ───
const OV=document.getElementById('overlay');
let elsOn=false;

function toggleEls(){
  elsOn=!elsOn;
  document.getElementById('btn-els').classList.toggle('active',elsOn);
  if(elsOn)refreshEls();else OV.className='';
}

async function refreshEls(){
  if(!elsOn)return;
  // Same enumeration as tb elements / tb tap — identical walk order, identical numbers.
  // Show all elements, only hide ones that are off-screen.
  const r=await api('evaluate',{expression:\`(() => {
    var results=[],seen=new Set(),idx=1,vw=window.innerWidth,vh=window.innerHeight;
    function vis(el){
      try{if(getComputedStyle(el).display==='none'||el.offsetParent===null)return false}catch(e){return false}
      // Check element is actually hittable — not hidden behind a dropdown/overlay
      var r=el.getBoundingClientRect();
      if(r.width<2||r.height<2)return false;
      var hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      return hit&&(hit===el||el.contains(hit)||hit.closest&&hit.closest('a,button')=== el);
    }
    function inView(r){return r.width>5&&r.height>5&&r.x+r.width>0&&r.y+r.height>0&&r.x<vw&&r.y<vh}
    var inputs=document.querySelectorAll('input[type="text"],input[type="search"],input[type="email"],input[type="password"],input[type="url"],input[type="number"],input:not([type]),textarea');
    for(var i=0;i<inputs.length;i++){var inp=inputs[i];
      if(inp.type==='hidden'||!vis(inp))continue;
      var r=inp.getBoundingClientRect();var n=idx++;
      if(inView(r)){results.push({t:'input',x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),cx:Math.round(r.x+r.width/2),cy:Math.round(r.y+r.height/2),label:(inp.getAttribute('placeholder')||inp.name||'input').slice(0,30)})}}
    var btns=document.querySelectorAll('button,input[type="submit"],input[type="button"],[role="button"]');
    for(var j=0;j<btns.length;j++){var btn=btns[j];
      if(!vis(btn))continue;
      var t=(btn.textContent||btn.value||btn.getAttribute('aria-label')||'').trim().replace(/\\s+/g,' ');
      if(!t||seen.has(t))continue;seen.add(t);
      var r2=btn.getBoundingClientRect();
      if(inView(r2)){results.push({t:'button',x:Math.round(r2.x),y:Math.round(r2.y),w:Math.round(r2.width),h:Math.round(r2.height),cx:Math.round(r2.x+r2.width/2),cy:Math.round(r2.y+r2.height/2),label:t.slice(0,30)})}}
    var links=document.querySelectorAll('a[href]');
    for(var k=0;k<links.length;k++){var a=links[k];
      if(!vis(a))continue;
      var at=(a.textContent||'').trim().replace(/\\s+/g,' ');if(!at||at.length<2||seen.has(at))continue;seen.add(at);
      var r3=a.getBoundingClientRect();
      if(inView(r3)){results.push({t:'link',x:Math.round(r3.x),y:Math.round(r3.y),w:Math.round(r3.width),h:Math.round(r3.height),cx:Math.round(r3.x+r3.width/2),cy:Math.round(r3.y+r3.height/2),label:at.slice(0,30)})}}
    // Sort by visual position (top to bottom, left to right) and number sequentially
    results.sort(function(a,b){var dy=a.y-b.y;return Math.abs(dy)>15?dy:a.x-b.x});
    for(var i=0;i<results.length;i++)results[i].n=i+1;
    return results})()\`});
  const els=(r&&r.result)||[];
  OV.innerHTML='';OV.className='on';
  // Map page coords to overlay pixel coords
  const ir=I.getBoundingClientRect(), vr=document.getElementById('vp').getBoundingClientRect();
  const nw=I.naturalWidth||W,nh=I.naturalHeight||H;
  const ia=nw/nh,ba=ir.width/ir.height;
  let iw,ih,ix,iy;
  if(ia>ba){iw=ir.width;ih=ir.width/ia;ix=ir.left-vr.left;iy=ir.top-vr.top+(ir.height-ih)/2}
  else{ih=ir.height;iw=ir.height*ia;iy=ir.top-vr.top;ix=ir.left-vr.left+(ir.width-iw)/2}
  for(const el of els){
    const bx=ix+(el.x/W)*iw;
    const by=iy+(el.y/H)*ih;
    const b=document.createElement('div');
    b.className='badge'+(el.t==='input'?' input':el.t==='button'?' button':'');
    b.textContent=el.n;
    b.title=el.n+': '+el.label+' ('+el.t+')';
    b.style.left=bx+'px';b.style.top=by+'px';
    b.onclick=(e)=>{e.stopPropagation();api('clickAt',{x:el.cx,y:el.cy}).then(()=>bmp())};
    OV.appendChild(b);
  }
}

// Refresh overlay when frame updates (if on)
const origFrame=frame;
frame=async function(){await origFrame();if(elsOn)refreshEls()};

// ─── Command bar ───
const CI=document.getElementById('cmd-input');
let cmdOn=false;

function toggleCmd(){
  cmdOn=!cmdOn;
  document.getElementById('btn-cmd').classList.toggle('active',cmdOn);
  document.getElementById('cmd').classList.toggle('on',cmdOn);
  if(cmdOn)CI.focus();
}

async function runCmd(raw){
  const parts=raw.split(/\\s*;\\s*/);
  for(const part of parts){
    const p=part.trim();if(!p)continue;
    const m=p.match(/^(\\d+)$/);
    if(m){await api('evaluate',{expression:\`(() => {
      var els=[],seen=new Set(),vw=window.innerWidth,vh=window.innerHeight;
      function vis(el){try{if(getComputedStyle(el).display==='none'||el.offsetParent===null)return false}catch(e){return false}var r=el.getBoundingClientRect();if(r.width<2||r.height<2)return false;var hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return hit&&(hit===el||el.contains(hit)||(hit.closest&&hit.closest('a,button')===el))}
      function inView(r){return r.width>5&&r.height>5&&r.x+r.width>0&&r.y+r.height>0&&r.x<vw&&r.y<vh}
      var inputs=document.querySelectorAll('input[type="text"],input[type="search"],input[type="email"],input[type="password"],input[type="url"],input[type="number"],input:not([type]),textarea');
      for(var i=0;i<inputs.length;i++){if(inputs[i].type==='hidden'||!vis(inputs[i]))continue;var r=inputs[i].getBoundingClientRect();if(inView(r))els.push({el:inputs[i],y:r.y,x:r.x})}
      var btns=document.querySelectorAll('button,input[type="submit"],input[type="button"],[role="button"]');
      for(var j=0;j<btns.length;j++){if(!vis(btns[j]))continue;var t=(btns[j].textContent||'').trim().replace(/\\s+/g,' ');if(!t||seen.has(t))continue;seen.add(t);var r2=btns[j].getBoundingClientRect();if(inView(r2))els.push({el:btns[j],y:r2.y,x:r2.x})}
      var links=document.querySelectorAll('a[href]');
      for(var k=0;k<links.length;k++){if(!vis(links[k]))continue;var at=(links[k].textContent||'').trim().replace(/\\s+/g,' ');if(!at||at.length<2||seen.has(at))continue;seen.add(at);var r3=links[k].getBoundingClientRect();if(inView(r3))els.push({el:links[k],y:r3.y,x:r3.x})}
      els.sort(function(a,b){var dy=a.y-b.y;return Math.abs(dy)>15?dy:a.x-b.x});
      var n=\${m[1]};if(n<1||n>els.length)return false;
      var target=els[n-1];var rect=target.el.getBoundingClientRect();
      target.el.focus();target.el.click();
      return true})()\`});bmp();await new Promise(r=>setTimeout(r,300));continue}
    const cmd=p.split(/\\s+/);const c=cmd[0].toLowerCase();const arg=cmd.slice(1).join(' ');
    if(c==='tap'&&cmd[1]){await runCmd(cmd[1]);continue}
    if(c==='type'&&arg){await api('typeText',{text:arg});bmp();await new Promise(r=>setTimeout(r,100));continue}
    if(c==='click'&&arg){await api('click',{selector:arg});bmp();await new Promise(r=>setTimeout(r,300));continue}
    if(c==='goto'||c==='go'||c==='open'){await api('goto',{url:arg.startsWith('http')?arg:'https://'+arg});bmp();await new Promise(r=>setTimeout(r,500));continue}
    if(c==='wait'&&arg){await api('waitForSelector',{selector:arg});bmp();continue}
    if(c==='eval'||c==='js'){await api('evaluate',{expression:arg});bmp();continue}
    if(c==='scroll'){await api('scroll',{direction:arg==='up'?'up':'down',pixels:500});bmp();continue}
    if(c==='enter'){await api('keyPress',{key:'Enter'});bmp();await new Promise(r=>setTimeout(r,200));continue}
    if(c==='replay'&&arg){await replayRecording(arg);continue}
    if(c==='clear'&&arg){await api('evaluate',{expression:\`(()=>{var el=document.querySelector('\${arg}');if(el){var s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');if(s&&s.set)s.set.call(el,'');else el.value='';el.dispatchEvent(new Event('input',{bubbles:true}));el.focus()}})()\`});bmp();continue}
  }
}

CI.addEventListener('keydown',e=>{
  if(e.key==='Enter'){e.preventDefault();const v=CI.value.trim();if(!v)return;CI.value='';runCmd(v)}
  if(e.key==='Escape'){CI.blur();toggleCmd()}
});

// ─── Viewport toggle ───
const viewports=[{n:'Desktop',w:1920,h:1080},{n:'Laptop',w:1440,h:900},{n:'Tablet',w:1024,h:1366},{n:'Mobile',w:390,h:844}];
let vpIdx=0;
function cycleViewport(){
  vpIdx=(vpIdx+1)%viewports.length;
  const vp=viewports[vpIdx];
  // Emulation.setDeviceMetricsOverride changes the viewport in Chrome
  api('evaluate',{expression:\`
    (async()=>{
      // Can't call CDP from page JS, but we can signal to the server
      document.title = document.title; // trigger frame refresh
    })()
  \`});
  // Send the actual CDP command via a special API call
  fetch('/api/viewport',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:S,width:vp.w,height:vp.h})});
  addConLine('info','Viewport: '+vp.n+' ('+vp.w+'x'+vp.h+')',Date.now());
  W=vp.w;H=vp.h;
  bmp();
}

// ─── Record/Replay ───
let recording=false,recStart=0,recInterval=null,pendingActions=[];

function toggleRec(){
  if(recording){openSaveDialog();return}
  // Start recording
  recording=true;recStart=Date.now();pendingActions=[];
  document.getElementById('btn-rec').classList.add('rec');
  document.getElementById('recbar').classList.add('on');
  document.getElementById('rec-count').textContent='0 actions';
  api('evaluate',{expression:\`(() => {
    window.__tbRec=[];
    document.addEventListener('click',e=>{
      window.__tbRec.push({t:'click',x:e.clientX,y:e.clientY,ts:Date.now()});
    },true);
    document.addEventListener('input',e=>{
      if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA'){
        var sel=e.target.id?'#'+e.target.id:(e.target.name?'[name="'+e.target.name+'"]':e.target.tagName);
        window.__tbRec.push({t:'input',sel:sel,val:e.target.value,ts:Date.now()});
      }
    },true);
  })()\`});
  recInterval=setInterval(async()=>{
    const r=await api('evaluate',{expression:'(window.__tbRec||[]).length'});
    if(r&&r.result!==undefined)document.getElementById('rec-count').textContent=r.result+' actions';
  },1000);
}

function openSaveDialog(){
  // Pause recording, show save dialog
  clearInterval(recInterval);
  document.getElementById('save-overlay').classList.add('show');
  document.getElementById('save-dialog').classList.add('show');
  document.getElementById('save-name').value='';
  document.getElementById('save-name').focus();
}

function cancelSave(){
  document.getElementById('save-overlay').classList.remove('show');
  document.getElementById('save-dialog').classList.remove('show');
  // Resume recording
  recInterval=setInterval(async()=>{
    const r=await api('evaluate',{expression:'(window.__tbRec||[]).length'});
    if(r&&r.result!==undefined)document.getElementById('rec-count').textContent=r.result+' actions';
  },1000);
}

async function confirmSave(){
  let name=document.getElementById('save-name').value.trim();
  const cat=document.getElementById('save-cat').value;
  if(!name){document.getElementById('save-name').style.borderColor='#ea4335';return}
  if(cat)name=cat+'/'+name;

  document.getElementById('save-overlay').classList.remove('show');
  document.getElementById('save-dialog').classList.remove('show');
  recording=false;
  document.getElementById('btn-rec').classList.remove('rec');
  document.getElementById('recbar').classList.remove('on');

  // Collect page actions
  const r=await api('evaluate',{expression:'window.__tbRec||[]'});
  const pageActions=(r&&r.result)||[];
  const actions=[];
  for(const a of pageActions){
    if(a.t==='click')actions.push({ts:a.ts-recStart,method:'clickAt',params:{x:a.x,y:a.y}});
    else if(a.t==='input')actions.push({ts:a.ts-recStart,method:'clear_and_type',params:{selector:a.sel,text:a.val||''}});
  }
  if(!actions.length){addConLine('warn','No actions recorded',Date.now());return}
  await fetch('/api/recording',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,actions})});
  addConLine('info','Saved: '+name+' ('+actions.length+' actions)',Date.now());
}

// Enter to save in dialog
document.getElementById('save-name')?.addEventListener('keydown',e=>{if(e.key==='Enter')confirmSave();if(e.key==='Escape')cancelSave()});

// Add replay to command bar
async function replayRecording(name){
  try{
    const r=await fetch('/api/recording?name='+encodeURIComponent(name));
    if(!r.ok){addConLine('error','Failed to load: '+name,Date.now());return}
    const data=await r.json();
    if(!data.actions||!data.actions.length){addConLine('error','Empty recording: '+name,Date.now());return}
    addConLine('info','▶ Replaying: '+name+' ('+data.actions.length+' actions)',Date.now());
    act=1;
    let prev=0;
    for(let i=0;i<data.actions.length;i++){
      const a=data.actions[i];
      const delay=a.ts-prev;if(delay>50)await new Promise(r=>setTimeout(r,Math.min(delay,2000)));
      prev=a.ts;
      const m=a.method;
      try{
        if(m==='clickAt')await api('clickAt',a.params);
        else if(m==='goto'){await api('goto',a.params);await new Promise(r=>setTimeout(r,1000))}
        else if(m==='clear_and_type'){
          await api('evaluate',{expression:\`(()=>{var el=document.querySelector('\${a.params.selector}');if(el){el.value='';el.focus()}})()\`});
          await api('typeText',{text:a.params.text});
        }
        else if(m==='scroll_down')await api('scroll',{direction:'down',pixels:500});
        else if(m==='scroll_up')await api('scroll',{direction:'up',pixels:500});
        else if(m==='key')await api('keyPress',{key:a.params.key});
        else if(m==='typeText')await api('typeText',a.params);
        else if(m==='eval'){const er=await api('evaluate',a.params);if(er&&er.result)addConLine('info','→ '+JSON.stringify(er.result).slice(0,80),Date.now())}
        addConLine('info','  ['+(i+1)+'/'+data.actions.length+'] '+m,Date.now());
      }catch(e){addConLine('error','  action failed: '+m+' — '+e,Date.now())}
      busy=0;await frame();
    }
    addConLine('info','✓ Replay complete',Date.now());
  }catch(e){addConLine('error','Replay error: '+e,Date.now())}
  clearTimeout(bmp.t);bmp.t=setTimeout(()=>act=0,3000);
}

// ─── Replay list dropdown ───
const RL=document.getElementById('replay-list');

async function showReplayList(){
  if(RL.classList.contains('show')){RL.classList.remove('show');return}
  const btn=document.getElementById('btn-play');
  const r=btn.getBoundingClientRect();
  RL.style.left=Math.max(0,r.left-60)+'px';
  RL.style.top=(r.bottom+4)+'px';
  RL.innerHTML='<div class="rl-title">recordings</div>';

  const recs=await(await fetch('/api/recordings')).json();
  if(!recs.length){
    RL.innerHTML+='<div class="rl-empty">No recordings yet. Hit the record button.</div>';
  } else {
    // Group by category (folder prefix)
    const groups={};
    for(const name of recs){
      const parts=name.split('/');
      const cat=parts.length>1?parts[0]:'';
      if(!groups[cat])groups[cat]=[];
      groups[cat].push(name);
    }
    for(const [cat,names] of Object.entries(groups)){
      if(cat){const hd=document.createElement('div');hd.className='rl-title';hd.textContent=cat;RL.appendChild(hd)}
      for(const name of names){
        const display=name.includes('/')?name.split('/').slice(1).join('/'):name;
        const item=document.createElement('div');item.className='rl-item';
        item.innerHTML='<span class="rl-icon">&#9654;</span>'+display+'<span class="rl-del" title="Delete">&#215;</span>';
        item.querySelector('.rl-del').onclick=async(e)=>{
          e.stopPropagation();
          if(!confirm('Delete "'+display+'"?'))return;
          await fetch('/api/recording?name='+encodeURIComponent(name),{method:'DELETE'});
          showReplayList();
        };
        item.onclick=()=>{RL.classList.remove('show');replayRecording(name)};
        RL.appendChild(item);
      }
    }
  }
  RL.classList.add('show');
  // Close on outside click
  setTimeout(()=>{
    const close=e=>{if(!RL.contains(e.target)&&e.target!==btn){RL.classList.remove('show');document.removeEventListener('click',close)}};
    document.addEventListener('click',close);
  },0);
}

// ─── Console panel ───
const CON=document.getElementById('console');
let conOn=false;

function toggleConsole(){
  conOn=!conOn;
  document.getElementById('btn-con').classList.toggle('active',conOn);
  CON.classList.toggle('on',conOn);
  if(conOn)pollEvents();
}

function addConLine(type,text,ts){
  const cls={error:'error',warning:'warn',log:'info',info:'info',navigation:'nav',network_error:'net'}[type]||'';
  const d=document.createElement('div');d.className='cline '+cls;
  const t2=ts?new Date(ts).toLocaleTimeString():'';
  const safeText=text.replace(/</g,'&lt;');
  d.innerHTML='<span class="cts">'+t2+'</span><span class="ctx">'+safeText+'</span><span class="ccopy">copy</span>';
  // Click to expand/collapse long lines
  d.querySelector('.ctx').onclick=()=>d.classList.toggle('expanded');
  // Copy button
  d.querySelector('.ccopy').onclick=(e)=>{
    e.stopPropagation();
    navigator.clipboard.writeText(text);
    d.querySelector('.ccopy').textContent='copied!';
    setTimeout(()=>d.querySelector('.ccopy').textContent='copy',500);
  };
  CON.appendChild(d);
  if(CON.children.length>200)CON.removeChild(CON.firstChild);
  CON.scrollTop=CON.scrollHeight;
}

async function pollEvents(){
  if(!conOn)return;
  try{
    const r=await api('getEvents');
    const events=(r&&r.result)||[];
    for(const e of events){
      const ts=e.ts||Date.now();
      if(e.type==='console')addConLine(e.data.level||'log',e.data.text||'',ts);
      else if(e.type==='navigation')addConLine('navigation','→ '+e.data.url,ts);
      else if(e.type==='network_error')addConLine('network_error',e.data.status+' '+e.data.url,ts);
      else if(e.type==='error')addConLine('error',e.data.text||'Error',ts);
    }
  }catch{}
  setTimeout(pollEvents,1000);
}

(function go(){frame().then(()=>setTimeout(go,act?80:250))})();
</script></body></html>`;
}

// ─── CC HTML ─────────────────────────────────────────────────────────────────

function ccHTML(): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>tb cc</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d0d0d;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;height:100vh;display:flex;flex-direction:column;overflow:hidden}
#hd{height:36px;background:#161616;border-bottom:1px solid #252525;display:flex;align-items:center;padding:0 12px;gap:8px;flex-shrink:0}
#hd h1{font-size:12px;font-weight:600;color:#fff}
.n{font-size:10px;color:#666;background:#1a1a1a;padding:1px 7px;border-radius:8px;border:1px solid #2a2a2a}
.tb{font-size:10px;color:#666;background:none;border:1px solid #2a2a2a;padding:1px 8px;border-radius:4px;cursor:pointer;margin-left:auto}
.tb:hover{color:#ccc;border-color:#444}
.tb.active{color:#4285f4;border-color:#4285f4}
.st{font-size:10px;color:#555}
#g{flex:1;display:grid;gap:2px;padding:2px;overflow:hidden}
.c{background:#111;border:1px solid #1a1a1a;border-radius:4px;overflow:hidden;display:flex;flex-direction:column;position:relative;min-height:0}
.c.focused{border-color:#4285f4;box-shadow:0 0 0 1px #4285f4}
.ch{height:22px;display:flex;align-items:center;gap:4px;padding:0 8px;background:#161616;border-bottom:1px solid #1a1a1a;flex-shrink:0}
.ce{font-size:8px;color:#555;text-transform:uppercase;flex-shrink:0;font-weight:600}
.cu{font-size:9px;color:#444;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.cw{font-size:9px;color:#555;background:none;border:none;cursor:pointer;padding:0 4px;flex-shrink:0}
.cw:hover{color:#4285f4}
.inner{flex:1;display:grid;gap:1px;min-height:0;overflow:hidden}
.tile{display:flex;flex-direction:column;min-height:0;overflow:hidden;position:relative;background:#0a0a0a;border:1px solid transparent;border-radius:2px}
.tile.tfocus{border-color:#4285f4}
.tile .th{height:16px;display:flex;align-items:center;gap:4px;padding:0 6px;background:#131313;flex-shrink:0}
.tile .tname{font-size:8px;color:#888;font-weight:600;flex-shrink:0}
.tile .turl{font-size:7px;color:#333;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.tile .tfocus .tname{color:#4285f4}
.ci{flex:1;display:block;width:100%;min-height:0;object-fit:contain;background:#0a0a0a;-webkit-user-drag:none;user-select:none}
.mt{display:flex;align-items:center;justify-content:center;flex:1;color:#333;font-size:13px}
</style></head><body>
<div id="hd">
 <h1>tb cc</h1>
 <span class="n" id="cnt">0</span>
 <span class="st" id="st">...</span>
 <button class="tb" id="btn-layout" onclick="cycleLayout()">2x2</button>
</div>
<div id="g"></div>
<script>
const G=document.getElementById('g'),CNT=document.getElementById('cnt'),ST=document.getElementById('st');
let allSessions=[],windows={},focused=null,W=${config.viewport.width},H=${config.viewport.height};
// windows = { groupKey: { sessions: [...], activeId: '...', el: DOM } }
let layout=localStorage.getItem('tb-cc-layout')||'auto';

function applyLayout(){
  const n=Object.keys(windows).length;
  const btn=document.getElementById('btn-layout');
  if(layout==='1x1'){G.style.gridTemplateColumns='1fr';G.style.gridTemplateRows='1fr';btn.textContent='1x1'}
  else if(layout==='2x1'){G.style.gridTemplateColumns='1fr 1fr';G.style.gridTemplateRows='1fr';btn.textContent='2x1'}
  else if(layout==='2x2'){G.style.gridTemplateColumns='1fr 1fr';G.style.gridTemplateRows='1fr 1fr';btn.textContent='2x2'}
  else if(layout==='3x2'){G.style.gridTemplateColumns='1fr 1fr 1fr';G.style.gridTemplateRows='1fr 1fr';btn.textContent='3x2'}
  else{
    if(n<=1){G.style.gridTemplateColumns='1fr';G.style.gridTemplateRows='1fr'}
    else if(n<=2){G.style.gridTemplateColumns='1fr';G.style.gridTemplateRows='1fr 1fr'}
    else if(n<=4){G.style.gridTemplateColumns='1fr 1fr';G.style.gridTemplateRows='1fr 1fr'}
    else{G.style.gridTemplateColumns='repeat(3,1fr)';G.style.gridTemplateRows='1fr 1fr'}
    btn.textContent='auto';
  }
}
function cycleLayout(){
  const layouts=['auto','1x1','2x1','2x2','3x2'];
  layout=layouts[(layouts.indexOf(layout)+1)%layouts.length];
  localStorage.setItem('tb-cc-layout',layout);
  applyLayout();
}

function api(sid,m,p={}){return fetch('/api/cmd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:sid,method:m,params:p})}).then(r=>r.json()).catch(()=>{})}

function focusTile(sid){
  focused=sid;
  G.querySelectorAll('.tile').forEach(t=>t.classList.toggle('tfocus',t.dataset.sid===sid));
}

function s2p(e,img){
  const r=img.getBoundingClientRect(),nw=img.naturalWidth||W,nh=img.naturalHeight||H;
  const ia=nw/nh,ba=r.width/r.height;
  let iw,ih,ix,iy;
  if(ia>ba){iw=r.width;ih=r.width/ia;ix=0;iy=(r.height-ih)/2}
  else{ih=r.height;iw=r.height*ia;iy=0;ix=(r.width-iw)/2}
  return{x:Math.round(((e.offsetX-ix)/iw)*W),y:Math.round(((e.offsetY-iy)/ih)*H)};
}

function groupKey(s){return s.group||'_solo_'+s.id}
function groupLabel(key){return key.startsWith('_solo_')?null:key}

function innerLayout(grid,n){
  if(n<=1){grid.style.gridTemplateColumns='1fr';grid.style.gridTemplateRows='1fr'}
  else if(n<=2){grid.style.gridTemplateColumns='1fr 1fr';grid.style.gridTemplateRows='1fr'}
  else if(n<=4){grid.style.gridTemplateColumns='1fr 1fr';grid.style.gridTemplateRows='1fr 1fr'}
  else{grid.style.gridTemplateColumns='repeat(3,1fr)';grid.style.gridTemplateRows='1fr 1fr'}
}

function buildWindow(gKey,sessions){
  const c=document.createElement('div');c.className='c';c.dataset.group=gKey;

  // Header with group name + watch button
  const hdr=document.createElement('div');hdr.className='ch';
  const gName=groupLabel(gKey);
  if(gName){const gl=document.createElement('span');gl.className='ce';gl.textContent=gName;hdr.appendChild(gl)}
  else{const gl=document.createElement('span');gl.className='ce';gl.textContent=sessions[0].name||sessions[0].id.slice(0,6);hdr.appendChild(gl)}
  const spacer=document.createElement('span');spacer.className='cu';hdr.appendChild(spacer);
  const wb=document.createElement('span');wb.className='cw';wb.textContent='↗';wb.title='Open in watch';
  wb.onclick=(e)=>{e.stopPropagation();window.open('/watch/'+sessions[0].id,'tb-watch','width=1040,height=700')};
  hdr.appendChild(wb);
  c.appendChild(hdr);

  // Inner grid — one tile per tab
  const grid=document.createElement('div');grid.className='inner';
  innerLayout(grid,sessions.length);

  // Drop zone — accept sessions dragged from other groups
  c.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='move';c.style.outline='2px solid #4285f4'});
  c.addEventListener('dragleave',()=>{c.style.outline=''});
  c.addEventListener('drop',async e=>{
    e.preventDefault();c.style.outline='';
    const dragSid=e.dataTransfer.getData('text/plain');
    if(!dragSid)return;
    const targetGroup=gName||'';
    await fetch('/api/cmd',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:dragSid,method:'__move',params:{group:targetGroup}})}).catch(()=>{});
    // Use daemon PATCH directly
    await fetch('/api/move',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:dragSid,group:targetGroup})}).catch(()=>{});
  });

  for(const s of sessions){
    const tile=document.createElement('div');tile.className='tile';tile.dataset.sid=s.id;

    // Tile header with name + url — draggable for group moves
    const th=document.createElement('div');th.className='th';th.draggable=true;th.style.cursor='grab';
    th.addEventListener('dragstart',e=>{e.dataTransfer.setData('text/plain',s.id);e.dataTransfer.effectAllowed='move';tile.style.opacity='.4'});
    th.addEventListener('dragend',()=>{tile.style.opacity=''});
    const tn=document.createElement('span');tn.className='tname';tn.textContent=s.name||s.id.slice(0,6);
    const tu=document.createElement('span');tu.className='turl';tu.dataset.role='url';
    th.appendChild(tn);th.appendChild(tu);
    tile.appendChild(th);

    // Screenshot
    const img=document.createElement('img');img.className='ci';img.draggable=false;img.dataset.sid=s.id;
    img.addEventListener('click',e=>{
      e.preventDefault();focusTile(s.id);
      const{x,y}=s2p(e,img);api(s.id,'clickAt',{x,y});
    });
    img.addEventListener('mousedown',e=>e.preventDefault());
    img.addEventListener('wheel',e=>{
      e.preventDefault();focusTile(s.id);
      api(s.id,'scroll',{direction:e.deltaY>0?'down':'up',pixels:Math.min(Math.abs(e.deltaY)*3,800)});
    },{passive:false});
    tile.appendChild(img);
    grid.appendChild(tile);
  }

  c.appendChild(grid);
  G.appendChild(c);
  return{sessions,activeId:sessions[0].id,el:c};
}

// Keyboard → focused session
document.addEventListener('keydown',e=>{
  if(!focused)return;
  if({Enter:1,Backspace:1,Tab:1,Escape:1,ArrowDown:1,ArrowUp:1,ArrowLeft:1,ArrowRight:1}[e.key]){e.preventDefault();api(focused,'keyPress',{key:e.key});return}
  if(e.key.length===1&&!e.metaKey&&!e.ctrlKey){e.preventDefault();api(focused,'typeText',{text:e.key})}
});

async function poll(){try{
 allSessions=await(await fetch('/api/sessions')).json();
 CNT.textContent=allSessions.length;ST.textContent='live';

 // Group sessions
 const groups={};
 for(const s of allSessions){const k=groupKey(s);if(!groups[k])groups[k]=[];groups[k].push(s)}

 // Remove windows for dead groups
 for(const gk of Object.keys(windows)){
   if(!groups[gk]){windows[gk].el.remove();delete windows[gk]}
 }

 // Create/update windows
 for(const [gk,sessions] of Object.entries(groups)){
   if(!windows[gk]){
     windows[gk]=buildWindow(gk,sessions);
   } else {
     // Check if sessions changed (added/removed tabs)
     const oldIds=windows[gk].sessions.map(s=>s.id).sort().join(',');
     const newIds=sessions.map(s=>s.id).sort().join(',');
     if(oldIds!==newIds){
       // Rebuild the window tile
       windows[gk].el.remove();
       windows[gk]=buildWindow(gk,sessions);
     } else {
       windows[gk].sessions=sessions;
     }
   }
 }

 if(!allSessions.length&&!G.querySelector('.mt'))G.innerHTML='<div class="mt">No active sessions</div>';
 else if(allSessions.length)G.querySelector('.mt')?.remove();
 applyLayout();
}catch{ST.textContent='off'}}

async function frames(){
 const allTiles=[];
 for(const [gk,w] of Object.entries(windows)){
   for(const s of w.sessions) allTiles.push({gk,sid:s.id});
 }
 await Promise.all(allTiles.map(async({gk,sid})=>{
   try{
     const d=await(await fetch('/api/frame?session='+sid+'&quality='+(sid===focused?80:60))).json();
     const w=windows[gk];if(!w)return;
     const img=w.el.querySelector('img[data-sid="'+sid+'"]');
     if(img&&d.base64){img.src='data:image/jpeg;base64,'+d.base64;W=d.w||W;H=d.h||H}
     const tile=w.el.querySelector('.tile[data-sid="'+sid+'"]');
     if(tile&&d.url){const u=tile.querySelector('[data-role=url]');if(u)u.textContent=d.url}
   }catch{}
 }));
}

poll();setInterval(poll,3000);
(function go(){frames().then(()=>setTimeout(go,focused?200:1000))})();
</script></body></html>`;
}

// ─── Server ──────────────────────────────────────────────────────────────────

function startServer(mode: "watch" | "cc", sid?: string, name?: string, groupFilter?: string) {
  let firstFrame: string | undefined, firstUrl: string | undefined;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      try {
        if (p === "/" && mode === "watch" && sid) {
          if (!firstFrame) {
            try { const [s, u] = await Promise.all([sessionCmd(sid, "screenshot", { format: "jpeg", quality: 70 }), sessionCmd(sid, "url")]); firstFrame = (s as any).base64; firstUrl = u as string; } catch {}
          }
          return new Response(watchHTML(sid, name || "session", firstFrame, firstUrl, groupFilter), { headers: { "Content-Type": "text/html" } });
        }
        if (p === "/" && mode === "cc") return new Response(ccHTML(), { headers: { "Content-Type": "text/html" } });
        if (p.startsWith("/watch/")) {
          const wsid = p.slice(7); const sessions = await getSessions(); const s = sessions.find(s => s.id === wsid || s.name === wsid);
          let ff: string | undefined, fu: string | undefined;
          try { const [s2, u] = await Promise.all([sessionCmd(wsid, "screenshot", { format: "jpeg", quality: 70 }), sessionCmd(wsid, "url")]); ff = (s2 as any).base64; fu = u as string; } catch {}
          return new Response(watchHTML(wsid, s?.name || wsid.slice(0, 8), ff, fu), { headers: { "Content-Type": "text/html" } });
        }
        const r = await handleAPI(req, url); if (r) return r;
      } catch (err) { return Response.json({ error: (err as Error).message }, { status: 500 }); }
      return new Response("Not found", { status: 404 });
    },
  });
  return server;
}

// ─── Public ──────────────────────────────────────────────────────────────────

export async function watch(sessionIdOrName?: string, groupFilter?: string): Promise<void> {
  await ensureDaemon();
  const sessions = await getSessions();
  if (!sessions.length) { console.log("No active sessions. Use: tb open <url>"); return; }

  if (groupFilter) {
    // Group mode — show only sessions in this group
    const groupSessions = sessions.filter(s => s.group === groupFilter);
    if (!groupSessions.length) { console.log(`No sessions in group: ${groupFilter}`); return; }
    const target = groupSessions[0];
    const server = startServer("watch", target.id, target.name || target.id.slice(0, 8), groupFilter);
    console.log(`tb watch --group ${groupFilter} → http://localhost:${server.port}`);
    openAppWindow(`http://localhost:${server.port}`);
    await new Promise<void>(r => { process.on("SIGINT", () => { server.stop(); r(); process.exit(0); }); process.on("SIGTERM", () => { server.stop(); r(); process.exit(0); }); });
    return;
  }

  const target = sessionIdOrName
    ? sessions.find(s => s.id === sessionIdOrName || s.name === sessionIdOrName)
    : sessions[sessions.length - 1];
  if (!target) { console.log(`Session not found: ${sessionIdOrName}`); return; }

  const server = startServer("watch", target.id, target.name || target.id.slice(0, 8));
  console.log(`tb watch → http://localhost:${server.port}`);
  openAppWindow(`http://localhost:${server.port}`);
  await new Promise<void>(r => { process.on("SIGINT", () => { server.stop(); r(); process.exit(0); }); process.on("SIGTERM", () => { server.stop(); r(); process.exit(0); }); });
}

export async function commandCenter(): Promise<void> {
  await ensureDaemon();
  const server = startServer("cc");
  console.log(`tb cc → http://localhost:${server.port}`);
  openAppWindow(`http://localhost:${server.port}`);
  await new Promise<void>(r => { process.on("SIGINT", () => { server.stop(); r(); process.exit(0); }); process.on("SIGTERM", () => { server.stop(); r(); process.exit(0); }); });
}
