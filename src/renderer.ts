/**
 * Satori-based DOM-to-image renderer.
 *
 * Renders structured markup → SVG (via satori/yoga) → PNG (via resvg).
 * ~5MB total vs Chromium's 684MB.
 *
 * For lightpanda: we get the DOM as HTML, convert to a simplified
 * satori-compatible tree, then render. Fidelity ~80% of real browser.
 */

import satori, { type SatoriNode } from "satori";
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const FONTS_DIR = join(homedir(), ".tb", "fonts");

interface RenderOptions {
  width?: number;
  height?: number;
}

let fontsLoaded: Array<{
  name: string;
  data: ArrayBuffer;
  weight: 400 | 700;
  style: "normal";
}> | null = null;

async function loadFonts() {
  if (fontsLoaded) return fontsLoaded;

  const fonts: typeof fontsLoaded = [];

  // Try user fonts in ~/.tb/fonts/
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

  // Try system fonts
  if (fonts.length === 0) {
    const systemPaths = [
      "/System/Library/Fonts/Supplemental/Arial.ttf",
      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
      "/usr/share/fonts/TTF/DejaVuSans.ttf",
    ];
    for (const p of systemPaths) {
      if (existsSync(p)) {
        try {
          fonts.push({
            name: "System",
            data: readFileSync(p).buffer as ArrayBuffer,
            weight: 400,
            style: "normal",
          });
          break;
        } catch {}
      }
    }
  }

  // Download Inter as fallback
  if (fonts.length === 0) {
    try {
      const res = await fetch(
        "https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuLyfAZ9hiA.woff2",
      );
      if (res.ok) {
        fonts.push({
          name: "Inter",
          data: await res.arrayBuffer(),
          weight: 400,
          style: "normal",
        });
      }
    } catch {}
  }

  if (fonts.length === 0) {
    throw new Error("No fonts found. Place a .ttf file in ~/.tb/fonts/");
  }

  fontsLoaded = fonts;
  return fonts;
}

/**
 * Parse inline style string into an object.
 */
function parseStyle(style: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of style.split(";")) {
    const colonIdx = part.indexOf(":");
    if (colonIdx === -1) continue;
    const prop = part.slice(0, colonIdx).trim();
    const value = part.slice(colonIdx + 1).trim();
    if (prop && value) {
      // Convert kebab-case to camelCase
      const camel = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      result[camel] = value;
    }
  }
  return result;
}

/**
 * Very lightweight HTML → satori element tree parser.
 * Handles the subset that satori supports: div, span, p, h1-h6, img, svg.
 * Strips everything else to text content.
 */
