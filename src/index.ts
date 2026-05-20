/**
 * tiny-browser — Agent-first browser. Lightpanda for speed, Chromium for pixels.
 *
 * Usage:
 *   import { tb } from 'tiny-browser'
 *
 *   const page = await tb.open('http://localhost:3000')
 *   console.log(await page.title())
 *
 *   await page.click('button.submit')
 *   const screenshot = await page.screenshot({ path: './shot.png' })
 *
 *   await page.close()
 *   await tb.stop()
 */

import { ensureDaemon, daemonFetch, stopDaemon } from "./daemon.js";

export interface TBPage {
  /** Navigate to a URL */
  goto(url: string): Promise<{ url: string; status: number }>;
  /** Take a screenshot (auto-switches to Chromium engine) */
  screenshot(options?: {
    path?: string;
    fullPage?: boolean;
    format?: "png" | "jpeg";
    quality?: number;
  }): Promise<Buffer>;
  /** Click an element by CSS selector */
  click(selector: string): Promise<void>;
  /** Type text into an element */
  type(selector: string, text: string): Promise<void>;
  /** Select a dropdown value */
  select(selector: string, value: string): Promise<void>;
  /** Evaluate JavaScript in the page context */
  evaluate<T = unknown>(expression: string): Promise<T>;
  /** Get the full page HTML */
  content(): Promise<string>;
  /** Get the visible text content */
  text(): Promise<string>;
  /** Get the page title */
  title(): Promise<string>;
  /** Get the current URL */
  url(): Promise<string>;
  /** Wait for an element to appear */
  waitForSelector(selector: string, timeout?: number): Promise<void>;
  /** Query a single element, returns description or null */
  querySelector(selector: string): Promise<string | null>;
  /** Query all matching elements */
  querySelectorAll(selector: string): Promise<string[]>;
  /** Get all cookies */
  cookies(): Promise<
    Array<{ name: string; value: string; domain: string; path: string }>
  >;
  /** Set a cookie */
  setCookie(cookie: {
    name: string;
    value: string;
    domain?: string;
  }): Promise<void>;
  /** Clear all cookies */
  clearCookies(): Promise<void>;
  /** Close this page/session */
  close(): Promise<void>;
}

export interface TBOptions {
  engine?: "lightpanda" | "chromium" | "auto";
  width?: number;
  height?: number;
}

async function sendCommand(
  sessionId: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const result = (await daemonFetch("/session/command", {
    method: "POST",
    body: { sessionId, method, params },
  })) as { result: unknown };
  return result.result;
}

function createPage(sessionId: string): TBPage {
  return {
    async goto(url: string) {
      return (await sendCommand(sessionId, "goto", { url })) as {
        url: string;
        status: number;
      };
    },

    async screenshot(options = {}) {
      // Screenshots need chromium — if current session is lightpanda,
      // the daemon will throw an error. User should use --engine chromium.
      const result = (await sendCommand(sessionId, "screenshot", options)) as {
        base64?: string;
        path?: string;
        size: number;
      };
      if (result.base64) {
        return Buffer.from(result.base64, "base64");
      }
      // If path was provided, read the file
      if (result.path) {
        const { readFileSync } = await import("fs");
        return readFileSync(result.path);
      }
      return Buffer.alloc(0);
    },

    async click(selector: string) {
      await sendCommand(sessionId, "click", { selector });
    },

    async type(selector: string, text: string) {
      await sendCommand(sessionId, "type", { selector, text });
    },

    async select(selector: string, value: string) {
      await sendCommand(sessionId, "select", { selector, value });
    },

    async evaluate<T = unknown>(expression: string): Promise<T> {
      return (await sendCommand(sessionId, "evaluate", {
        expression,
      })) as T;
    },

    async content(): Promise<string> {
      return (await sendCommand(sessionId, "content")) as string;
    },

    async text(): Promise<string> {
      return (await sendCommand(sessionId, "text")) as string;
    },

    async title(): Promise<string> {
      return (await sendCommand(sessionId, "title")) as string;
    },

    async url(): Promise<string> {
      return (await sendCommand(sessionId, "url")) as string;
    },

    async waitForSelector(selector: string, timeout?: number) {
      await sendCommand(sessionId, "waitForSelector", {
        selector,
        timeout,
      });
    },

    async querySelector(selector: string) {
      return (await sendCommand(sessionId, "querySelector", {
        selector,
      })) as string | null;
    },

    async querySelectorAll(selector: string) {
      return (await sendCommand(sessionId, "querySelectorAll", {
        selector,
      })) as string[];
    },

    async cookies() {
      return (await sendCommand(sessionId, "cookies")) as Array<{
        name: string;
        value: string;
        domain: string;
        path: string;
      }>;
    },

    async setCookie(cookie) {
      await sendCommand(sessionId, "setCookie", cookie);
    },

    async clearCookies() {
      await sendCommand(sessionId, "clearCookies");
    },

    async close() {
      await daemonFetch(`/session/${sessionId}`, { method: "DELETE" });
    },
  };
}

export const tb = {
  /**
   * Open a URL and return a page handle.
   * Starts the daemon and browser engine automatically.
   */
  async open(url: string, options: TBOptions = {}): Promise<TBPage> {
    await ensureDaemon();
    const result = (await daemonFetch("/session/create", {
      method: "POST",
      body: {
        engine: options.engine ?? "auto",
        url,
      },
    })) as { sessionId: string; engine: string };

    return createPage(result.sessionId);
  },

  /**
   * Launch a browser session without navigating.
   */
  async launch(options: TBOptions = {}): Promise<TBPage> {
    await ensureDaemon();
    const result = (await daemonFetch("/session/create", {
      method: "POST",
      body: {
        engine: options.engine ?? "auto",
      },
    })) as { sessionId: string; engine: string };

    return createPage(result.sessionId);
  },

  /**
   * Stop the daemon and all browser engines.
   */
  async stop(): Promise<void> {
    await stopDaemon();
  },

  /**
   * Get daemon status.
   */
  async status(): Promise<{
    running: boolean;
    uptime: number;
    sessions: Array<{ id: string; engine: string }>;
  }> {
    try {
      await ensureDaemon();
      return (await daemonFetch("/status")) as {
        running: boolean;
        uptime: number;
        sessions: Array<{ id: string; engine: string }>;
      };
    } catch {
      return { running: false, uptime: 0, sessions: [] };
    }
  },
};

export default tb;
