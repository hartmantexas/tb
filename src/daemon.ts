import { existsSync, unlinkSync, openSync, writeSync, closeSync, readFileSync, statSync } from "fs";
import { spawn } from "child_process";
import { homedir } from "os";
import { dirname, join } from "path";
import { CDPClient } from "./cdp.js";
import { Session } from "./session.js";
import { resolveEngine, type EngineProcess, type EngineType } from "./engines/index.js";
import {
  DAEMON_SOCK,
  ensureTBDir,
  writeDaemonPid,
  removeDaemonPid,
  getDaemonPid,
  isProcessRunning,
  randomId,
} from "./utils.js";
import { loadConfig } from "./config.js";
import {
  startBridgeServer,
  stopBridgeServer,
  getBridge,
  listBridges,
  BridgeCDPClient,
  type Bridge,
} from "./bridge.js";
import type { CDPLike } from "./cdp.js";

interface ManagedSession {
  id: string;
  name?: string;
  group?: string;
  session: Session;
  /** Absent for bridge sessions — there is no process tb owns. */
  engineProcess?: EngineProcess;
  cdp: CDPLike;
  createdAt: Date;
  lastUsedAt: Date;
  /** Set for bridge sessions: the Chrome tab this session drives. */
  bridge?: Bridge;
  tabId?: number;
  /** True only if tb opened the tab, and may therefore close it. */
  createdByTb?: boolean;
}

// --- Daemon server (runs as the daemon process) ---