function htmlToSatoriTree(html: string): SatoriNode {
  // Strip scripts, styles, meta
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<link[^>]*\/?>/gi, "")
    .replace(/<meta[^>]*\/?>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  // Extract body
  const bodyMatch = cleaned.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (bodyMatch) cleaned = bodyMatch[1];

  /**
   * Find the matching closing tag, handling nesting.
   */
  function findClosingTag(input: string, tagName: string, startPos: number): number {
    let depth = 1;
    let pos = startPos;
    const openRe = new RegExp(`<${tagName}[\\s>/]`, "gi");
    const closeRe = new RegExp(`</${tagName}>`, "gi");

    while (depth > 0 && pos < input.length) {
      openRe.lastIndex = pos;
      closeRe.lastIndex = pos;

      const openMatch = openRe.exec(input);
      const closeMatch = closeRe.exec(input);

      if (!closeMatch) return -1; // No closing tag found

      if (openMatch && openMatch.index < closeMatch.index) {
        depth++;
        pos = openMatch.index + openMatch[0].length;
      } else {
        depth--;
        if (depth === 0) return closeMatch.index;
        pos = closeMatch.index + closeMatch[0].length;
      }
    }
    return -1;
  }

  const SELF_CLOSING = new Set(["br", "hr", "img", "input", "meta", "link", "area", "col"]);

  const BLOCK_TAGS = new Set([
    "header", "footer", "main", "section", "article", "nav", "aside",
    "figure", "form", "ul", "ol", "li", "table", "tr", "td", "th",
    "thead", "tbody", "figcaption", "details", "summary", "fieldset",
  ]);

  const INLINE_TAGS = new Set([
    "a", "strong", "em", "b", "i", "code", "small", "label", "abbr", "time",
  ]);

  function mapTag(tagName: string): string | null {
    if (["div", "span", "p", "img", "svg"].includes(tagName)) return tagName;
    if (BLOCK_TAGS.has(tagName)) return "div";
    if (INLINE_TAGS.has(tagName)) return "span";
    if (/^h[1-6]$/.test(tagName)) return "div";
    return null;
  }

  function parse(input: string): SatoriNode[] {
    const nodes: SatoriNode[] = [];
    let pos = 0;

    while (pos < input.length) {
      const tagStart = input.indexOf("<", pos);

      if (tagStart === -1) {
        const text = decodeEntities(input.slice(pos).trim());
        if (text) nodes.push(text);
        break;
      }

      // Text before tag
      if (tagStart > pos) {
        const text = decodeEntities(input.slice(pos, tagStart).trim());
        if (text) nodes.push(text);
      }

      // Closing tag — shouldn't happen at top level, skip it
      if (input[tagStart + 1] === "/") {
        const closeEnd = input.indexOf(">", tagStart);
        pos = closeEnd === -1 ? input.length : closeEnd + 1;
        continue;
      }

      // Parse opening tag
      const tagEnd = input.indexOf(">", tagStart);
      if (tagEnd === -1) { pos = input.length; break; }

      const rawTag = input.slice(tagStart + 1, input[tagEnd - 1] === "/" ? tagEnd - 1 : tagEnd);
      const spaceIdx = rawTag.search(/[\s\/]/);
      const tagName = (spaceIdx === -1 ? rawTag : rawTag.slice(0, spaceIdx)).toLowerCase();

      const selfClosing = SELF_CLOSING.has(tagName) || input[tagEnd - 1] === "/";

      // Extract style
      const styleMatch = rawTag.match(/style\s*=\s*"([^"]*)"/i);
      const style = styleMatch ? parseStyle(styleMatch[1]) : {};

      const satoriTag = mapTag(tagName);

      if (selfClosing) {
        if (satoriTag === "img") {
          const srcMatch = rawTag.match(/src\s*=\s*"([^"]*)"/i);
          if (srcMatch) {
            nodes.push({
              type: "img",
              props: { src: srcMatch[1], style, children: [] },
            } as unknown as SatoriNode);
          }
        }
        pos = tagEnd + 1;
        continue;
      }

      // Find matching closing tag (handling nesting)
      const innerStart = tagEnd + 1;
      const closeIdx = findClosingTag(input, tagName, innerStart);
      const innerHtml = closeIdx === -1
        ? input.slice(innerStart)
        : input.slice(innerStart, closeIdx);

      pos = closeIdx === -1
        ? input.length
        : closeIdx + `</${tagName}>`.length;

      if (!satoriTag) {
        // Unknown tag — parse its children and hoist them
        const innerChildren = parse(innerHtml);
        nodes.push(...innerChildren);
        continue;
      }

      // Parse children recursively
      const children = parse(innerHtml);

      // Default styles
      if (/^h[1-6]$/.test(tagName)) {
        const sizes: Record<string, string> = { h1: "32px", h2: "28px", h3: "24px", h4: "20px", h5: "18px", h6: "16px" };
        if (!style.fontSize) style.fontSize = sizes[tagName] ?? "16px";
        if (!style.fontWeight) style.fontWeight = "700";
      }
      if (satoriTag === "div" && !style.display) {
        style.display = "flex";
      }

      nodes.push({
        type: satoriTag,
        props: {
          style,
          children: children.length === 1 ? children[0] : children,
        },
      } as unknown as SatoriNode);
    }

    return nodes;
  }

  function decodeEntities(str: string): string {
    return str
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ");
  }

  const children = parse(cleaned);

  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        background: "#0a0a0a",
        color: "#fafafa",
        fontFamily: "System, Custom, Inter, sans-serif",
      },
      children: children.length === 1 ? children[0] : children,
    },
  } as unknown as SatoriNode;
}

/**
 * Render HTML string to SVG.
 */
export async function renderToSvg(
  html: string,
  options: RenderOptions = {},
): Promise<string> {
  const fonts = await loadFonts();
  const tree = htmlToSatoriTree(html);

  return satori(tree, {
    width: options.width ?? 1280,
    height: options.height ?? 720,
    fonts: fonts.map((f) => ({
      name: f.name,
      data: f.data,
      weight: f.weight,
      style: f.style,
    })),
  });
}

/**
 * Render HTML string to PNG buffer.
 */
export async function renderToPng(
  html: string,
  options: RenderOptions = {},
): Promise<Buffer> {
  const svg = await renderToSvg(html, options);
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: options.width ?? 1280 },
  });
  return Buffer.from(resvg.render().asPng());
}

