import { execSync, spawn } from "child_process";
import { existsSync, mkdirSync, createWriteStream } from "fs";
import { join } from "path";
import { tmpdir, platform, arch } from "os";
import { pipeline } from "stream/promises";
import type { Engine, EngineInfo, EngineProcess, LaunchOptions } from "./types.js";
import { ENGINES_DIR, findPort, waitForPort, randomId } from "../utils.js";

const CHROMIUM_DIR = join(ENGINES_DIR, "chromium");

// Search order for detecting a usable chromium binary
const CANDIDATES: string[] = [
  join(CHROMIUM_DIR, "chrome-headless-shell"),
  join(CHROMIUM_DIR, "chrome"),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Arc.app/Contents/MacOS/Arc",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

export class ChromiumEngine implements Engine {
  type = "chromium" as const;

  async detect(): Promise<EngineInfo | null> {
    // Check known paths
    for (const p of CANDIDATES) {
      if (existsSync(p)) {
        const version = this.getVersion(p);
        if (version !== null) {
          return { type: "chromium", path: p, version, installed: true };
        }
      }
    }

    // Check PATH
    for (const bin of ["chromium", "google-chrome", "chrome"]) {
      try {
        const path = execSync(`which ${bin}`, { encoding: "utf-8" }).trim();
        if (path && existsSync(path)) {
          const version = this.getVersion(path) ?? "unknown";
          return { type: "chromium", path, version, installed: true };
        }
      } catch {}
    }

    // Check playwright installs
    try {
      const home = process.env.HOME ?? "";
      const pwDir = join(home, ".cache", "ms-playwright");
      if (existsSync(pwDir)) {
        const { readdirSync } = await import("fs");
        const dirs = readdirSync(pwDir).filter((d) =>
          d.startsWith("chromium-"),
        );
        for (const dir of dirs.sort().reverse()) {
          const chromePath = join(
            pwDir,
            dir,
            "chrome-mac",
            "Chromium.app",
            "Contents",
            "MacOS",
            "Chromium",
          );
          if (existsSync(chromePath)) {
            const version = this.getVersion(chromePath) ?? "unknown";
            return {
              type: "chromium",
              path: chromePath,
              version,
              installed: true,
            };
          }
        }
      }
    } catch {}

    return null;
  }

  private getVersion(path: string): string | null {
    try {
      const out = execSync(`"${path}" --version 2>&1`, {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      const match = out.match(/(\d+\.\d+\.\d+[\.\d]*)/);
      return match ? match[1] : out.slice(0, 50);
    } catch {
      // Some chromium builds don't support --version but still work
      return "unknown";
    }
  }

  async install(): Promise<string> {
    console.log("Downloading Chrome headless shell...");

    try {
      // Get latest version info
      const res = await fetch(
        "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json",
      );
      const data = (await res.json()) as {
        channels: {
          Stable: {
            version: string;
            downloads: {
              "chrome-headless-shell"?: Array<{
                platform: string;
                url: string;
              }>;
            };
          };
        };
      };

      const plat = platform();
      const ar = arch();
      let platformKey: string;
      if (plat === "darwin" && ar === "arm64") platformKey = "mac-arm64";
      else if (plat === "darwin") platformKey = "mac-x64";
      else if (plat === "linux" && ar === "x64") platformKey = "linux64";
      else throw new Error(`Unsupported platform: ${plat}-${ar}`);

      const downloads =
        data.channels.Stable.downloads["chrome-headless-shell"];
      if (!downloads) throw new Error("No headless shell downloads available");

      const entry = downloads.find((d) => d.platform === platformKey);
      if (!entry) throw new Error(`No download for platform ${platformKey}`);

      // Download
      if (!existsSync(CHROMIUM_DIR))
        mkdirSync(CHROMIUM_DIR, { recursive: true });

      const zipPath = join(CHROMIUM_DIR, "chrome-headless-shell.zip");
      console.log(`Downloading from ${entry.url}...`);

      const dlRes = await fetch(entry.url);
      if (!dlRes.ok || !dlRes.body) throw new Error(`Download failed: ${dlRes.status}`);

      const fileStream = createWriteStream(zipPath);
      // @ts-ignore - ReadableStream to Node stream
      await pipeline(dlRes.body as any, fileStream);

      // Extract
      console.log("Extracting...");
      execSync(`unzip -o "${zipPath}" -d "${CHROMIUM_DIR}"`, {
        stdio: "inherit",
      });

      // Find the extracted binary
      const extractedDir = join(
        CHROMIUM_DIR,
        `chrome-headless-shell-${platformKey}`,
      );
      const binaryName =
        plat === "darwin" ? "chrome-headless-shell" : "chrome-headless-shell";
      const binaryPath = join(extractedDir, binaryName);

      if (existsSync(binaryPath)) {
        execSync(`chmod +x "${binaryPath}"`);
        // Clean up zip
        execSync(`rm -f "${zipPath}"`);
        console.log(`Chrome headless shell installed at ${binaryPath}`);
        return binaryPath;
      }

      throw new Error("Binary not found after extraction");
    } catch (err) {
      console.error(
        `Installation failed: ${err instanceof Error ? err.message : err}\n\n` +
          "Alternatives:\n" +
          "  - Google Chrome is already supported if installed\n" +
          "  - npx playwright install chromium --only-shell\n",
      );
      throw err;
    }
  }

  async launch(options: LaunchOptions = {}): Promise<EngineProcess> {
    const info = await this.detect();
    if (!info)
      throw new Error("No Chromium found. Run: tb install chromium");

    const port = options.port ?? (await findPort());
    const width = options.width ?? 1280;
    const height = options.height ?? 720;
    // Use TMPDIR if it exists, otherwise fall back to /tmp
    const effectiveTmp = existsSync(tmpdir()) ? tmpdir() : "/tmp";
    const userDataDir =
      options.userDataDir ?? join(effectiveTmp, `tb-chromium-${randomId()}`);

    if (!existsSync(userDataDir)) mkdirSync(userDataDir, { recursive: true });

    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-sync",
      "--disable-translate",
      "--mute-audio",
      "--no-first-run",
      `--remote-debugging-port=${port}`,
      `--window-size=${width},${height}`,
      `--user-data-dir=${userDataDir}`,
    ];

    const proc = spawn(info.path, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      cwd: userDataDir,
    });

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      console.error(`Chromium process error: ${err.message}`);
    });

    try {
      await waitForPort(port, "127.0.0.1", 15000);
    } catch {
      proc.kill();
      throw new Error(
        `Chromium failed to start on port ${port}. stderr: ${stderr.slice(0, 500)}`,
      );
    }

    let wsUrl: string;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      const data = (await res.json()) as { webSocketDebuggerUrl: string };
      wsUrl = data.webSocketDebuggerUrl;
    } catch {
      wsUrl = `ws://127.0.0.1:${port}/devtools/browser`;
    }

    return {
      type: "chromium",
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
