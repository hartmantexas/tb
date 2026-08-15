/**
 * The extension bridge — tb's transport into a Chrome the user is already running.
 *
 * Everything else in tb launches its own browser and speaks CDP to it over a
 * WebSocket. That can't reach an existing Chrome: the debug port only opens at
 * startup, and Chrome refuses to start a second process against a user-data-dir
 * already in use, so "attach to my logged-in browser" would mean quitting it
 * first.
 *
 * `chrome.debugger.sendCommand` *is* CDP, exposed from inside a running Chrome.
 * So the tb extension attaches to a tab and relays raw CDP both ways, and
 * `BridgeCDPClient` below makes that relay look exactly like a socket to
 * `Session` — which is why all of session.ts works unchanged over it.
 *
 * The extension dials us, not the other way round: MV3 service workers have no
 * listening socket, and they get suspended and respawned at Chrome's
 * discretion. Reconnection is therefore normal operation, not an error path.
 */

import { writeFileSync, existsSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import type { CDPLike, Callback } from "./cdp.js";
import { TB_DIR, ensureTBDir } from "./utils.js";

/** Where the daemon records the live bridge port for the CLI to read. */
export const BRIDGE_FILE = join(TB_DIR, "bridge.json");

/**
 * Ports the extension will try, in order. Hardcoded on both sides: the
 * extension has no way to be told a port out of band before it first connects.
 */
export const BRIDGE_PORTS = [17373, 17374, 17375];

export interface TabInfo {
  tabId: number;
  windowId: number;
  title: string;
  url: string;
  active: boolean;
  /** True if tb opened this tab, and therefore may close it again. */
  createdByTb?: boolean;
}

interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type OutboundMessage = Record<string, unknown> & { type: string };

/** One connected extension — i.e. one Chrome profile. */
export class Bridge {
  private id = 0;
  private pending = new Map<number, PendingCall>();
  /** tabId → listeners, so CDP events reach the right BridgeCDPClient. */
  private tabListeners = new Map<number, Set<(method: string, params: Record<string, unknown>) => void>>();
  /** Tabs tb opened itself — the only ones it's allowed to close. */
  readonly ownedTabs = new Set<number>();

  public label = "chrome";
  public connectedAt = new Date();
  /** Set once the socket is gone — Chrome quit, or the extension was removed. */
  private dead = false;

  constructor(public ws: { send: (data: string) => void; close: () => void }) {}

  get isAlive(): boolean {
    return !this.dead;
  }

  /** Send a request and wait for the extension's reply. */
  request(msg: OutboundMessage, timeout = 30000): Promise<unknown> {
    // Fail fast rather than waiting out the timeout. Without this, closing a
    // session after Chrome quit blocks for the full 30s and the CLI's socket
    // gives up first — `tb kill-all` reporting a connection error while the
    // daemon sat there fine.
    if (this.dead) {
      return Promise.reject(new Error("Chrome is no longer connected to tb"));
    }
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Bridge timeout: ${msg.type} (${timeout}ms)`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ ...msg, id }));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Feed one decoded message from the extension. */
  handle(msg: Record<string, unknown>): void {
    const type = msg.type as string;

    if (type === "result" || type === "error") {
      const call = this.pending.get(msg.id as number);
      if (!call) return;
      this.pending.delete(msg.id as number);
      clearTimeout(call.timer);
      if (type === "error") call.reject(new Error(String(msg.error)));
      else call.resolve(msg.result);
      return;
    }

    if (type === "event") {
      const cbs = this.tabListeners.get(msg.tabId as number);
      if (!cbs) return;
      for (const cb of cbs) {
        try {
          cb(msg.method as string, (msg.params as Record<string, unknown>) ?? {});
        } catch {}
      }
      return;
    }

    if (type === "detached") {
      // Chrome tore the debugger off (tab closed, DevTools opened, user hit
      // "Cancel" on the infobar). Tell the clients rather than let their next
      // command hang until it times out.
      const cbs = this.tabListeners.get(msg.tabId as number);
      if (cbs) for (const cb of cbs) { try { cb("__detached", {}); } catch {} }
      this.tabListeners.delete(msg.tabId as number);
      this.ownedTabs.delete(msg.tabId as number);
    }
  }

  subscribe(tabId: number, cb: (method: string, params: Record<string, unknown>) => void): void {
    if (!this.tabListeners.has(tabId)) this.tabListeners.set(tabId, new Set());
    this.tabListeners.get(tabId)!.add(cb);
  }

  unsubscribe(tabId: number, cb: (method: string, params: Record<string, unknown>) => void): void {
    this.tabListeners.get(tabId)?.delete(cb);
  }

  /** Fail every in-flight call — the extension went away. */
  fail(reason: string): void {
    this.dead = true;
    for (const [, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(new Error(reason));
    }
    this.pending.clear();
    for (const [, cbs] of this.tabListeners) {
      for (const cb of cbs) { try { cb("__detached", {}); } catch {} }
    }
    this.tabListeners.clear();
  }

  // --- Tab operations ---

  async tabs(): Promise<TabInfo[]> {
    const r = (await this.request({ type: "tabs" })) as { tabs: TabInfo[] };
    return (r.tabs ?? []).map((t) => ({ ...t, createdByTb: this.ownedTabs.has(t.tabId) }));
  }

  async createTab(url?: string): Promise<number> {
    const r = (await this.request({ type: "createTab", url })) as { tabId: number };
    this.ownedTabs.add(r.tabId);
    return r.tabId;
  }

  async attach(tabId: number): Promise<void> {
    await this.request({ type: "attach", tabId });
  }

  async detach(tabId: number): Promise<void> {
    await this.request({ type: "detach", tabId }).catch(() => {});
  }

  async closeTab(tabId: number): Promise<void> {
    await this.request({ type: "closeTab", tabId }).catch(() => {});
    this.ownedTabs.delete(tabId);
  }
}

// --- Registry ---

const bridges = new Map<string, Bridge>();
let bridgeServer: { stop: () => void; port: number } | null = null;

export function listBridges(): Array<{ key: string; label: string; connectedAt: string }> {
  return Array.from(bridges.entries()).map(([key, b]) => ({
    key,
    label: b.label,
    connectedAt: b.connectedAt.toISOString(),
  }));
}

/**
 * Pick a connected bridge. `key` matches the registry key or a substring of the
 * profile label, so `tb --bridge money` is enough to disambiguate.
 */
export function getBridge(key?: string): Bridge | null {
  if (bridges.size === 0) return null;
  if (!key) return bridges.values().next().value ?? null;
  const exact = bridges.get(key);
  if (exact) return exact;
  const needle = key.toLowerCase();
  for (const [k, b] of bridges) {
    if (k.toLowerCase().includes(needle) || b.label.toLowerCase().includes(needle)) return b;
  }
  return null;
}

/** Start the WebSocket server the extension dials into. Idempotent. */
export function startBridgeServer(): number | null {
  if (bridgeServer) return bridgeServer.port;

  for (const port of BRIDGE_PORTS) {
    try {
      const server = Bun.serve<{ key: string }, {}>({
        port,
        hostname: "127.0.0.1", // never expose the user's browser off-box
        fetch(req, server) {
          const key = `b${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
          if (server.upgrade(req, { data: { key } })) return undefined as unknown as Response;
          return new Response("tb bridge", { status: 200 });
        },
        websocket: {
          open(ws) {
            bridges.set(ws.data.key, new Bridge(ws));
          },
          message(ws, raw) {
            const bridge = bridges.get(ws.data.key);
            if (!bridge) return;
            let msg: Record<string, unknown>;
            try {
              msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
            } catch {
              return;
            }
            if (msg.type === "hello") {
              bridge.label = (msg.email as string) || (msg.profile as string) || "chrome";
              return;
            }
            bridge.handle(msg);
          },
          close(ws) {
            const bridge = bridges.get(ws.data.key);
            if (bridge) bridge.fail("Extension disconnected");
            bridges.delete(ws.data.key);
          },
        },
      });
      bridgeServer = { stop: () => server.stop(true), port };
      ensureTBDir();
      writeFileSync(BRIDGE_FILE, JSON.stringify({ port, pid: process.pid }));
      return port;
    } catch {
      // Port in use — try the next one the extension knows about.
    }
  }
  return null;
}