/**
 * Render a page's HTML to a PNG image file (fallback when computed styles unavailable).
 */
export async function renderPage(
  pageHtml: string,
  options: { width?: number; height?: number; path?: string } = {},
): Promise<Buffer> {
  const buffer = await renderToPng(pageHtml, {
    width: options.width ?? 1280,
    height: options.height ?? 720,
  });

  if (options.path) {
    const { writeFileSync } = await import("fs");
    writeFileSync(options.path, buffer);
  }

  return buffer;
}

/**
 * Sanitize a styled tree node to ensure satori compatibility.
 * Handles null children, invalid types, and cleans up style values.
 */
function sanitizeNode(node: unknown): SatoriNode | string | null {
  if (node === null || node === undefined) return null;

  // String children are valid
  if (typeof node === "string") {
    return node.trim() || null;
  }

  // Must be an object with type and props
  if (typeof node !== "object" || !node) return null;

  const n = node as Record<string, unknown>;
  const type = n.type as string;
  const props = n.props as Record<string, unknown> | undefined;

  if (!type || !props) return null;

  // Validate tag type - satori only supports these
  const validTypes = new Set(["div", "span", "p", "img", "svg"]);
  const safeType = validTypes.has(type) ? type : "div";

  const style = (props.style as Record<string, string>) ?? {};

  // Clean up style values that might cause satori to throw or resvg to panic
  const cleanedStyle: Record<string, string> = {};
  for (const [key, val] of Object.entries(style)) {
    if (val === null || val === undefined || val === "" || val === "undefined") continue;
    // Skip CSS values satori doesn't understand
    if (typeof val === "string" && val.startsWith("var(")) continue;
    if (typeof val === "string" && val.startsWith("calc(")) continue;
    // Skip inherit/initial/unset
    if (val === "inherit" || val === "initial" || val === "unset" || val === "revert") continue;
    // Skip negative dimensions that crash resvg
    if ((key === "width" || key === "height") && typeof val === "string") {
      const num = parseFloat(val);
      if (isNaN(num) || num < 0) continue;
    }
    cleanedStyle[key] = val;
  }

  // Ensure display is flex for non-text containers
  if (!cleanedStyle.display) {
    cleanedStyle.display = "flex";
    if (!cleanedStyle.flexDirection) {
      cleanedStyle.flexDirection = "column";
    }
  }

  // Sanitize children
  let children = props.children;
  let sanitizedChildren: (SatoriNode | string)[] | string | SatoriNode;

  if (children === null || children === undefined) {
    sanitizedChildren = [];
  } else if (typeof children === "string") {
    sanitizedChildren = children;
  } else if (Array.isArray(children)) {
    const cleaned: (SatoriNode | string)[] = [];
    for (const child of children) {
      const sanitized = sanitizeNode(child);
      if (sanitized !== null) {
        cleaned.push(sanitized);
      }
    }
    // If single string child, unwrap for satori preference
    if (cleaned.length === 1 && typeof cleaned[0] === "string") {
      sanitizedChildren = cleaned[0];
    } else {
      sanitizedChildren = cleaned;
    }
  } else {
    // Single non-array, non-string child
    const sanitized = sanitizeNode(children);
    sanitizedChildren = sanitized !== null ? sanitized : [];
  }

  const result: Record<string, unknown> = {
    type: safeType,
    props: {
      style: cleanedStyle,
      children: sanitizedChildren,
    },
  };

  // Preserve img src — satori requires absolute URLs
  if (safeType === "img" && props.src) {
    const src = props.src as string;
    if (src.startsWith("http://") || src.startsWith("https://") || src.startsWith("data:")) {
      (result.props as Record<string, unknown>).src = src;
    } else {
      // Can't render relative URLs in satori — convert img to placeholder div
      return {
        type: "div",
        props: {
          style: {
            ...cleanedStyle,
            display: "flex",
            backgroundColor: "#e5e5e5",
            borderRadius: "2px",
          },
          children: [],
        },
      } as unknown as SatoriNode;
    }
  }

  return result as unknown as SatoriNode;
}

/**
 * Render a pre-extracted styled tree (from lightpanda's computed CSS) to PNG.
 * This is the high-fidelity path: lightpanda computes the CSS, we extract
 * the computed styles via getComputedStyle(), and satori renders with real styles.
 *
 * Runs in a subprocess to isolate resvg native crashes from the daemon process.
 * Falls back to in-process rendering with stripped tree on subprocess failure.
 */
