/**
 * Takumi-based renderer for tb.
 * Converts lightpanda's styled tree → Takumi element tree → PNG.
 * Takumi handles: flexbox, grid, CSS variables, gradients, shadows, text wrapping.
 * No browser needed. ~5MB native binary.
 */

import { Renderer } from "@takumi-rs/core";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

let renderer: InstanceType<typeof Renderer> | null = null;

function getRenderer(width: number, height: number): InstanceType<typeof Renderer> {
  if (!renderer) {
    renderer = new Renderer({ width, height });

    // Load system fonts
    const fontPaths = [
      "/System/Library/Fonts/Supplemental/Arial.ttf",
      "/System/Library/Fonts/Helvetica.ttc",
      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
      "/usr/share/fonts/TTF/DejaVuSans.ttf",
    ];

    // Also check ~/.tb/fonts/
    const userFontsDir = join(homedir(), ".tb", "fonts");
    if (existsSync(userFontsDir)) {
      try {
        for (const f of require("fs").readdirSync(userFontsDir)) {
          if (f.endsWith(".ttf") || f.endsWith(".otf")) {
            fontPaths.unshift(join(userFontsDir, f));
          }
        }
      } catch {}
    }

    let loaded = false;
    for (const p of fontPaths) {
      if (existsSync(p)) {
        try {
          renderer.loadFontSync({ data: readFileSync(p), name: "System" });
          loaded = true;
          break;
        } catch {}
      }
    }

    if (!loaded) {
      console.error("[tb] Warning: No fonts found. Text rendering may fail.");
    }
  }
  return renderer;
}

/**
 * Convert our styled tree (div/span/p with style+children)
 * to Takumi's format (container/text/image with style+children/text).
 */
interface StyledNode {
  type: string;
  props: {
    style: Record<string, string>;
    children: StyledNode[] | StyledNode | string;
    src?: string;
  };
}

interface TakumiNode {
  type: "container" | "text" | "image";
  style: Record<string, unknown>;
  text?: string;
  children?: TakumiNode[];
  src?: string;
  width?: number;
  height?: number;
}

