import { existsSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

const TB_HOME = join(homedir(), ".tb");
const ENGINES_DIR = join(TB_HOME, "engines");

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const ok = green("✓");
const no = red("✗");

function which(cmd: string): string | null {
  try {
    return execSync(`command -v ${cmd}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim() || null;
  } catch {
    return null;
  }
}

function ver(cmd: string): string {
  try {
    return execSync(`${cmd}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim().split("\n")[0];
  } catch {
    return "";
  }
}

function findChromium(): string | null {
  const paths = [
    process.env.CHROME_PATH,
    process.env.CHROME_BIN,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/brave-browser",
    join(ENGINES_DIR, "chrome-headless-shell"),
  ].filter(Boolean) as string[];
  for (const p of paths) if (existsSync(p)) return p;
  // Playwright / chrome-for-testing layouts (globbed)
  for (const pat of [
    `${ENGINES_DIR}/chrome-headless-shell-*/chrome-headless-shell`,
    `${process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers"}/chromium-*/chrome-linux/chrome`,
    `${homedir()}/.cache/ms-playwright/chromium-*/chrome-linux/chrome`,
  ]) {
    try {
      const hit = execSync(`ls -d ${pat} 2>/dev/null | head -1`, { encoding: "utf-8" }).trim();
      if (hit && existsSync(hit)) return hit;
    } catch {}
  }
  return null;
}

function fmtSize(p: string): string {
  try {
    const b = statSync(p).size;
    return b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(0)}MB` : `${(b / 1024).toFixed(0)}KB`;
  } catch {
    return "";
  }
}

export async function doctor(): Promise<void> {
  console.log(bold("\ntb doctor") + dim(" — environment check\n"));

  // Runtime
  const bun = which("bun");
  console.log(`  ${bun ? ok : no} bun           ${bun ? dim(ver("bun --version")) : red("missing — https://bun.sh")}`);

  // Lightpanda (default engine)
  const lp = join(ENGINES_DIR, "lightpanda");
  const lpOk = existsSync(lp);
  console.log(`  ${lpOk ? ok : no} Lightpanda    ${lpOk ? dim(lp) : yellow("not installed — run: tb install lightpanda")}`);

  // Blitz render engine (pixel-perfect lightweight screenshots)
  const blitz = join(new URL(".", import.meta.url).pathname, "..", "..", "render-engine", "target", "release", "tb-render");
  const blitzOk = existsSync(blitz);
  console.log(`  ${blitzOk ? ok : no} Blitz engine  ${blitzOk ? dim(`${blitz} (${fmtSize(blitz)})`) : yellow("not built — run: tb install render-engine")}`);

  // Chromium (pixel-perfect, full browser)
  const chrome = findChromium();
  console.log(`  ${chrome ? ok : no} Chromium      ${chrome ? dim(chrome) : yellow("not found — run: tb install chromium (optional)")}`);

  // Rust (needed to build Blitz)
  const cargo = which("cargo");
  console.log(`  ${cargo ? ok : yellow("•")} Rust/cargo    ${cargo ? dim(ver("cargo --version")) : dim("not found — needed only to build the Blitz engine")}`);

  // Verdict
  console.log("");
  if (blitzOk) {
    console.log(`  ${bold("Screenshot quality:")} ${green("PIXEL-PERFECT")} ${dim("(Lightpanda + Blitz — real CSS, no browser)")}`);
  } else if (chrome) {
    console.log(`  ${bold("Screenshot quality:")} ${green("PIXEL-PERFECT via Chromium")} ${dim("(use -e c)")}; ${yellow("APPROXIMATE on Lightpanda until you build Blitz")}`);
  } else {
    console.log(`  ${bold("Screenshot quality:")} ${yellow("APPROXIMATE")} ${dim("— build Blitz (tb install render-engine) or install Chromium for pixel-perfect")}`);
  }

  const ready = bun && (lpOk || chrome);
  console.log("");
  if (ready) {
    console.log(`  ${ok} ${bold("tb is ready.")} ${dim("Recommended for screenshots:")} ${green("tb -w fhd open <url> && tb screenshot shot.png")}`);
  } else {
    console.log(`  ${no} ${bold("Not ready.")} ${dim("Run:")} tb install lightpanda`);
  }
  console.log("");
}
