import type { ChildProcess } from "child_process";

export type EngineType = "lightpanda" | "chromium" | "auto";

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
}

export interface Engine {
  type: "lightpanda" | "chromium";
  detect(): Promise<EngineInfo | null>;
  install(): Promise<string>;
  launch(options?: LaunchOptions): Promise<EngineProcess>;
}