export async function startDaemon(): Promise<void> {
  ensureTBDir();

  // Clean up stale socket
  if (existsSync(DAEMON_SOCK)) {
    try {
      unlinkSync(DAEMON_SOCK);
    } catch {}
  }

  const config = loadConfig();
  const sessions = new Map<string, ManagedSession>();
  const engineProcesses = new Map<string, EngineProcess>();
  const browserContexts = new Map<string, string>(); // group → browserContextId
  const startTime = Date.now();
  let lastActivity = Date.now();

  // Auto-shutdown timer
  const shutdownTimer = setInterval(() => {
    if (Date.now() - lastActivity > config.daemonTimeout) {
      console.log("Daemon idle timeout, shutting down...");
      cleanup();
      process.exit(0);
    }
  }, 60000);

  function touch() {
    lastActivity = Date.now();
  }

  function cleanup() {
    clearInterval(shutdownTimer);
    for (const s of sessions.values()) {
      s.cdp.close().catch(() => {});
    }
    // Only kills browsers tb launched. Bridge sessions have no entry here at
    // all, which is the point: `tb stop` must never take down the user's Chrome.
    for (const ep of engineProcesses.values()) {
      ep.kill();
    }
    stopBridgeServer();
    removeDaemonPid();
    try {
      unlinkSync(DAEMON_SOCK);
    } catch {}
  }

  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });

  async function handleRequest(req: Request): Promise<Response> {
    touch();
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const method = req.method;

    try {
      // GET /status
      if (method === "GET" && path === "/status") {
        return Response.json({
          running: true,
          uptime: Date.now() - startTime,
          sessions: Array.from(sessions.entries()).map(([id, s]) => ({
            id,
            ...(s.name ? { name: s.name } : {}),
            ...(s.group ? { group: s.group } : {}),
            engine: s.engineProcess?.type ?? "extension",
            ...(s.tabId !== undefined ? { tabId: s.tabId, ownedTab: !!s.createdByTb } : {}),
            createdAt: s.createdAt.toISOString(),
            lastUsedAt: s.lastUsedAt.toISOString(),
          })),
          bridges: listBridges(),
          engines: Array.from(engineProcesses.entries()).map(([key, ep]) => ({
            key,
            type: ep.type,
            pid: ep.pid,
            port: ep.port,
          })),
        });
      }

      // POST /shutdown
      if (method === "POST" && path === "/shutdown") {
        setTimeout(() => {
          cleanup();
          process.exit(0);
        }, 100);
        return Response.json({ ok: true });
      }

      // POST /session/create
      if (method === "POST" && path === "/session/create") {
        const body = (await req.json()) as {
          engine?: EngineType;
          url?: string;
          needsScreenshot?: boolean;
          name?: string;
          group?: string;
          visible?: boolean;
          /** Bind to a tab the user already has open, instead of creating one. */
          tabId?: number;
          /** Which connected Chrome profile to use, if more than one. */
          bridge?: string;
        };
        const engineType = body.engine ?? "auto";
        const needsScreenshot = body.needsScreenshot ?? false;
        const visible = body.visible ?? false;

        // Safety cap: stop runaway tab creation (40 tabs can OOM a machine).
        // Read live so `tb config max-sessions <n>` applies without a restart.
        const maxSessions = loadConfig().maxSessions ?? 25;
        if (sessions.size >= maxSessions) {
          return Response.json(
            {
              error: `Session limit reached (${sessions.size}/${maxSessions}). ` +
                `Close some with 'tb kill <name>' or 'tb stop', or raise the cap with 'tb config max-sessions <n>'.`,
              sessions: sessions.size,
              limit: maxSessions,
            },
            { status: 429 },
          );
        }

        // --- Extension bridge: drive a Chrome the user is already running ---
        // Nothing to launch and no /json/new to call — we bind to a real tab
        // and relay CDP through the extension.
        // Resolve "auto" against config first, so `tb use chrome` (which sets
        // defaultEngine) routes every later command through the bridge.
        const cfgDefault = loadConfig().defaultEngine;
        const resolvedType = engineType === "auto" ? cfgDefault : engineType;
        const wantsBridge = resolvedType === "extension" || body.tabId !== undefined;
        if (wantsBridge) {
          const bridge = getBridge(body.bridge);
          if (!bridge) {
            return Response.json(
              {
                error:
                  "No tb extension is connected. Run 'tb extension install' " +
                  "(one time, no Chrome restart needed).",
              },
              { status: 400 },
            );
          }

          // An explicit tabId means "this tab I already have open" — tb must
          // never close it. A tab tb creates here is tb's to clean up.
          const createdByTb = body.tabId === undefined;
          const tabId = createdByTb
            ? await bridge.createTab(body.url)
            : body.tabId!;

          try {
            await bridge.attach(tabId);
          } catch (err) {
            if (createdByTb) await bridge.closeTab(tabId).catch(() => {});
            return Response.json(
              {
                error:
                  `Could not attach to tab ${tabId}: ${err instanceof Error ? err.message : err}. ` +
                  `Chrome allows one debugger per tab — close DevTools on it and retry.`,
              },
              { status: 400 },
            );
          }

          const bridgeCdp = new BridgeCDPClient(bridge, tabId);
          const bridgeSession = new Session(
            bridgeCdp,
            "chromium",
            { width: config.viewport.width, height: config.viewport.height },
            true, // real browser: skip the UA override and stealth patches
          );
          await bridgeSession.init();
          await bridgeSession.enableEvents();
          bridgeSession.enableDVR();

          // A tab tb just created already went to `url` via chrome.tabs.create;
          // navigating an existing tab is an explicit act the caller asks for.
          if (body.url && !createdByTb) await bridgeSession.goto(body.url);

          const bridgeSessionId = randomId();
          sessions.set(bridgeSessionId, {
            id: bridgeSessionId,
            name: body.name,
            group: body.group,
            session: bridgeSession,
            cdp: bridgeCdp,
            createdAt: new Date(),
            lastUsedAt: new Date(),
            bridge,
            tabId,
            createdByTb,
          });

          return Response.json({
            sessionId: bridgeSessionId,
            name: body.name,
            engine: "extension",
            tabId,
            ownedTab: createdByTb,
            bridge: bridge.label,
            sessions: sessions.size,
            limit: maxSessions,
          });
        }

        const engine = await resolveEngine(engineType, needsScreenshot);

        // Visible sessions get their own engine instance (non-headless Chrome)
        const engineKey = visible ? `${engine.type}-visible` : engine.type;
        let ep = engineProcesses.get(engineKey);
        if (!ep || !isProcessRunning(ep.pid)) {
          ep = await engine.launch({
            width: config.viewport.width,
            height: config.viewport.height,
            headless: !visible,
            insecure: config.insecure,
          });
          engineProcesses.set(engineKey, ep);
        }

        // Create a new target (tab)
        // Lightpanda doesn't support /json/new — connect directly to wsUrl
        // Chromium supports /json/new for multi-tab isolation
        let targetWsUrl: string;
        if (engine.type === "chromium") {
          try {
            const res = await fetch(
              `http://127.0.0.1:${ep.port}/json/new`,
              { method: "PUT" },
            );
            if (res.ok) {
              const target = (await res.json()) as { webSocketDebuggerUrl: string };
              targetWsUrl = target.webSocketDebuggerUrl;
            } else {
              targetWsUrl = ep.wsUrl;
            }
          } catch {
            targetWsUrl = ep.wsUrl;
          }
        } else {
          // Lightpanda: each connection to the main wsUrl gets its own context
          targetWsUrl = ep.wsUrl;
        }

        const cdp = new CDPClient(targetWsUrl);
        await cdp.connect();

        const session = new Session(cdp, engine.type, {
          width: config.viewport.width,
          height: config.viewport.height,
        });
        await session.init();
        await session.enableEvents(); // Always capture events
        session.enableDVR(); // Always log actions

        const sessionId = randomId();

        if (body.url) {
          await session.goto(body.url);
        }

        sessions.set(sessionId, {
          id: sessionId,
          name: body.name,
          group: body.group,
          session,
          engineProcess: ep,
          cdp,
          createdAt: new Date(),
          lastUsedAt: new Date(),
        });

        return Response.json({
          sessionId,
          name: body.name,
          engine: engine.type,
          wsUrl: targetWsUrl,
          sessions: sessions.size,
          limit: maxSessions,
        });
      }

      // POST /session/command
      if (method === "POST" && path === "/session/command") {
        const body = (await req.json()) as {
          sessionId: string;
          method: string;
          params?: Record<string, unknown>;
        };

        // Look up by ID first, then by name
        let managed = sessions.get(body.sessionId);
        if (!managed) {
          for (const [, s] of sessions) {
            if (s.name && s.name === body.sessionId) { managed = s; break; }
          }
        }
        if (!managed) {
          return Response.json(
            { error: `Session not found: ${body.sessionId}` },
            { status: 404 },
          );
        }

        managed.lastUsedAt = new Date();
        const session = managed.session;
        const method_name = body.method as keyof Session;

        // Some CLI method names map to different Session method names in the switch below
        const methodAliases = new Set(["diffDom"]);
        if (typeof (session as any)[method_name] !== "function" && !methodAliases.has(body.method)) {
          return Response.json(
            { error: `Unknown method: ${body.method}` },
            { status: 400 },
          );
        }

        const params = body.params ?? {};
        let result: unknown;

        // Map params to method arguments
        switch (body.method) {
          case "goto":
            result = await session.goto(params.url as string);
            break;
          case "reload":
            await session.reload();
            result = { ok: true };
            break;
          case "back":
            await session.back();
            result = { ok: true };
            break;
          case "forward":
            await session.forward();
            result = { ok: true };
            break;
          case "content":
            result = await session.content();
            break;
          case "text":
            result = await session.text();
            break;
          case "title":
            result = await session.title();
            break;
          case "url":
            result = await session.url();
            break;
          case "isBlocked":
            result = await session.isBlocked();
            break;
          case "waitForSettled":
            result = await session.waitForSettled(params.timeout as number | undefined);
            break;
          case "click":
            await session.click(params.selector as string);
            result = { ok: true };
            break;
          case "clickAt":
            await session.clickAt(
              params.x as number,
              params.y as number,
            );
            result = { ok: true };
            break;
          case "realClick":
            await session.realClick(
              params.x as number,
              params.y as number,
            );
            result = { ok: true };
            break;
          case "type":
            await session.type(
              params.selector as string,
              params.text as string,
            );
            result = { ok: true };
            break;
          case "typeText":
            await session.typeText(params.text as string);
            result = { ok: true };
            break;
          case "keyPress":
            await session.keyPress(params.key as string);
            result = { ok: true };
            break;
          case "select":
            await session.select(
              params.selector as string,
              params.value as string,
            );
            result = { ok: true };
            break;
          case "evaluate":
            result = await session.evaluate(params.expression as string);
            break;
          case "screenshot": {
            const buf = await session.screenshot({
              path: params.path as string | undefined,
              fullPage: params.fullPage as boolean | undefined,
              format: params.format as "png" | "jpeg" | undefined,
              quality: params.quality as number | undefined,
            });
            if (params.path) {
              result = { path: params.path, size: buf.length };
            } else {
              result = {
                base64: buf.toString("base64"),
                size: buf.length,
              };
            }
            break;
          }
          case "querySelector":
            result = await session.querySelector(params.selector as string);
            break;
          case "querySelectorAll":
            result = await session.querySelectorAll(
              params.selector as string,
            );
            break;
          case "waitForSelector":
            await session.waitForSelector(
              params.selector as string,
              params.timeout as number | undefined,
            );
            result = { ok: true };
            break;
          case "cookies":
            result = await session.cookies();
            break;
          case "setCookie":
            await session.setCookie(
              params as {
                name: string;
                value: string;
                domain?: string;
              },
            );
            result = { ok: true };
            break;
          case "clearCookies":
            await session.clearCookies();
            result = { ok: true };
            break;
          case "setViewport":
            await session.setViewport(params.width as number, params.height as number);
            result = { ok: true };
            break;
          case "snapshot":
            result = await session.snapshot(params as any);
            break;
          case "tapRef": {
            const refs = params.refs as any[];
            result = await session.tapRef(params.ref as string, refs);
            break;
          }
          case "findElement": {
            const fRefs = params.refs as any[];
            result = session.findElement(params.query as string, fRefs);
            break;
          }
          case "waitForSettled":
            await session.waitForSettled(params.timeout as number | undefined);
            result = { ok: true };
            break;
          case "enableIntercept":
            await session.enableIntercept(params as any);
            result = { ok: true };
            break;
          case "getCapturedRequests":
            result = session.getCapturedRequests();
            break;
          case "getDVR":
            result = session.getDVR(params.since as number | undefined);
            break;
          case "logDVR":
            session.logDVR(params.type as string, params.data as Record<string, unknown>);
            result = { ok: true };
            break;
          case "getAuthState":
            result = await session.getAuthState();
            break;
          case "getEvents": {
            await session.enableEvents();
            result = session.getEvents();
            break;
          }
          case "takeDomSnapshot":
            result = await session.takeDomSnapshot();
            break;
          case "diffDom":
            result = session.diffDomSnapshots(params.since as number | undefined);
            break;
          case "setAuthState":
            await session.setAuthState(params as any);
            result = { ok: true };
            break;
          case "scroll":
            await session.scroll(
              params.direction as "down" | "up" | undefined,
              params.pixels as number | undefined,
              params.x as number | undefined,
              params.y as number | undefined,
            );
            result = { ok: true };
            break;
          case "startScreencast":
            await session.startScreencast(params as any);
            result = { ok: true };
            break;
          case "stopScreencast":
            await session.stopScreencast();
            result = { ok: true };
            break;
          case "drag":
            await session.drag(
              params.x1 as number, params.y1 as number,
              params.x2 as number, params.y2 as number,
              { steps: params.steps as number | undefined, durationMs: params.durationMs as number | undefined },
            );
            result = { ok: true };
            break;
          case "startRecording":
            result = await session.startRecording(params as any);
            break;
          case "stopRecording":
            result = await session.stopRecording();
            break;
          case "recordingStatus":
            result = session.getRecordingStatus();
            break;
          case "getLatestFrame": {
            const frame = session.getLatestFrame();
            result = frame ?? { base64: null, ts: 0 };
            break;
          }
          default:
            return Response.json(
              { error: `Unknown method: ${body.method}` },
              { status: 400 },
            );
        }

        return Response.json({ result });
      }

      // PATCH /session/:id — rename a session
      if (method === "PATCH" && path.startsWith("/session/")) {
        const sessionId = path.split("/session/")[1];
        const body = (await req.json()) as { name?: string; group?: string };
        let managed = sessions.get(sessionId);
        if (!managed) {
          for (const [, s] of sessions) {
            if (s.name && s.name === sessionId) { managed = s; break; }
          }
        }
        if (managed) {
          if (body.name !== undefined) managed.name = body.name || undefined;
          if (body.group !== undefined) managed.group = body.group || undefined;
        }
        return Response.json({ ok: true });
      }

      // DELETE /session/:id — close a specific session
      if (method === "DELETE" && path.startsWith("/session/")) {
        const sessionId = path.split("/session/")[1];

        // Closing a bridge session always detaches the debugger, but only
        // closes the tab when tb was the one that opened it. Closing a tab the
        // user had open themselves would be the worst bug this feature could
        // have, so the rule lives here and is enforced again in the extension.
        const releaseTab = async (managed: ManagedSession) => {
          await managed.cdp.close().catch(() => {});
          if (managed.bridge && managed.tabId !== undefined && managed.createdByTb) {
            await managed.bridge.closeTab(managed.tabId).catch(() => {});
          }
        };

        // Special: DELETE /session/all — close ALL sessions
        if (sessionId === "all") {
          let count = 0;
          for (const [id, managed] of sessions) {
            await releaseTab(managed);
            sessions.delete(id);
            count++;
          }
          return Response.json({ ok: true, closed: count });
        }

        // Look up by ID or name
        let managed = sessions.get(sessionId);
        let realId = sessionId;
        if (!managed) {
          for (const [id, s] of sessions) {
            if (s.name && s.name === sessionId) { managed = s; realId = id; break; }
          }
        }
        if (managed) {
          await releaseTab(managed);
          sessions.delete(realId);
        }
        return Response.json({ ok: true });
      }

      // GET /bridges — connected Chrome profiles
      if (method === "GET" && path === "/bridges") {
        return Response.json({ bridges: listBridges() });
      }

      // GET /bridge/tabs — tabs open in a connected profile
      if (method === "GET" && path === "/bridge/tabs") {
        const bridge = getBridge(url.searchParams.get("bridge") ?? undefined);
        if (!bridge) {
          return Response.json(
            {
              error:
                "No tb extension is connected. Run 'tb extension install' " +
                "(one time, no Chrome restart needed).",
            },
            { status: 400 },
          );
        }
        return Response.json({ bridge: bridge.label, tabs: await bridge.tabs() });
      }

      // POST /engine/install
      if (method === "POST" && path === "/engine/install") {
        const body = (await req.json()) as { engine: "lightpanda" | "chromium" };
        const engine = await import(`./engines/${body.engine}.js`);
        const EngineClass =
          body.engine === "lightpanda"
            ? engine.LightpandaEngine
            : engine.ChromiumEngine;
        const instance = new EngineClass();
        const installPath = await instance.install();
        return Response.json({ path: installPath });
      }

      // POST /engine/detect
      if (method === "POST" && path === "/engine/detect") {
        const { detectEngines } = await import("./engines/index.js");
        const engines = await detectEngines();
        return Response.json({ engines });
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 500 });
    }
  }

  // The extension dials us, so the listener has to exist before Chrome ever
  // tries. Starting it unconditionally means an already-installed extension
  // reconnects on its own after a daemon restart.
  const bridgePort = startBridgeServer();
  if (bridgePort === null) {
    console.error("Bridge server could not bind — `tb tabs`/`tb attach` will be unavailable.");
  }

  writeDaemonPid(process.pid);

  const server = Bun.serve({
    unix: DAEMON_SOCK,
    fetch: handleRequest,
  });

  console.log(`tb daemon running (pid: ${process.pid}, socket: ${DAEMON_SOCK})`);
}