function convertNode(node: StyledNode | string, inherited: Record<string, string> = {}): TakumiNode | null {
  if (typeof node === "string") {
    const text = node.replace(/\s+/g, " ").trim();
    if (!text) return null;
    return {
      type: "text",
      style: {
        color: inherited.color || "#000",
        fontSize: px(inherited.fontSize, 16),
        fontWeight: numWeight(inherited.fontWeight),
        fontFamily: "System, Arial, sans-serif",
      },
      text,
    };
  }

  if (!node || !node.props) return null;

  const s = node.props.style || {};
  const children = getChildren(node);

  // Skip hidden elements
  if (s.display === "none" || s.visibility === "hidden") return null;

  // Skip SVG placeholders
  if (node.type === "svg") return null;

  // Convert styles to Takumi format (numeric values where needed)
  const style: Record<string, unknown> = {};

  // Layout
  if (s.display === "flex" || s.display === "grid") style.display = "flex";
  else style.display = "flex";

  // Flex direction
  if (s.flexDirection) {
    style.flexDirection = s.flexDirection;
  } else if (s.display === "flex" || s.display === "inline-flex") {
    style.flexDirection = "row";
  } else {
    style.flexDirection = "column";
  }

  // Prevent vertical stretching but keep horizontal fill
  // Column containers: items stretch width (normal) but not height
  // Row containers: items align to top, not stretch height
  if (style.flexDirection === "column") {
    if (!s.alignItems) style.alignItems = "stretch"; // fill width
  } else {
    if (!s.alignItems) style.alignItems = "flex-start"; // don't stretch height in rows
  }

  if (s.flexWrap) style.flexWrap = s.flexWrap;
  if (s.alignItems) style.alignItems = s.alignItems;
  // Skip justify-content: center on column containers — it causes massive vertical gaps
  // in snapshot mode since we don't have accurate heights
  if (s.justifyContent) {
    if (style.flexDirection === "column" && s.justifyContent === "center") {
      style.justifyContent = "flex-start"; // pack to top instead
    } else {
      style.justifyContent = s.justifyContent;
    }
  }
  if (s.gap) style.gap = px(s.gap);
  if (s.flex) {
    const f = parseFloat(s.flex);
    if (!isNaN(f) && f > 0) style.flexGrow = f;
  }
  if (s.flexGrow) {
    const fg = parseFloat(s.flexGrow);
    if (!isNaN(fg)) style.flexGrow = fg;
  }
  if (s.flexShrink !== undefined) {
    const fs = parseFloat(s.flexShrink);
    if (!isNaN(fs)) style.flexShrink = fs;
  }

  // Sizing
  // Skip viewport-relative sizes that cause stretching/overflow
  if (s.width && !s.width.includes("vw")) style.width = pxOrPct(s.width);
  if (s.height && !s.height.includes("vh") && !s.height.includes("dvh") && s.height !== "100%") {
    style.height = pxOrPct(s.height);
  }
  if (s.minWidth) style.minWidth = pxOrPct(s.minWidth);
  // Skip minHeight: 100vh — it stretches containers to viewport and wastes space
  if (s.minHeight && !s.minHeight.includes("vh") && !s.minHeight.includes("dvh")) {
    style.minHeight = pxOrPct(s.minHeight);
  }
  if (s.maxWidth) style.maxWidth = pxOrPct(s.maxWidth);
  if (s.maxHeight) style.maxHeight = pxOrPct(s.maxHeight);

  // Spacing
  if (s.marginTop) style.marginTop = px(s.marginTop);
  if (s.marginRight) style.marginRight = px(s.marginRight);
  if (s.marginBottom) style.marginBottom = px(s.marginBottom);
  if (s.marginLeft) style.marginLeft = px(s.marginLeft);
  if (s.paddingTop) style.paddingTop = px(s.paddingTop);
  if (s.paddingRight) style.paddingRight = px(s.paddingRight);
  if (s.paddingBottom) style.paddingBottom = px(s.paddingBottom);
  if (s.paddingLeft) style.paddingLeft = px(s.paddingLeft);

  // Visual
  if (s.backgroundColor && s.backgroundColor !== "transparent" && s.backgroundColor !== "rgba(0, 0, 0, 0)") {
    style.backgroundColor = s.backgroundColor;
  }
  if (s.color) style.color = s.color;
  if (s.opacity) style.opacity = parseFloat(s.opacity);

  // Border
  if (s.borderRadius) style.borderRadius = px(s.borderRadius);
  if (s.borderTopLeftRadius) style.borderTopLeftRadius = px(s.borderTopLeftRadius);
  if (s.borderTopRightRadius) style.borderTopRightRadius = px(s.borderTopRightRadius);
  if (s.borderBottomLeftRadius) style.borderBottomLeftRadius = px(s.borderBottomLeftRadius);
  if (s.borderBottomRightRadius) style.borderBottomRightRadius = px(s.borderBottomRightRadius);
  if (s.borderTopWidth && s.borderTopWidth !== "0px") {
    style.borderTopWidth = px(s.borderTopWidth);
    style.borderTopColor = s.borderTopColor || s.borderColor || "#000";
    style.borderTopStyle = "solid";
  }
  if (s.borderBottomWidth && s.borderBottomWidth !== "0px") {
    style.borderBottomWidth = px(s.borderBottomWidth);
    style.borderBottomColor = s.borderBottomColor || s.borderColor || "#000";
    style.borderBottomStyle = "solid";
  }
  if (s.borderLeftWidth && s.borderLeftWidth !== "0px") {
    style.borderLeftWidth = px(s.borderLeftWidth);
    style.borderLeftColor = s.borderLeftColor || s.borderColor || "#000";
    style.borderLeftStyle = "solid";
  }
  if (s.borderRightWidth && s.borderRightWidth !== "0px") {
    style.borderRightWidth = px(s.borderRightWidth);
    style.borderRightColor = s.borderRightColor || s.borderColor || "#000";
    style.borderRightStyle = "solid";
  }

  // Typography
  if (s.fontSize) style.fontSize = px(s.fontSize, 16);
  if (s.fontWeight) style.fontWeight = numWeight(s.fontWeight);
  if (s.textAlign) style.textAlign = s.textAlign;
  if (s.lineHeight) style.lineHeight = px(s.lineHeight);
  if (s.letterSpacing) style.letterSpacing = px(s.letterSpacing);
  if (s.textDecoration) style.textDecoration = s.textDecoration;
  if (s.textTransform) style.textTransform = s.textTransform;

  // Shadow
  if (s.boxShadow && s.boxShadow !== "none") style.boxShadow = s.boxShadow;

  // Overflow
  if (s.overflow === "hidden") style.overflow = "hidden";

  // Skip position: absolute/relative — we can't do accurate positioning
  // without real layout coordinates, and it causes overlap at (0,0)
  // Only keep relative for z-index stacking context
  if (s.position === "relative") style.position = "relative";

  style.fontFamily = "System, Arial, sans-serif";

  // Merge inherited styles for text rendering
  const childInherited = {
    color: (s.color || inherited.color || "#000"),
    fontSize: (s.fontSize || inherited.fontSize || "16px"),
    fontWeight: (s.fontWeight || inherited.fontWeight || "400"),
  };

  // Image
  if (node.type === "img" && node.props.src) {
    return {
      type: "image",
      style,
      src: node.props.src,
      width: px(s.width, 100),
      height: px(s.height, 100),
    };
  }

  // Convert children
  const takumiChildren: TakumiNode[] = [];
  for (const child of children) {
    const converted = convertNode(child as StyledNode, childInherited);
    if (converted) takumiChildren.push(converted);
  }

  // Empty node
  if (takumiChildren.length === 0 && children.length === 0) {
    return { type: "container", style, children: [] };
  }

  // Only merge text children into a single text node for INLINE wrappers
  // (span, a, b, i, em, strong) — NOT for block/flex containers
  const isInlineWrapper = node.type === "span" || node.type === "a" ||
    node.type === "b" || node.type === "i" || node.type === "em" || node.type === "strong";

  if (isInlineWrapper && takumiChildren.every(c => c.type === "text") && takumiChildren.length > 0) {
    const mergedText = takumiChildren.map(c => c.text || "").join(" ").trim();
    if (mergedText) {
      const textStyle = { ...style };
      if (!textStyle.color) textStyle.color = childInherited.color;
      if (!textStyle.fontSize) textStyle.fontSize = px(childInherited.fontSize, 16);
      if (!textStyle.fontWeight) textStyle.fontWeight = numWeight(childInherited.fontWeight);
      return { type: "text", style: textStyle, text: mergedText };
    }
  }

  // For containers: ensure text children have proper styling
  const finalChildren: TakumiNode[] = [];
  for (const child of takumiChildren) {
    if (child.type === "text" && child.text) {
      // Ensure text nodes inherit parent styles
      if (!child.style.color) child.style.color = childInherited.color;
      if (!child.style.fontSize) child.style.fontSize = px(childInherited.fontSize, 16);
      if (!child.style.fontWeight) child.style.fontWeight = numWeight(childInherited.fontWeight);
      child.style.fontFamily = "System, Arial, sans-serif";
    }
    finalChildren.push(child);
  }

  return { type: "container", style, children: finalChildren };
}