export async function renderStyledTree(
  tree: unknown,
  options: { width?: number; height?: number } = {},
): Promise<Buffer> {
  const width = options.width ?? 1280;
  const height = options.height ?? 720;

  // Sanitize the tree first
  const sanitized = sanitizeNode(tree);
  if (!sanitized || typeof sanitized === "string") {
    // Trivial case — render inline
    const fonts = await loadFonts();
    const textTree = {
      type: "div",
      props: {
        style: { display: "flex", width: "100%", height: "100%", backgroundColor: "#fff", color: "#000" },
        children: typeof sanitized === "string" ? sanitized : "",
      },
    } as unknown as SatoriNode;
    const svg = await satori(textTree, { width, height, fonts: fonts.map(f => ({ name: f.name, data: f.data, weight: f.weight, style: f.style })) });
    const resvg = new Resvg(svg, { fitTo: { mode: "width", value: width } });
    return Buffer.from(resvg.render().asPng());
  }

  // Try rendering in a subprocess (isolates native crashes)
  try {
    const workerPath = new URL("./render-worker.ts", import.meta.url).pathname;
    const input = JSON.stringify({ tree: sanitized, width, height });

    const proc = Bun.spawn(["bun", "run", workerPath], {
      stdin: new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode === 0 && output) {
      const result = JSON.parse(output);
      if (result.base64) {
        return Buffer.from(result.base64, "base64");
      }
      if (result.error) {
        throw new Error(result.error);
      }
    }
    throw new Error(`Render worker exited with code ${exitCode}`);
  } catch (subprocessError) {
    console.error("[tb] Subprocess render failed:", (subprocessError as Error).message);

    // Fallback: try a stripped-down tree in-process
    try {
      const stripped = stripToDepth(sanitized, 5);
      const fonts = await loadFonts();
      const fontConfig = fonts.map(f => ({ name: f.name, data: f.data, weight: f.weight, style: f.style }));
      const svg = await satori(stripped as SatoriNode, { width, height, fonts: fontConfig });
      const resvg = new Resvg(svg, { fitTo: { mode: "width", value: width } });
      return Buffer.from(resvg.render().asPng());
    } catch {
      // Final fallback: blank page with error
      const fonts = await loadFonts();
      const fontConfig = fonts.map(f => ({ name: f.name, data: f.data, weight: f.weight, style: f.style }));
      const errorTree = {
        type: "div",
        props: {
          style: { display: "flex", flexDirection: "column", width: "100%", height: "100%", backgroundColor: "#fff", color: "#333", padding: "40px" },
          children: [
            { type: "div", props: { style: { fontSize: "18px", marginBottom: "10px", display: "flex" }, children: "Screenshot rendered with reduced fidelity" } },
            { type: "div", props: { style: { fontSize: "12px", color: "#999", display: "flex" }, children: `Use --engine chromium for pixel-perfect output` } },
          ],
        },
      } as unknown as SatoriNode;
      const svg = await satori(errorTree, { width, height, fonts: fontConfig });
      const resvg = new Resvg(svg, { fitTo: { mode: "width", value: width } });
      return Buffer.from(resvg.render().asPng());
    }
  }
}

// Keep the old implementation code below but skip the duplicate function

/**
 * Strip a satori node tree to a maximum depth, replacing deep subtrees with
 * their text content.
 */
function stripToDepth(node: unknown, maxDepth: number): unknown {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return null;

  const n = node as Record<string, unknown>;
  const props = n.props as Record<string, unknown>;
  if (!props) return node;

  if (maxDepth <= 0) {
    // Extract just text content
    const text = extractText(node);
    return text ? text : null;
  }

  const children = props.children;
  let newChildren: unknown;

  if (typeof children === "string") {
    newChildren = children;
  } else if (Array.isArray(children)) {
    newChildren = children
      .map((c) => stripToDepth(c, maxDepth - 1))
      .filter((c) => c !== null);
  } else if (children && typeof children === "object") {
    newChildren = stripToDepth(children, maxDepth - 1);
  } else {
    newChildren = children;
  }

  return {
    type: n.type,
    props: {
      ...props,
      children: newChildren,
    },
  };
}

/**
 * Extract all text content from a node tree (for fallback rendering).
 */
function extractText(node: unknown): string {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";

  const props = (node as Record<string, unknown>).props as Record<string, unknown>;
  if (!props) return "";

  const children = props.children;
  if (typeof children === "string") return children;
  if (Array.isArray(children)) {
    return children.map(extractText).filter(Boolean).join(" ");
  }
  if (children && typeof children === "object") {
    return extractText(children);
  }
  return "";
}
