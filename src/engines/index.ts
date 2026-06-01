import { LightpandaEngine } from "./lightpanda.js";
import { ChromiumEngine } from "./chromium.js";
import { loadConfig } from "../config.js";
import type { Engine, EngineInfo, EngineType } from "./types.js";

export type { Engine, EngineInfo, EngineProcess, EngineType, LaunchOptions } from "./types.js";

const engines = {
  lightpanda: new LightpandaEngine(),
  chromium: new ChromiumEngine(),
};

export function getEngine(type: "lightpanda" | "chromium"): Engine {
  return engines[type];
}

export async function detectEngines(): Promise<EngineInfo[]> {
  const results: EngineInfo[] = [];
  for (const engine of Object.values(engines)) {
    const info = await engine.detect();
    if (info) results.push(info);
  }
  return results;
}

export async function resolveEngine(
  preferred: EngineType = "auto",
  _needsScreenshot = false,
): Promise<Engine> {
  if (preferred === "lightpanda" || preferred === "chromium") {
    const engine = engines[preferred];
    const info = await engine.detect();
    if (!info) {
      throw new Error(
        `${preferred} not found. Run: tb install ${preferred}`,
      );
    }
    return engine;
  }

  // Auto mode: use config's defaultEngine, fall back to the other if unavailable
  const config = loadConfig();
  const defaultEngine = config.defaultEngine === "auto" ? "chromium" : config.defaultEngine;
  const fallback = defaultEngine === "chromium" ? "lightpanda" : "chromium";

  const defaultInfo = await engines[defaultEngine].detect();
  if (defaultInfo) return engines[defaultEngine];

  const fallbackInfo = await engines[fallback].detect();
  if (fallbackInfo) return engines[fallback];

  throw new Error(
    "No browser engine found. Run: tb install\n" +
      "  This will install Lightpanda (recommended, tiny) or Chromium.",
  );
}
