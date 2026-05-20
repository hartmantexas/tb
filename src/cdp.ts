/**
 * Chrome DevTools Protocol client over WebSocket.
 * Works with both Lightpanda and Chromium — they both speak CDP.
 */

type Callback = (params: Record<string, unknown>) => void;

interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CDPClient {
  private ws: WebSocket | null = null;
  private id = 0;
  private pending = new Map<number, PendingCall>();
  private listeners = new Map<string, Set<Callback>>();
  private connected = false;
  /** CDP session ID — required by lightpanda for all non-Target commands */
  public sessionId: string | null = null;

  constructor(private wsUrl: string) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);

      ws.onopen = () => {
        this.ws = ws;
        this.connected = true;
        resolve();
      };

      ws.onerror = (err) => {
        if (!this.connected) {
          reject(new Error(`CDP connection failed: ${this.wsUrl}`));
        }
      };

      ws.onclose = () => {
        this.connected = false;
        // Reject all pending calls
        for (const [id, call] of this.pending) {
          call.reject(new Error("WebSocket closed"));
          clearTimeout(call.timer);
        }
        this.pending.clear();
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(
            typeof event.data === "string" ? event.data : "",
          );

          if (msg.id !== undefined) {
            // Response to a command
            const call = this.pending.get(msg.id);
            if (call) {
              this.pending.delete(msg.id);
              clearTimeout(call.timer);
              if (msg.error) {
                call.reject(
                  new Error(
                    `CDP error: ${msg.error.message ?? JSON.stringify(msg.error)}`,
                  ),
                );
              } else {
                call.resolve(msg.result);
              }
            }
          } else if (msg.method) {
            // Event
            const callbacks = this.listeners.get(msg.method);
            if (callbacks) {
              for (const cb of callbacks) {
                try {
                  cb(msg.params ?? {});
                } catch {}
              }
            }
          }
        } catch {}
      };
    });
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
    timeout = 30000,
  ): Promise<unknown> {
    if (!this.ws || !this.connected) {
      throw new Error("CDP not connected");
    }

    const id = ++this.id;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method} (${timeout}ms)`));
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });

      const msg: Record<string, unknown> = { id, method, params };
      // Include sessionId for lightpanda (required for non-Target commands)
      if (this.sessionId && !method.startsWith("Target.")) {
        msg.sessionId = this.sessionId;
      }
      this.ws!.send(JSON.stringify(msg));
    });
  }

  on(event: string, callback: Callback): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
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

  async close(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.connected = false;
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }
}
