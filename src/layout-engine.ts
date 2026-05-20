/**
 * CSS Layout Engine + SVG Painter for tb.
 * Handles: block flow, inline text wrapping, flexbox, tables, box model.
 * Renders text as full lines (not individual words) for proper spacing.
 * Propagates inherited styles (color, font) through the tree.
 */

import { Resvg } from "@resvg/resvg-js";

// --- Types ---

interface SNode {
  type: string;
  props: {
    style: Record<string, string>;
    children: SNode[] | SNode | string;
    src?: string;
  };
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  // Visual
  bg?: string;
  color: string;
  fontSize: number;
  fontWeight: string;
  // Borders
  bt?: number; br?: number; bb?: number; bleft?: number;
  bc?: string;
  radius?: number;
  opacity?: number;
  // Text (rendered as full lines)
  lines?: string[];
  textDec?: string;
  // Clipping
  clip?: boolean;
  // Children
  kids: Box[];
}

// --- Utilities ---

function px(v: string | undefined | null, fb = 0): number {
  if (!v || v === "auto" || v === "none" || v === "normal") return fb;
  if (v.includes("var(") || v.includes("calc(")) return fb; // unresolved CSS functions
  const n = parseFloat(v);
  return isNaN(n) ? fb : n;
}

function pxOrPct(v: string | undefined | null, container: number, fb = 0): number {
  if (!v || v === "auto" || v === "none") return fb;
  if (v.endsWith("%")) return (parseFloat(v) / 100) * container;
  return px(v, fb);
}

// Average character width ratio — tuned for Arial/Helvetica
const CHAR_W = 0.48;

function measureText(text: string, fontSize: number): number {
  return text.length * fontSize * CHAR_W;
}

function getKids(n: SNode): (SNode | string)[] {
  const c = n.props.children;
  if (!c) return [];
  if (typeof c === "string") return [c];
  if (Array.isArray(c)) return c.filter(Boolean);
  return [c];
}

function isInline(n: SNode | string): boolean {
  if (typeof n === "string") return true;
  const s = n.props.style;
  const d = s.display;
  if (d === "inline" || d === "inline-block" || d === "inline-flex") return true;
  if (n.type === "span" || n.type === "a") return true;
  return false;
}

function allText(n: SNode | string): string {
  if (typeof n === "string") return n;
  return getKids(n).map(c => allText(c as SNode)).join(" ");
}

function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Resolve a color, handling 'inherit' and 'transparent'
function resolveColor(val: string | undefined, inherited: string): string {
  if (!val || val === "inherit" || val === "currentColor" || val === "currentcolor") return inherited;
  if (val === "transparent" || val === "rgba(0, 0, 0, 0)") return "";
  if (val.includes("var(")) return inherited; // unresolved CSS variable
  return val;
}

// --- Layout ---

