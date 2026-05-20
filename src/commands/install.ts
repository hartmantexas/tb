import { existsSync, mkdirSync, chmodSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

const TB_HOME = join(homedir(), ".tb");
const ENGINES_DIR = join(TB_HOME, "engines");

// ANSI colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const check = green("✓");
const cross = red("✗");

interface PlatformInfo {
  os: string;
  arch: string;
  label: string;
  assetSuffix: string;
}

function detectPlatform(): PlatformInfo {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "darwin" && arch === "arm64") {
    return { os: "darwin", arch: "arm64", label: "macOS ARM64", assetSuffix: "aarch64-macos" };
  }
  if (platform === "darwin" && arch === "x64") {
    return { os: "darwin", arch: "x64", label: "macOS x64", assetSuffix: "x86_64-macos" };
  }
  if (platform === "linux" && arch === "arm64") {
    return { os: "linux", arch: "arm64", label: "Linux ARM64", assetSuffix: "aarch64-linux" };
  }
  if (platform === "linux" && arch === "x64") {
    return { os: "linux", arch: "x64", label: "Linux x64", assetSuffix: "x86_64-linux" };
  }

  throw new Error(`Unsupported platform: ${platform}-${arch}. Lightpanda supports macOS and Linux (x64/ARM64).`);
}

function getLightpandaPath(): string {
  return join(ENGINES_DIR, "lightpanda");
}

function getLightpandaVersion(binPath: string): string | null {
  try {
    const output = execSync(`"${binPath}" version`, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

const CHROMIUM_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Arc.app/Contents/MacOS/Arc",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  // Linux paths
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/brave-browser",
];

function findChromium(): { path: string; name: string } | null {
  for (const p of CHROMIUM_PATHS) {
    if (existsSync(p)) {
      const name = p.includes("Brave")
        ? "Brave"
        : p.includes("Arc")
          ? "Arc"
          : p.includes("Edge")
            ? "Microsoft Edge"
            : p.includes("Canary")
              ? "Chrome Canary"
              : p.includes("Chromium")
                ? "Chromium"
                : "Google Chrome";
      return { path: p, name };
    }
  }

  // Also check chrome-headless-shell in engines dir
  const headlessPath = join(ENGINES_DIR, "chrome-headless-shell");
  if (existsSync(headlessPath)) {
    return { path: headlessPath, name: "chrome-headless-shell" };
  }

  return null;
}

async function installLightpanda(): Promise<void> {
  const binPath = getLightpandaPath();

  // Check if already installed
  if (existsSync(binPath)) {
    const version = getLightpandaVersion(binPath);
    console.log(`${check} Already installed at ${binPath}${version ? ` (${version})` : ""}`);
    return;
  }

  // Detect platform
  const platform = detectPlatform();

  // Ensure directories exist
  mkdirSync(ENGINES_DIR, { recursive: true });

  console.log(`Downloading Lightpanda v0.3.0 for ${platform.label}...`);

  // Download from GitHub releases
  const releaseUrl = "https://github.com/user/tiny-browser/releases/latest";
  const downloadUrl = `https://github.com/lightpanda-io/browser/releases/latest/download/lightpanda-${platform.assetSuffix}`;

  try {
    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    writeFileSync(binPath, Buffer.from(buffer));
    chmodSync(binPath, 0o755);

    // Verify installation
    const version = getLightpandaVersion(binPath);
    if (version) {
      console.log(`${check} Lightpanda installed! (${formatSize(buffer.byteLength)}, ~64 MB RAM per instance)`);
      console.log(`   ${dim(`Version: ${version}`)}`);
      console.log(`   ${dim(`Path: ${binPath}`)}`);
    } else {
      console.log(`${check} Lightpanda downloaded to ${binPath}`);
      console.log(`   ${dim("Could not verify version — binary may need additional setup.")}`);
    }
  } catch (err) {
    console.error(`${cross} Failed to download Lightpanda: ${err instanceof Error ? err.message : err}`);
    console.error(`   Try manually: curl -L ${downloadUrl} -o ${binPath} && chmod +x ${binPath}`);
    process.exit(1);
  }
}

async function installChromium(): Promise<void> {
  const existing = findChromium();

  if (existing) {
    console.log(`${check} ${existing.name} detected at ${existing.path}`);
    console.log(`   Using existing installation.`);
    return;
  }

  console.log("No Chromium-based browser found. Downloading chrome-headless-shell...");

  const platform = detectPlatform();
  const chromePlatform =
    platform.os === "darwin"
      ? platform.arch === "arm64" ? "mac-arm64" : "mac-x64"
      : platform.arch === "arm64" ? "linux64" : "linux64";

  try {
    // Get latest version from Chrome for Testing API
    const versionResponse = await fetch(
      "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json"
    );
    if (!versionResponse.ok) {
      throw new Error("Failed to fetch Chrome version info");
    }
    const versionData = (await versionResponse.json()) as {
      channels: { Stable: { version: string } };
    };
    const version = versionData.channels.Stable.version;

    console.log(`Downloading chrome-headless-shell v${version} for ${platform.label}...`);

    const downloadUrl = `https://storage.googleapis.com/chrome-for-testing-public/${version}/${chromePlatform}/chrome-headless-shell-${chromePlatform}.zip`;

    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status}`);
    }

    const buffer = await response.arrayBuffer();

    // Save zip and extract
    mkdirSync(ENGINES_DIR, { recursive: true });
    const zipPath = join(ENGINES_DIR, "chrome-headless-shell.zip");
    writeFileSync(zipPath, Buffer.from(buffer));

    // Extract using system unzip
    execSync(`unzip -o "${zipPath}" -d "${ENGINES_DIR}"`, { stdio: "pipe" });
    execSync(`rm "${zipPath}"`, { stdio: "pipe" });

    // Find the extracted binary
    const extractedDir = join(ENGINES_DIR, `chrome-headless-shell-${chromePlatform}`);
    const shellBin = join(extractedDir, "chrome-headless-shell");
    if (existsSync(shellBin)) {
      chmodSync(shellBin, 0o755);
    }

    console.log(`${check} chrome-headless-shell installed! (v${version})`);
    console.log(`   ${dim(`Path: ${extractedDir}`)}`);
  } catch (err) {
    console.error(`${cross} Failed to install chrome-headless-shell: ${err instanceof Error ? err.message : err}`);
    console.error("   You can install any Chromium-based browser instead (Chrome, Brave, Arc, Edge).");
    process.exit(1);
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

export async function installEngine(
  engine?: "lightpanda" | "chromium" | "all"
): Promise<void> {
  // Default: install lightpanda
  if (!engine || engine === "lightpanda") {
    console.log(bold("\nInstalling Lightpanda"));
    console.log(dim("Tiny Zig browser engine — 64 MB RAM, CDP compatible\n"));
    await installLightpanda();
    if (!engine) {
      // Also show chromium status when running bare `tb install`
      console.log("");
      const chromium = findChromium();
      if (chromium) {
        console.log(`${check} ${chromium.name} also available at ${chromium.path}`);
      } else {
        console.log(`${dim("Tip: tb also supports Chromium as a fallback. Run: tb install chromium")}`);
      }
    }
    console.log("");
    return;
  }

  if (engine === "chromium") {
    console.log(bold("\nInstalling Chromium"));
    console.log(dim("Full browser engine — for pixel-perfect screenshots\n"));
    await installChromium();
    console.log("");
    return;
  }

  if (engine === "all") {
    console.log(bold("\nInstalling all engines\n"));
    await installLightpanda();
    console.log("");
    await installChromium();
    console.log("");
    return;
  }
}
