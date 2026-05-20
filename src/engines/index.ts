import { LightpandaEngine } from "./lightpanda.js";
import { ChromiumEngine } from "./chromium.js";
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

  // Auto mode: ALWAYS prefer lightpanda.
  // Lightpanda computes CSS and we extract computed styles for screenshots.
  // Chromium is only used when explicitly requested via --engine chromium.
  const lpInfo = await engines.lightpanda.detect();
  if (lpInfo) return engines.lightpanda;

  // Fall back to chromium only if lightpanda isn't installed
  const chromiumInfo = await engines.chromium.detect();
  if (chromiumInfo) return engines.chromium;

  throw new Error(
    "No browser engine found. Run: tb install\n" +
      "  This will install Lightpanda (recommended, tiny) or Chromium.",
  );
}