function layout(
  node: SNode | string,
  cw: number,          // container width
  inheritColor: string,
  inheritFontSize: number,
  inheritFontWeight: string,
): Box {
  // Text node
  if (typeof node === "string") {
    const text = node.replace(/\s+/g, " ").trim();
    if (!text) return { x: 0, y: 0, w: 0, h: 0, color: inheritColor, fontSize: inheritFontSize, fontWeight: inheritFontWeight, kids: [] };
    return wrapText(text, cw, inheritFontSize, inheritFontWeight, inheritColor);
  }

  const s = node.props.style;
  const kids = getKids(node);

  // Resolve inherited styles
  const color = resolveColor(s.color, inheritColor);
  const fontSize = px(s.fontSize, inheritFontSize);
  const fontWeight = s.fontWeight || inheritFontWeight;
  const bg = resolveColor(s.backgroundColor, "");

  // Box model
  const mt = px(s.marginTop);
  const mr = px(s.marginRight);
  const mb = px(s.marginBottom);
  const ml = px(s.marginLeft);
  const pt = px(s.paddingTop);
  const pr = px(s.paddingRight);
  const pb = px(s.paddingBottom);
  const pleft = px(s.paddingLeft);
  const bt = px(s.borderTopWidth);
  const brw = px(s.borderRightWidth);
  const bbw = px(s.borderBottomWidth);
  const blw = px(s.borderLeftWidth);
  const bc = s.borderTopColor || s.borderColor || "";

  // Width
  const outerW = pxOrPct(s.width, cw, cw - ml - mr);
  const innerW = Math.max(0, outerW - pleft - pr - blw - brw);

  // Display mode
  const display = s.display || "block";
  const flexDir = s.flexDirection || "column";
  const tag = node.type;

  // Determine layout mode
  let childBoxes: Box[] = [];
  let contentH = 0;

  const isTable = tag === "table" || tag === "thead" || tag === "tbody" || tag === "tfoot";
  const isRow = tag === "tr" || (display === "flex" && flexDir === "row");

  if (isRow) {
    contentH = doFlexRow(kids, innerW, color, fontSize, fontWeight, childBoxes);
  } else if (isTable) {
    contentH = doBlock(kids, innerW, color, fontSize, fontWeight, childBoxes);
  } else if (kids.every(k => isInline(k as SNode))) {
    // All inline children — flow as text
    contentH = doInlineFlow(kids, innerW, color, fontSize, fontWeight, s.textDecoration, childBoxes);
  } else {
    // Mixed or block children
    contentH = doBlock(kids, innerW, color, fontSize, fontWeight, childBoxes);
  }

  // Explicit height
  const specH = pxOrPct(s.height, 0, 0);
  const h = specH > 0 ? specH : contentH + pt + pb + bt + bbw;

  // Offset children by padding/border
  for (const cb of childBoxes) {
    cb.x += pleft + blw;
    cb.y += pt + bt;
  }

  return {
    x: ml,
    y: mt,
    w: outerW,
    h: h + mt + mb,
    bg: bg || undefined,
    color,
    fontSize,
    fontWeight,
    bt: bt > 0 ? bt : undefined,
    br: brw > 0 ? brw : undefined,
    bb: bbw > 0 ? bbw : undefined,
    bleft: blw > 0 ? blw : undefined,
    bc: bc || undefined,
    radius: px(s.borderRadius || s.borderTopLeftRadius),
    opacity: s.opacity ? parseFloat(s.opacity) : undefined,
    textDec: s.textDecoration,
    clip: s.overflow === "hidden",
    kids: childBoxes,
  };
}

