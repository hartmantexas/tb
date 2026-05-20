/**
 * Isolated render worker. Runs satori + resvg in a subprocess
 * so that a resvg native crash doesn't take down the daemon.
 *
 * Usage: echo '{"tree": ..., "width": 1280, "height": 720}' | bun run render-worker.ts
 * Outputs PNG as base64 to stdout.
 */

import satori, { type SatoriNode } from "satori";
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

async function loadFonts() {
  const FONTS_DIR = join(homedir(), ".tb", "fonts");
  const fonts: Array<{ name: string; data: ArrayBuffer; weight: 400 | 700; style: "normal" }> = [];

  if (existsSync(FONTS_DIR)) {
    try {
      const { readdirSync } = await import("fs");
      for (const f of readdirSync(FONTS_DIR)) {
        if (f.endsWith(".ttf") || f.endsWith(".otf") || f.endsWith(".woff")) {
          fonts.push({
            name: "Custom",
            data: readFileSync(join(FONTS_DIR, f)).buffer as ArrayBuffer,
            weight: f.toLowerCase().includes("bold") ? 700 : 400,
            style: "normal",
          });
        }
      }
    } catch {}
  }

  if (fonts.length === 0) {
    const systemPaths = [
      "/System/Library/Fonts/Supplemental/Arial.ttf",
      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ];
    for (const p of systemPaths) {
      if (existsSync(p)) {
        try {
          fonts.push({ name: "System", data: readFileSync(p).buffer as ArrayBuffer, weight: 400, style: "normal" });
          break;
        } catch {}
      }
    }
  }

  if (fonts.length === 0) {
    try {
      const res = await fetch("https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuLyfAZ9hiA.woff2");
      if (res.ok) fonts.push({ name: "Inter", data: await res.arrayBuffer(), weight: 400, style: "normal" });
    } catch {}
  }

  return fonts;
}

async function main() {
  const input = await Bun.stdin.text();
  const { tree, width = 1280, height = 720 } = JSON.parse(input);

  const fonts = await loadFonts();
  if (fonts.length === 0) {
    process.stdout.write(JSON.stringify({ error: "No fonts available" }));
    process.exit(1);
  }

  const fontConfig = fonts.map(f => ({ name: f.name, data: f.data, weight: f.weight, style: f.style }));

  try {
    const svg = await satori(tree as SatoriNode, { width, height, fonts: fontConfig });

    const cleanSvg = svg
      .replace(/="NaN"/g, '="0"')
      .replace(/="Infinity"/g, '="0"')
      .replace(/="-Infinity"/g, '="0"');

    const resvg = new Resvg(cleanSvg, { fitTo: { mode: "width", value: width } });
    const png = resvg.render().asPng();
    const base64 = Buffer.from(png).toString("base64");
    process.stdout.write(JSON.stringify({ base64, size: png.length }));
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: (err as Error).message }));
    process.exit(1);
  }
}

main();
