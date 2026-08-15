import type { ChildProcess } from "child_process";

/**
 * "extension" is not a launchable engine — it's the tb extension bridge into a
 * Chrome the user is already running. It has no process, so the daemon handles
 * it before it ever reaches `resolveEngine`.
 */
export type EngineType = "lightpanda" | "chromium" | "extension" | "auto";

export interface EngineInfo {
  type: "lightpanda" | "chromium";
  path: string;
  version: string;
  installed: boolean;
}

export interface EngineProcess {
  type: "lightpanda" | "chromium";
  process: ChildProcess;
  wsUrl: string;
  port: number;
  pid: number;
  kill: () => void;
}

export interface LaunchOptions {
  headless?: boolean;
  port?: number;
  width?: number;
  height?: number;
  userDataDir?: string;
  /** Ignore TLS certificate errors (for TLS-intercepting proxies / self-signed certs). */
  insecure?: boolean;
}

export interface Engine {
  type: "lightpanda" | "chromium";
  detect(): Promise<EngineInfo | null>;
  install(): Promise<string>;
  launch(options?: LaunchOptions): Promise<EngineProcess>;
}
