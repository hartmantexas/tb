import { existsSync } from "fs";
import { join } from "path";

/**
 * Platform/arch suffix for prebuilt Blitz binaries, matching the names produced
 * by the release workflow and `tb install` (e.g. "x86_64-linux", "aarch64-macos").
 */
export function blitzSuffix(): string {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const os = process.platform === "darwin" ? "macos" : "linux";
  return `${arch}-${os}`;
}

/** Absolute path to the render-engine directory (repo-root/render-engine). */
export function renderEngineDir(): string {
  return join(new URL(".", import.meta.url).pathname, "..", "render-engine");
}

/**
 * Resolve the Blitz binary to use, in priority order:
 *   1. a freshly built binary (render-engine/target/release/tb-render)
 *   2. a committed prebuilt for this platform (render-engine/prebuilt/tb-render-<suffix>)
 * Returns null if neither exists (caller falls back to the approximation path).
 */
export function resolveBlitzPath(): string | null {
  const dir = renderEngineDir();
  const built = join(dir, "target", "release", "tb-render");
  if (existsSync(built)) return built;
  const prebuilt = join(dir, "prebuilt", `tb-render-${blitzSuffix()}`);
  if (existsSync(prebuilt)) return prebuilt;
  return null;
}
