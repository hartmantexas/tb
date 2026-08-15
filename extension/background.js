/**
 * tb bridge — relays CDP between the tb daemon and this Chrome profile.
 *
 * chrome.debugger.sendCommand IS the Chrome DevTools Protocol, so this file is
 * mostly a pipe: JSON in from a WebSocket, chrome.* call out, reply back. That
 * is what lets tb drive a browser it didn't launch.
 *
 * Two things about MV3 shape the code:
 *   1. Service workers get suspended and respawned at Chrome's discretion, so
 *      reconnecting is normal operation. All listeners are registered at top
 *      level, which is the only place Chrome guarantees they survive a respawn.
 *   2. Nothing can dial *us*. We dial the daemon.
 */

// Must match BRIDGE_PORTS in src/bridge.ts — hardcoded on both sides because
// there is no channel to tell the extension a port before it first connects.
const PORTS = [17373, 17374, 17375];

let ws = null;
let portIndex = 0;
let backoffMs = 500;
let connecting = false;

/** tabIds we currently hold a chrome.debugger attachment on. */
const attached = new Set();
/** tabIds tb opened itself — the only ones tb is allowed to close. */
const owned = new Set();

// --- chrome.* promise wrappers -----------------------------------------------
// The callback forms set chrome.runtime.lastError instead of throwing, and an
// unchecked lastError is both a silent failure here and a console warning.

function debuggerAttach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const err = chrome.runtime.lastError;
      // Idempotent: re-attaching to a tab we already hold is a no-op, not a
      // failure. Anything else (DevTools open, chrome:// page) is real.
      if (err && !/already attached/i.test(err.message)) return reject(new Error(err.message));
      attached.add(tabId);
      resolve();
    });
  });
}

function debuggerDetach(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      void chrome.runtime.lastError;
      attached.delete(tabId);
      resolve();
    });
  });
}

function debuggerSend(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(result === undefined ? {} : result);
    });
  });
}

function queryTabs() {
  return new Promise((resolve) => {
    chrome.tabs.query({}, (tabs) => {
      void chrome.runtime.lastError;
      resolve(tabs || []);
    });
  });
}

function createTab(url, active) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url: url || "about:blank", active: !!active }, (tab) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      owned.add(tab.id);
      resolve(tab.id);
    });
  });
}

function removeTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.remove(tabId, () => {
      void chrome.runtime.lastError;
      owned.delete(tabId);
      resolve();
    });
  });
}

function profileEmail() {
  return new Promise((resolve) => {
    try {
      chrome.identity.getProfileUserInfo({ accountStatus: "ANY" }, (info) => {
        void chrome.runtime.lastError;
        resolve((info && info.email) || "");
      });
    } catch {
      resolve("");
    }
  });
}

// --- Transport ---------------------------------------------------------------

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

async function handle(msg) {
  const { id, type } = msg;
  try {
    let result;
    switch (type) {
      case "cdp":
        // Attach lazily: the daemon may be resuming a session whose attachment
        // died with a previous service-worker generation.
        if (!attached.has(msg.tabId)) await debuggerAttach(msg.tabId);
        result = await debuggerSend(msg.tabId, msg.method, msg.params);
        break;

      case "tabs": {
        const tabs = await queryTabs();
        result = {
          tabs: tabs
            // chrome.debugger cannot attach to these, so offering them as
            // targets would only produce a confusing failure later.
            .filter((t) => t.url && !/^(chrome|devtools|chrome-extension|edge):/i.test(t.url))
            .map((t) => ({
              tabId: t.id,
              windowId: t.windowId,
              title: t.title || "",
              url: t.url || "",
              active: !!t.active,
            })),
        };
        break;
      }

      case "createTab":
        result = { tabId: await createTab(msg.url, msg.active) };
        break;

      case "attach":
        await debuggerAttach(msg.tabId);
        result = { ok: true };
        break;

      case "detach":
        await debuggerDetach(msg.tabId);
        result = { ok: true };
        break;

      case "closeTab":
        // Guard in depth: the daemon already refuses to close tabs it did not
        // open, and so do we.
        if (!owned.has(msg.tabId)) throw new Error("Refusing to close a tab tb did not open");
        await removeTab(msg.tabId);
        result = { ok: true };
        break;

      case "ping":
        result = { ok: true };
        break;

      default:
        throw new Error(`Unknown message type: ${type}`);
    }
    send({ type: "result", id, result });
  } catch (err) {
    send({ type: "error", id, error: err && err.message ? err.message : String(err) });
  }
}

function connect() {
  if (connecting || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) return;
  connecting = true;

  const port = PORTS[portIndex % PORTS.length];
  let socket;
  try {
    socket = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch {
    connecting = false;
    portIndex++;
    return scheduleReconnect();
  }

  socket.onopen = async () => {
    ws = socket;
    connecting = false;
    backoffMs = 500;
    const [email, tabs] = await Promise.all([profileEmail(), queryTabs()]);
    send({ type: "hello", email, tabCount: tabs.length });
  };

  socket.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handle(msg);
  };

  socket.onclose = () => {
    if (ws === socket) ws = null;
    connecting = false;
    // Daemon may simply not be up, or may be on another port in the range.
    portIndex++;
    scheduleReconnect();
  };

  socket.onerror = () => {
    try {
      socket.close();
    } catch {}
  };
}

function scheduleReconnect() {
  setTimeout(connect, backoffMs);
  backoffMs = Math.min(backoffMs * 2, 10000);
}

// --- Listeners (top level — required for service-worker respawn) -------------

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined) return;
  send({ type: "event", tabId: source.tabId, method, params: params || {} });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return;
  attached.delete(source.tabId);
  send({ type: "detached", tabId: source.tabId, reason });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  owned.delete(tabId);
  send({ type: "detached", tabId, reason: "tab_closed" });
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

// Keep-alive. Chrome 116+ resets the service worker's idle timer on WebSocket
// activity, so the ping does double duty: it holds the worker open and it
// notices a half-open socket. The alarm is the backstop for when the worker is
// torn down anyway — onAlarm respawns it and reconnects.
chrome.alarms.create("tb-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  if (ws && ws.readyState === WebSocket.OPEN) send({ type: "keepalive" });
  else connect();
});

setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) send({ type: "keepalive" });
}, 20000);

connect();