export function stopBridgeServer(): void {
  bridgeServer?.stop();
  bridgeServer = null;
  bridges.clear();
  try {
    unlinkSync(BRIDGE_FILE);
  } catch {}
}

/** The port the running daemon's bridge is on, for CLI-side reporting. */
export function readBridgePort(): number | null {
  try {
    if (!existsSync(BRIDGE_FILE)) return null;
    return JSON.parse(readFileSync(BRIDGE_FILE, "utf-8")).port ?? null;
  } catch {
    return null;
  }
}

// --- CDP transport ---

/**
 * A `CDPLike` bound to one tab, relayed through the extension.
 *
 * `Session` cannot tell this apart from a real socket, which is the whole
 * point — the only visible difference is that `sessionId` stays null (that
 * field exists for Lightpanda's handshake, which never runs here).
 */
export class BridgeCDPClient implements CDPLike {
  public sessionId: string | null = null;
  private listeners = new Map<string, Set<Callback>>();
  private closed = false;
  private detached = false;

  private onEvent = (method: string, params: Record<string, unknown>): void => {
    if (method === "__detached") {
      this.detached = true;
      return;
    }
    const cbs = this.listeners.get(method);
    if (!cbs) return;
    for (const cb of cbs) {
      try {
        cb(params);
      } catch {}
    }
  };

  constructor(
    private bridge: Bridge,
    public readonly tabId: number,
  ) {
    this.bridge.subscribe(tabId, this.onEvent);
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
    timeout = 30000,
  ): Promise<unknown> {
    if (this.closed) throw new Error("CDP not connected");
    if (this.detached) {
      throw new Error(
        `Debugger detached from tab ${this.tabId} — the tab was closed, DevTools was opened on it, or you dismissed the debugging banner.`,
      );
    }
    return this.bridge.request({ type: "cdp", tabId: this.tabId, method, params }, timeout);
  }

  on(event: string, callback: Callback): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(callback);
  }

  off(event: string, callback: Callback): void {
    this.listeners.get(event)?.delete(callback);
  }

  once(event: string): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const handler: Callback = (params) => {
        this.off(event, handler);
        resolve(params);
      };
      this.on(event, handler);
    });
  }

  /**
   * Detach, but never close the tab — `tb kill` decides that separately, and
   * only for tabs tb opened. Closing a tab the user had open would be the one
   * unforgivable bug in this feature.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.bridge.unsubscribe(this.tabId, this.onEvent);
    await this.bridge.detach(this.tabId);
  }

  get isConnected(): boolean {
    return !this.closed && !this.detached && this.bridge.isAlive;
  }
}
