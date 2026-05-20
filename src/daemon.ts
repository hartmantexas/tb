import { existsSync, unlinkSync } from "fs";
import { spawn } from "child_process";
import { homedir } from "os";
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

interface ManagedSession {
  id: string;
  name?: string;
  session: Session;
  engineProcess: EngineProcess;
  cdp: CDPClient;
  createdAt: Date;
  lastUsedAt: Date;
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
    for (const ep of engineProcesses.values()) {
      ep.kill();
    }
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
            engine: s.engineProcess.type,
            createdAt: s.createdAt.toISOString(),
            lastUsedAt: s.lastUsedAt.toISOString(),
          })),
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
        };
        const engineType = body.engine ?? "auto";
        const needsScreenshot = body.needsScreenshot ?? false;

        const engine = await resolveEngine(engineType, needsScreenshot);

        // Check if we already have a running engine of this type
        let ep = engineProcesses.get(engine.type);
        if (!ep || !isProcessRunning(ep.pid)) {
          ep = await engine.launch({
            width: config.viewport.width,
            height: config.viewport.height,
          });
          engineProcesses.set(engine.type, ep);
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

        const session = new Session(cdp, engine.type);
        await session.init();

        const sessionId = randomId();

        if (body.url) {
          await session.goto(body.url);
        }

        sessions.set(sessionId, {
          id: sessionId,
          name: body.name,
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

        if (typeof (session as any)[method_name] !== "function") {
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
          case "click":
            await session.click(params.selector as string);
            result = { ok: true };
            break;
          case "type":
            await session.type(
              params.selector as string,
              params.text as string,
            );
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
          case "scroll":
            await session.scroll(
              params.direction as "down" | "up" | undefined,
              params.pixels as number | undefined,
            );
            result = { ok: true };
            break;
          default:
            return Response.json(
              { error: `Unknown method: ${body.method}` },
              { status: 400 },
            );
        }

        return Response.json({ result });
      }

      // DELETE /session/:id — close a specific session
      if (method === "DELETE" && path.startsWith("/session/")) {
        const sessionId = path.split("/session/")[1];

        // Special: DELETE /session/all — close ALL sessions
        if (sessionId === "all") {
          let count = 0;
          for (const [id, managed] of sessions) {
            await managed.cdp.close().catch(() => {});
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
          await managed.cdp.close();
          sessions.delete(realId);
        }
        return Response.json({ ok: true });
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

  // Wait for daemon to be ready
  const start = Date.now();
  while (Date.now() - start < 10000) {
    try {
      await daemonFetch("/status");
      return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Failed to start daemon");
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
