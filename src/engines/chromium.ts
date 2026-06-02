import { execSync, spawn } from "child_process";
import { existsSync, mkdirSync, createWriteStream, readdirSync } from "fs";
import { join } from "path";
import { tmpdir, platform, arch, homedir } from "os";
import { pipeline } from "stream/promises";
import type { Engine, EngineInfo, EngineProcess, LaunchOptions } from "./types.js";
import { ENGINES_DIR, findPort, waitForPort, randomId } from "../utils.js";
import { loadConfig } from "../config.js";

const CHROMIUM_DIR = join(ENGINES_DIR, "chromium");

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const EXE = IS_WIN ? ".exe" : "";

/**
 * Explicit overrides — highest priority. Lets users (and CI/containers) point
 * tb at any Chrome/Chromium/Edge/Brave binary without touching code.
 */
function overrideCandidates(): string[] {
  const out: string[] = [];
  try {
    const cfg = loadConfig();
    if (cfg.chromiumPath) out.push(cfg.chromiumPath);
  } catch {}
  // Honor the env vars Puppeteer/Playwright/users already set.
  for (const v of [
    "TB_CHROME_PATH",
    "TB_CHROME",
    "CHROME_PATH",
    "CHROME_BIN",
    "PUPPETEER_EXECUTABLE_PATH",
  ]) {
    const p = process.env[v];
    if (p) out.push(p);
  }
  return out;
}

/**
 * Well-known install locations per OS — covers Chrome, Chromium, Edge, Brave.
 */
function staticCandidates(): string[] {
  const c: string[] = [
    join(CHROMIUM_DIR, "chrome-headless-shell" + EXE),
    join(CHROMIUM_DIR, "chrome" + EXE),
  ];

  if (IS_WIN) {
    const bases = [
      process.env["PROGRAMFILES"] ?? "C:\\Program Files",
      process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
      process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"),
    ];
    for (const b of bases) {
      c.push(join(b, "Google\\Chrome\\Application\\chrome.exe"));
      c.push(join(b, "Google\\Chrome Beta\\Application\\chrome.exe"));
      c.push(join(b, "Google\\Chrome SxS\\Application\\chrome.exe")); // Canary
      c.push(join(b, "Chromium\\Application\\chrome.exe"));
      c.push(join(b, "Microsoft\\Edge\\Application\\msedge.exe"));
      c.push(join(b, "BraveSoftware\\Brave-Browser\\Application\\brave.exe"));
    }
  } else if (IS_MAC) {
    c.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Arc.app/Contents/MacOS/Arc",
    );
  } else {
    // Linux / *nix
    c.push(
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
      "/usr/bin/brave-browser",
      "/usr/bin/microsoft-edge-stable",
      "/usr/bin/microsoft-edge",
      "/opt/google/chrome/chrome",
      "/opt/google/chrome/google-chrome",
      "/opt/chromium.org/chromium/chromium",
      "/opt/brave.com/brave/brave-browser",
      "/opt/microsoft/msedge/msedge",
    );
  }
  return c;
}

/**
 * Anything resolvable on PATH (`which`/`where`), across the common binary names.
 */
function pathCandidates(): string[] {
  const bins = IS_WIN
    ? ["chrome", "msedge", "brave", "chromium"]
    : [
        "google-chrome-stable",
        "google-chrome",
        "chromium",
        "chromium-browser",
        "brave-browser",
        "microsoft-edge-stable",
        "microsoft-edge",
        "chrome",
      ];
  const finder = IS_WIN ? "where" : "which";
  const out: string[] = [];
  for (const bin of bins) {
    try {
      const res = execSync(`${finder} ${bin}`, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      for (const line of res.split(/\r?\n/)) {
        const p = line.trim();
        if (p) out.push(p);
      }
    } catch {}
  }
  return out;
}

/**
 * Browsers managed by Playwright/Puppeteer. Layout differs per OS, and the
 * cache root can be overridden via env (PLAYWRIGHT_BROWSERS_PATH etc.) or live
 * in container-standard locations like /opt/pw-browsers.
 */
function managedCandidates(): string[] {
  // Where Playwright/Puppeteer drop their browser folders.
  const roots = new Set<string>();
  const pw = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (pw && pw !== "0") roots.add(pw);
  const home = homedir();
  if (IS_WIN) {
    roots.add(join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "ms-playwright"));
  } else if (IS_MAC) {
    roots.add(join(home, "Library", "Caches", "ms-playwright"));
  } else {
    roots.add(join(home, ".cache", "ms-playwright"));
  }
  roots.add("/opt/pw-browsers"); // common CI / container default
  if (process.env.PUPPETEER_CACHE_DIR) roots.add(process.env.PUPPETEER_CACHE_DIR);
  roots.add(join(home, ".cache", "puppeteer"));

  // Binary subpath inside a Playwright browser folder, by OS.
  const pwSubpaths = IS_WIN
    ? ["chrome-win\\chrome.exe", "chrome-win\\headless_shell.exe"]
    : IS_MAC
      ? [
          "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
          "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
          "chrome-mac/headless_shell",
        ]
      : ["chrome-linux/chrome", "chrome-linux/headless_shell"];

  // Puppeteer nests one level deeper: <root>/chrome/<rev>/<platform-dir>/<bin>.
  const pupBin = IS_WIN
    ? "chrome.exe"
    : IS_MAC
      ? "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
      : "chrome";

  const out: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    // Full chromium first (supports headless AND headful — works for `tb watch`),
    // then headless_shell. Within each, newest revision first.
    const byVerDesc = (a: string, b: string) => b.localeCompare(a, undefined, { numeric: true });
    const pwDirs = [
      ...entries.filter((d) => d.startsWith("chromium-")).sort(byVerDesc),
      ...entries.filter((d) => d.startsWith("chromium_headless_shell-")).sort(byVerDesc),
    ];
    for (const d of pwDirs) {
      for (const sub of pwSubpaths) out.push(join(root, d, sub));
    }
    // Puppeteer layout.
    const pupChrome = join(root, "chrome");
    if (entries.includes("chrome") && existsSync(pupChrome)) {
      try {
        for (const rev of readdirSync(pupChrome).sort().reverse()) {
          const revDir = join(pupChrome, rev);
          try {
            for (const plat of readdirSync(revDir)) {
              out.push(join(revDir, plat, pupBin));
            }
          } catch {}
        }
      } catch {}
    }
  }
  return out;
}

export class ChromiumEngine implements Engine {
  type = "chromium" as const;

  async detect(): Promise<EngineInfo | null> {
    // Priority: explicit override → OS install → PATH → Playwright/Puppeteer.
    // First binary that exists AND reports a version wins. De-dupe so we never
    // spawn `--version` on the same path twice.
    const seen = new Set<string>();
    const sources = [
      overrideCandidates(),
      staticCandidates(),
      pathCandidates(),
      managedCandidates(),
    ];
    for (const group of sources) {
      for (const p of group) {
        if (!p || seen.has(p)) continue;
        seen.add(p);
        if (!existsSync(p)) continue;
        const version = this.getVersion(p);
        if (version !== null) {
          return { type: "chromium", path: p, version, installed: true };
        }
      }
    }
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

    const headless = options.headless !== false; // default true
    const args = [
      ...(headless ? ["--headless=new"] : []),
      // Opt-in: render sites behind TLS-intercepting proxies / self-signed certs.
      ...(options.insecure ? ["--ignore-certificate-errors"] : []),
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-sync",
      "--disable-translate",
      "--mute-audio",
      "--autoplay-policy=no-user-gesture-required",
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