// --- Daemon client helpers ---

export async function daemonFetch(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const res = await fetch(`http://localhost${path}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
    // @ts-ignore - bun supports unix sockets in fetch
    unix: DAEMON_SOCK,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      (data as { error?: string }).error ?? `Daemon error: ${res.status}`,
    );
  }
  return data;
}

const DAEMON_LOCK = join(dirname(DAEMON_SOCK), "daemon.lock");
/** A spawn that hasn't produced a live socket within this long is presumed dead. */
const LOCK_STALE_MS = 15000;

/** Poll /status until the daemon answers, or give up after `timeout`. */
async function waitForDaemonReady(timeout: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      await daemonFetch("/status");
      return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * Take the spawn lock, atomically. Returns true if we own it.
 *
 * `wx` fails if the file exists, and that check-and-create is a single
 * syscall — which is the whole point. Without it two concurrent `tb`
 * invocations both see "no daemon" and both spawn one, and the loser's
 * sessions live in an orphaned process ("Session not found" at random).
 */
function acquireSpawnLock(): boolean {
  try {
    const fd = openSync(DAEMON_LOCK, "wx");
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch {
    // Someone holds it. Reap it if the holder died or stalled.
    try {
      const holder = parseInt(readFileSync(DAEMON_LOCK, "utf8").trim(), 10);
      const age = Date.now() - statSync(DAEMON_LOCK).mtimeMs;
      if ((holder && !isProcessRunning(holder)) || age > LOCK_STALE_MS) {
        unlinkSync(DAEMON_LOCK);
        return acquireSpawnLock();
      }
    } catch {}
    return false;
  }
}

function releaseSpawnLock(): void {
  try {
    unlinkSync(DAEMON_LOCK);
  } catch {}
}

export async function ensureDaemon(): Promise<void> {
  // Check if already running
  const pid = getDaemonPid();
  if (pid && isProcessRunning(pid)) {
    // Verify socket is responsive
    try {
      await daemonFetch("/status");
      return;
    } catch {
      // Socket dead, restart
    }
  }

  ensureTBDir();

  if (!acquireSpawnLock()) {
    // Another `tb` is starting the daemon right now — wait for it rather than
    // racing a second one into existence.
    if (await waitForDaemonReady(15000)) return;
    throw new Error("Failed to start daemon (another start is in progress)");
  }

  try {
    // Re-check under the lock: the holder we queued behind may have just
    // finished, in which case there is nothing to do.
    try {
      await daemonFetch("/status");
      return;
    } catch {}

    // Clean up stale socket
    if (existsSync(DAEMON_SOCK)) {
      try {
        unlinkSync(DAEMON_SOCK);
      } catch {}
    }

    // Start daemon as background process
    const daemonScript = new URL("./daemon.ts", import.meta.url).pathname;
    const proc = spawn("bun", ["run", daemonScript, "--daemon"], {
      detached: true,
      stdio: "ignore",
      cwd: homedir(),
    });
    proc.unref();

    if (await waitForDaemonReady(10000)) return;
    throw new Error("Failed to start daemon");
  } finally {
    releaseSpawnLock();
  }
}

export async function stopDaemon(): Promise<void> {
  try {
    await daemonFetch("/shutdown", { method: "POST" });
  } catch {}
  removeDaemonPid();
}

// If run directly with --daemon flag, start the daemon
if (process.argv.includes("--daemon")) {
  startDaemon().catch((err) => {
    console.error("Daemon failed:", err);
    process.exit(1);
  });
}