function getChildren(node: StyledNode): (StyledNode | string)[] {
  const c = node.props.children;
  if (!c) return [];
  if (typeof c === "string") return [c];
  if (Array.isArray(c)) return c.filter(Boolean);
  return [c];
}

function px(val: string | undefined | null, fb = 0): number {
  if (!val || val === "auto" || val === "none") return fb;
  if (typeof val === "number") return val;
  if (val.includes("var(") || val.includes("calc(")) return fb;
  if (val.endsWith("rem")) return parseFloat(val) * 16;
  if (val.endsWith("em")) return parseFloat(val) * 16;
  const n = parseFloat(val);
  return isNaN(n) ? fb : n;
}

function pxOrPct(val: string | undefined): string | number | undefined {
  if (!val || val === "auto" || val === "none") return undefined;
  if (val.endsWith("%")) return val; // Takumi might handle percentage strings
  return px(val);
}

function numWeight(w: string | undefined): number {
  if (!w) return 400;
  if (w === "bold") return 700;
  if (w === "bolder") return 700;
  if (w === "lighter") return 300;
  if (w === "normal") return 400;
  const n = parseInt(w);
  return isNaN(n) ? 400 : n;
}

/**
 * Render a styled tree from lightpanda to PNG using Takumi.
 */
export async function renderWithTakumi(
  tree: unknown,
  options: { width?: number; height?: number } = {},
): Promise<Buffer> {
  const width = options.width ?? 1280;
  const height = options.height ?? 720;

  const r = getRenderer(width, height);

  if (!tree || typeof tree !== "object") {
    // Empty page
    const png = await r.render({
      type: "container",
      style: { width, height, backgroundColor: "#fff" },
      children: [],
    });
    return Buffer.from(png);
  }

  // Convert our tree format to Takumi format
  const takumiTree = convertNode(tree as StyledNode);

  if (!takumiTree) {
    const png = await r.render({
      type: "container",
      style: { width, height, backgroundColor: "#fff" },
      children: [],
    });
    return Buffer.from(png);
  }

  // Ensure root has full dimensions
  takumiTree.style.width = width;
  takumiTree.style.height = height;

  try {
    const png = await r.render(takumiTree);
    return Buffer.from(png);
  } catch (err) {
    console.error("[tb] Takumi render error:", (err as Error).message);
    // Fallback: try simpler tree
    try {
      const simple: TakumiNode = {
        type: "container",
        style: {
          width,
          height,
          backgroundColor: takumiTree.style.backgroundColor || "#fff",
          padding: 20,
          display: "flex",
          flexDirection: "column",
        },
        children: [
          {
            type: "text",
            style: { fontSize: 14, color: takumiTree.style.color as string || "#333", fontFamily: "System, Arial, sans-serif" },
            text: `Page rendered with reduced fidelity: ${(err as Error).message?.slice(0, 80)}`,
          },
        ],
      };
      const png = await r.render(simple);
      return Buffer.from(png);
    } catch {
      return Buffer.alloc(0);
    }
  }
}
