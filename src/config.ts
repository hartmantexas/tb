import { existsSync, readFileSync, writeFileSync } from "fs";
import { CONFIG_FILE, ensureTBDir } from "./utils.js";

export type EngineType = "lightpanda" | "chromium" | "auto";

export interface TBConfig {
  defaultEngine: EngineType;
  chromiumPath?: string;
  lightpandaPath?: string;
  daemonTimeout: number;
  viewport: { width: number; height: number };
  screenshotDir: string;
  sessionPersistence: boolean;
  userDataDir?: string;
}

const DEFAULTS: TBConfig = {
  defaultEngine: "lightpanda",
  daemonTimeout: 30 * 60 * 1000,
  viewport: { width: 1280, height: 720 },
  screenshotDir: "/tmp",
  sessionPersistence: false,
};

export function loadConfig(): TBConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
      return { ...DEFAULTS, ...raw };
    }
  } catch {}
  return { ...DEFAULTS };
}

export function saveConfig(partial: Partial<TBConfig>): void {
  ensureTBDir();
  const current = loadConfig();
  const merged = { ...current, ...partial };
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
}