function wrapText(
  text: string,
  maxW: number,
  fontSize: number,
  fontWeight: string,
  color: string,
): Box {
  const words = text.split(" ");
  const spaceW = fontSize * CHAR_W;
  const lh = fontSize * 1.35;
  const lines: string[] = [];
  let cur = "";

  for (const word of words) {
    const test = cur ? cur + " " + word : word;
    if (measureText(test, fontSize) > maxW && cur) {
      lines.push(cur);
      cur = word;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);

  return {
    x: 0, y: 0,
    w: maxW,
    h: lines.length * lh,
    color, fontSize, fontWeight,
    lines,
    kids: [],
  };
}

function doBlock(
  children: (SNode | string)[],
  cw: number,
  color: string,
  fontSize: number,
  fontWeight: string,
  out: Box[],
): number {
  let y = 0;
  for (const child of children) {
    if (!child) continue;
    const box = layout(child as SNode, cw, color, fontSize, fontWeight);
    if (box.h === 0 && box.kids.length === 0 && !box.lines?.length) continue;
    box.y += y;
    y += box.h;
    out.push(box);
  }
  return y;
}

function doInlineFlow(
  children: (SNode | string)[],
  cw: number,
  parentColor: string,
  parentFontSize: number,
  parentFontWeight: string,
  textDec: string | undefined,
  out: Box[],
): number {
  // Collect all text from inline children, preserving per-child styling
  // For simplicity: concatenate into styled runs, then wrap into lines
  interface TextRun {
    text: string;
    color: string;
    fontSize: number;
    fontWeight: string;
    textDec?: string;
  }

  const runs: TextRun[] = [];

  function collectRuns(node: SNode | string, color: string, fs: number, fw: string, td?: string) {
    if (typeof node === "string") {
      const t = node.replace(/\s+/g, " ");
      if (t.trim()) runs.push({ text: t, color, fontSize: fs, fontWeight: fw, textDec: td });
      return;
    }
    const s = node.props.style;
    const c = resolveColor(s.color, color);
    const f = px(s.fontSize, fs);
    const w = s.fontWeight || fw;
    const d = s.textDecoration || td;
    for (const kid of getKids(node)) {
      collectRuns(kid as SNode, c, f, w, d);
    }
  }

  for (const child of children) {
    if (!child) continue;
    collectRuns(child as SNode, parentColor, parentFontSize, parentFontWeight, textDec);
  }

  // Now we have styled text runs. Concatenate into one string and wrap.
  // For now, render as a single-style text block (most common case).
  // Use the parent's style as the dominant style.
  const fullText = runs.map(r => r.text.trim()).join(" ").replace(/\s+/g, " ").trim();
  if (!fullText) return 0;

  // If all runs have same style, render as one text block
  const primaryColor = runs[0]?.color || parentColor;
  const primaryFs = runs[0]?.fontSize || parentFontSize;
  const primaryFw = runs[0]?.fontWeight || parentFontWeight;
  const primaryTd = runs[0]?.textDec;

  const box = wrapText(fullText, cw, primaryFs, primaryFw, primaryColor);
  box.textDec = primaryTd;
  out.push(box);
  return box.h;
}

function doFlexRow(
  children: (SNode | string)[],
  cw: number,
  color: string,
  fontSize: number,
  fontWeight: string,
  out: Box[],
): number {
  // Calculate flex shares
  interface FlexItem { child: SNode | string; flex: number; fixedW?: number; }
  const items: FlexItem[] = [];
  let totalFlex = 0;
  let fixedTotal = 0;

  for (const child of children) {
    if (!child) continue;
    if (typeof child === "string") {
      const w = measureText(child.trim(), fontSize);
      items.push({ child, flex: 0, fixedW: Math.min(w + 10, cw) });
      fixedTotal += Math.min(w + 10, cw);
      continue;
    }
    const cs = child.props.style;
    const f = parseFloat(cs.flex || cs.flexGrow || "0");
    const w = cs.width;
    if (w && w !== "auto") {
      const pw = pxOrPct(w, cw);
      items.push({ child, flex: 0, fixedW: pw });
      fixedTotal += pw;
    } else if (f > 0) {
      items.push({ child, flex: f });
      totalFlex += f;
    } else {
      // No flex specified — estimate based on content
      const text = allText(child);
      if (text.length <= 5) {
        const est = Math.max(measureText(text, fontSize) + 10, 30);
        items.push({ child, flex: 0, fixedW: est });
        fixedTotal += est;
      } else {
        items.push({ child, flex: 1 });
        totalFlex += 1;
      }
    }
  }

  const remaining = Math.max(0, cw - fixedTotal);
  let x = 0;
  let maxH = 0;

  for (const item of items) {
    const itemW = item.fixedW ?? (totalFlex > 0 ? (item.flex / totalFlex) * remaining : 0);
    if (itemW <= 0) continue;

    const box = layout(item.child as SNode, itemW, color, fontSize, fontWeight);
    box.x += x;
    x += itemW;
    maxH = Math.max(maxH, box.h);
    out.push(box);
  }

  return maxH;
}

// --- SVG Painter ---

let clipId = 0;

function paint(box: Box, ox = 0, oy = 0): string {
  let svg = "";
  const x = box.x + ox;
  const y = box.y + oy;

  // Background
  if (box.bg) {
    const r = box.radius || 0;
    svg += `<rect x="${x}" y="${y}" width="${Math.max(0, box.w)}" height="${Math.max(0, box.h)}" fill="${escXml(box.bg)}"`;
    if (r > 0) svg += ` rx="${r}" ry="${r}"`;
    if (box.opacity !== undefined && box.opacity < 1) svg += ` opacity="${box.opacity}"`;
    svg += `/>\n`;
  }

  // Borders
  if (box.bc) {
    if (box.bt) svg += `<line x1="${x}" y1="${y + box.bt / 2}" x2="${x + box.w}" y2="${y + box.bt / 2}" stroke="${escXml(box.bc)}" stroke-width="${box.bt}"/>\n`;
    if (box.bb) svg += `<line x1="${x}" y1="${y + box.h - box.bb / 2}" x2="${x + box.w}" y2="${y + box.h - box.bb / 2}" stroke="${escXml(box.bc)}" stroke-width="${box.bb}"/>\n`;
    if (box.bleft) svg += `<line x1="${x + box.bleft / 2}" y1="${y}" x2="${x + box.bleft / 2}" y2="${y + box.h}" stroke="${escXml(box.bc)}" stroke-width="${box.bleft}"/>\n`;
    if (box.br) svg += `<line x1="${x + box.w - box.br / 2}" y1="${y}" x2="${x + box.w - box.br / 2}" y2="${y + box.h}" stroke="${escXml(box.bc)}" stroke-width="${box.br}"/>\n`;
  }

  // Text lines
  if (box.lines && box.lines.length > 0) {
    const lh = box.fontSize * 1.35;
    for (let i = 0; i < box.lines.length; i++) {
      const line = box.lines[i];
      const ty = y + (i + 1) * lh - box.fontSize * 0.25; // baseline
      svg += `<text x="${x}" y="${ty}" font-size="${box.fontSize}" font-weight="${box.fontWeight}" fill="${escXml(box.color)}" font-family="Arial, Helvetica, sans-serif"`;
      if (box.textDec === "underline") svg += ` text-decoration="underline"`;
      svg += `>${escXml(line)}</text>\n`;
    }
  }

  // Clipping for overflow:hidden
  if (box.clip) {
    const cid = `clip${++clipId}`;
    svg += `<clipPath id="${cid}"><rect x="${x}" y="${y}" width="${box.w}" height="${box.h}"/></clipPath><g clip-path="url(#${cid})">\n`;
  }

  // Children
  for (const kid of box.kids) {
    svg += paint(kid, x, y);
  }

  if (box.clip) svg += `</g>\n`;

  return svg;
}

// --- Public API ---

export async function renderWithLayout(
  tree: unknown,
  options: { width?: number; height?: number } = {},
): Promise<Buffer> {
  const width = options.width ?? 1280;
  const height = options.height ?? 720;

  if (!tree || typeof tree !== "object") {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#fff"/></svg>`;
    const resvg = new Resvg(svg, { fitTo: { mode: "width", value: width } });
    return Buffer.from(resvg.render().asPng());
  }

  const root = tree as SNode;
  const rootStyle = root.props?.style || {};
  const bg = resolveColor(rootStyle.backgroundColor, "") || "#ffffff";
  const rootColor = resolveColor(rootStyle.color, "") || "#000000";
  const rootFontSize = px(rootStyle.fontSize, 16);
  const rootFontWeight = rootStyle.fontWeight || "400";

  clipId = 0;
  const rootBox = layout(root, width, rootColor, rootFontSize, rootFontWeight);

  // Cap at viewport height — like a real browser, you see the viewport and scroll for more
  const svgHeight = height;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${svgHeight}">\n`;
  svg += `<rect width="${width}" height="${svgHeight}" fill="${escXml(bg)}"/>\n`;
  svg += paint(rootBox);
  svg += `</svg>`;

  try {
    const resvg = new Resvg(svg, { fitTo: { mode: "width", value: width } });
    return Buffer.from(resvg.render().asPng());
  } catch (err) {
    // Fallback on resvg crash
    const text = allText(root).slice(0, 500);
    const fbSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect width="${width}" height="${height}" fill="${escXml(bg)}"/>
      <text x="10" y="24" font-size="14" fill="${escXml(rootColor)}" font-family="Arial">${escXml(text)}</text>
    </svg>`;
    const resvg = new Resvg(fbSvg, { fitTo: { mode: "width", value: width } });
    return Buffer.from(resvg.render().asPng());
  }
}
