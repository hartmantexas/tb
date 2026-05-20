import { execSync, spawn } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Engine, EngineInfo, EngineProcess, LaunchOptions } from "./types.js";
import { ENGINES_DIR, findPort, waitForPort } from "../utils.js";

const SEARCH_PATHS = [
  join(ENGINES_DIR, "lightpanda"),
  "/opt/homebrew/bin/lightpanda",
  "/usr/local/bin/lightpanda",
];

export class LightpandaEngine implements Engine {
  type = "lightpanda" as const;

  async detect(): Promise<EngineInfo | null> {
    // Check known paths
    for (const p of SEARCH_PATHS) {
      if (existsSync(p)) {
        const version = this.getVersion(p);
        if (version)
          return { type: "lightpanda", path: p, version, installed: true };
      }
    }
    // Check PATH
    try {
      const path = execSync("which lightpanda", { encoding: "utf-8" }).trim();
      if (path) {
        const version = this.getVersion(path) ?? "unknown";
        return { type: "lightpanda", path, version, installed: true };
      }
    } catch {}
    return null;
  }

  private getVersion(path: string): string | null {
    try {
      const out = execSync(`"${path}" version 2>&1 || "${path}" --version 2>&1`, {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      // Extract version from output
      const match = out.match(/(\d+\.\d+[\.\d]*)/);
      return match ? match[1] : out.split("\n")[0].slice(0, 50);
    } catch {
      return null;
    }
  }

  async install(): Promise<string> {
    const { mkdirSync, createWriteStream } = await import("fs");
    const { platform, arch } = await import("os");
    const { pipeline } = await import("stream/promises");

    const plat = platform();
    const ar = arch();
    let binaryName: string;
    if (plat === "darwin" && ar === "arm64") binaryName = "lightpanda-aarch64-macos";
    else if (plat === "darwin") binaryName = "lightpanda-x86_64-macos";
    else if (plat === "linux" && ar === "arm64") binaryName = "lightpanda-aarch64-linux";
    else if (plat === "linux") binaryName = "lightpanda-x86_64-linux";
    else throw new Error(`Unsupported platform: ${plat}-${ar}`);

    console.log("Downloading Lightpanda...");

    // Get latest release
    const releaseRes = await fetch(
      "https://api.github.com/repos/lightpanda-io/browser/releases/latest",
    );
    const release = (await releaseRes.json()) as {
      tag_name: string;
      assets: Array<{ name: string; browser_download_url: string }>;
    };

    const asset = release.assets.find((a) => a.name === binaryName);
    if (!asset) throw new Error(`No binary for ${binaryName} in release ${release.tag_name}`);

    const destPath = join(ENGINES_DIR, "lightpanda");
    if (!existsSync(ENGINES_DIR)) mkdirSync(ENGINES_DIR, { recursive: true });

    const dlRes = await fetch(asset.browser_download_url);
    if (!dlRes.ok || !dlRes.body) throw new Error(`Download failed: ${dlRes.status}`);

    const fileStream = createWriteStream(destPath);
    // @ts-ignore
    await pipeline(dlRes.body as any, fileStream);

    execSync(`chmod +x "${destPath}"`);
    console.log(`Lightpanda ${release.tag_name} installed at ${destPath}`);
    return destPath;
  }

  async launch(options: LaunchOptions = {}): Promise<EngineProcess> {
    const info = await this.detect();
    if (!info) throw new Error("Lightpanda not found. Run: tb install lightpanda");

    const port = options.port ?? (await findPort());
    const args = ["serve", "--host", "127.0.0.1", "--port", String(port)];

    const proc = spawn(info.path, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      cwd: join(homedir(), ".tb"),
    });

    // Collect stderr for debugging
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      console.error(`Lightpanda process error: ${err.message}`);
    });

    // Wait for CDP to be ready
    try {
      await waitForPort(port, "127.0.0.1", 10000);
    } catch {
      proc.kill();
      throw new Error(
        `Lightpanda failed to start on port ${port}. stderr: ${stderr.slice(0, 500)}`,
      );
    }

    // Get WebSocket URL
    let wsUrl: string;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      const data = (await res.json()) as { webSocketDebuggerUrl?: string };
      wsUrl =
        data.webSocketDebuggerUrl ?? `ws://127.0.0.1:${port}/devtools/browser`;
    } catch {
      wsUrl = `ws://127.0.0.1:${port}/devtools/browser`;
    }

    return {
      type: "lightpanda",
      process: proc,
      wsUrl,
      port,
      pid: proc.pid!,
      kill: () => {
        try {
          proc.kill("SIGTERM");
        } catch {}
      },
    };
  }
}
